import { beforeAll, describe, expect, it } from 'vitest';
import { buildRecordCore, commitCapture, type CaptureArtefacts, type CaptureContext } from './captureService';
import { analyseCapture } from '../core/pipeline/analyse';
import { findPanel } from '../core/classify/panels';
import { InMemoryPersistence, RecordLog } from '../data/recordLog';
import { generateExtractableKeyPair, publicKeyFingerprint, sha256Hex } from '../core/record/crypto';
import { verifyRecord } from '../core/record/record';
import { NOMINAL_CALIBRATION } from '../core/card/spec';
import { renderSyntheticCard } from '../core/vision/__fixtures__/syntheticCard';

const panel = findPanel('marquis')!;
let context: CaptureContext;

const imageBytes = new Uint8Array([255, 216, 255, 224, 1, 2, 3, 4, 5, 6]);

const artefacts: CaptureArtefacts = {
  imageBytes,
  imageMimeType: 'image/jpeg',
  imageWidth: 1400,
  imageHeight: 950,
};

beforeAll(async () => {
  const keys = await generateExtractableKeyPair();
  context = {
    operator: { id: 'OFFICER-4417', displayName: 'A. Sharma', agency: 'State Police' },
    device: { id: 'device-1', platform: 'Android 14' },
    deviceKeys: keys,
    publicKeyFingerprint: await publicKeyFingerprint(keys.publicKey),
    calibration: { ...NOMINAL_CALIBRATION, cardSerial: 'CL-0001' },
    location: {
      latitude: 12.9716,
      longitude: 77.5946,
      accuracyMetres: 8,
      altitudeMetres: 900,
      fixedAt: '2026-09-11T10:14:00.000Z',
    },
    caseReference: 'FIR-884/2026',
    kitLotNumber: 'LOT-2291',
    capturedAt: '2026-09-11T10:15:00.000Z',
  };
});

/**
 * Neutral light with headroom, standing in for a camera's auto-exposure.
 *
 * A gain of exactly 1.0 drives the white reference patch to the sensor rail, which
 * the overexposure gate correctly refuses. Real cameras expose below the rail, so
 * the scenarios here do too.
 */
const NEUTRAL_LIGHT = { gain: { r: 0.95, g: 0.95, b: 0.95 } };

function analyseSample(sampleHex: string) {
  const rendered = renderSyntheticCard({
    width: 1400,
    height: 950,
    illumination: NEUTRAL_LIGHT,
    sampleHex,
  });
  return analyseCapture(rendered.image, { panel });
}

describe('buildRecordCore', () => {
  it('captures the result, context and image digest', async () => {
    const analysis = analyseSample('#5a2a6e');
    const core = await buildRecordCore(analysis, context, artefacts, {
      index: 0,
      previousRecordHash: '0'.repeat(64),
    });

    expect(core.result.category).toBe('positive');
    expect(core.result.outcomeId).toBe('marquis-purple');
    expect(core.operator.id).toBe('OFFICER-4417');
    expect(core.caseReference).toBe('FIR-884/2026');
    expect(core.kitLotNumber).toBe('LOT-2291');
    expect(core.cardSerial).toBe('CL-0001');
    expect(core.calibrationProvenance).toBe('nominal');
    expect(core.image.sha256).toBe(await sha256Hex(imageBytes));
    expect(core.captureAccepted).toBe(true);
  });

  it('always demands laboratory confirmation', async () => {
    const analysis = analyseSample('#5a2a6e');
    const core = await buildRecordCore(analysis, context, artefacts, {
      index: 0,
      previousRecordHash: '0'.repeat(64),
    });
    expect(core.result.requiresLaboratoryConfirmation).toBe(true);
  });

  it('rounds measurements so canonical bytes stay stable', async () => {
    const analysis = analyseSample('#5a2a6e');
    const core = await buildRecordCore(analysis, context, artefacts, {
      index: 0,
      previousRecordHash: '0'.repeat(64),
    });

    const decimals = (value: number) => (value.toString().split('.')[1] ?? '').length;
    expect(decimals(core.measurement.sampleLab!.L)).toBeLessThanOrEqual(4);
    expect(decimals(core.result.matchDeltaE!)).toBeLessThanOrEqual(4);
  });

  it('replaces a non-finite separation with null rather than corrupting the record', async () => {
    // A single-outcome panel yields an infinite separation. JSON cannot represent
    // that, and canonicalisation refuses it, so it must become null.
    const singleOutcome = {
      ...panel,
      outcomes: [panel.outcomes[0]],
    };
    const rendered = renderSyntheticCard({
      width: 1400,
      height: 950,
      illumination: NEUTRAL_LIGHT,
      sampleHex: '#efe7c8',
    });
    const analysis = analyseCapture(rendered.image, { panel: singleOutcome });

    const core = await buildRecordCore(analysis, context, artefacts, {
      index: 0,
      previousRecordHash: '0'.repeat(64),
    });

    expect(analysis.classification.separationDeltaE).toBe(Number.POSITIVE_INFINITY);
    expect(core.result.separationDeltaE).toBeNull();
  });

  it('records a refused capture with its reason and null measurements', async () => {
    const rendered = renderSyntheticCard({
      width: 1400,
      height: 950,
      illumination: NEUTRAL_LIGHT,
      blurRadius: 5,
    });
    const analysis = analyseCapture(rendered.image, { panel });
    expect(analysis.ok).toBe(false);

    const core = await buildRecordCore(analysis, context, artefacts, {
      index: 0,
      previousRecordHash: '0'.repeat(64),
    });

    expect(core.captureAccepted).toBe(false);
    expect(core.rejectionReason).toBeTruthy();
    expect(core.result.category).toBe('inconclusive');
    expect(core.qualityIssues.some((issue) => issue.code === 'out-of-focus')).toBe(true);
  });

  it('states why location is absent when it is', async () => {
    const analysis = analyseSample('#5a2a6e');
    const core = await buildRecordCore(
      analysis,
      { ...context, location: null, locationUnavailableReason: 'Permission denied' },
      artefacts,
      { index: 0, previousRecordHash: '0'.repeat(64) },
    );
    expect(core.location).toBeNull();
    expect(core.locationUnavailableReason).toBe('Permission denied');
  });

  it('omits the unavailable reason when a location is present', async () => {
    const analysis = analyseSample('#5a2a6e');
    const core = await buildRecordCore(
      analysis,
      { ...context, locationUnavailableReason: 'should be ignored' },
      artefacts,
      { index: 0, previousRecordHash: '0'.repeat(64) },
    );
    expect(core.locationUnavailableReason).toBeUndefined();
  });
});

describe('commitCapture', () => {
  it('signs, stores and verifies a capture', async () => {
    const log = new RecordLog(new InMemoryPersistence());
    const analysis = analyseSample('#5a2a6e');

    const { entry, signed } = await commitCapture(log, analysis, context, artefacts);

    expect(entry.chainIndex).toBe(0);
    expect(entry.category).toBe('positive');
    expect((await verifyRecord(signed, { imageBytes })).valid).toBe(true);
    expect((await log.verifyAll()).valid).toBe(true);
  });

  it('chains successive captures', async () => {
    const log = new RecordLog(new InMemoryPersistence());

    await commitCapture(log, analyseSample('#5a2a6e'), context, artefacts);
    await commitCapture(log, analyseSample('#efe7c8'), context, artefacts);
    await commitCapture(log, analyseSample('#b06a24'), context, artefacts);

    const all = await log.all();
    expect(all.map((entry) => entry.chainIndex)).toEqual([0, 1, 2]);
    expect(all.map((entry) => entry.category)).toEqual(['positive', 'negative', 'positive']);
    expect((await log.verifyAll()).valid).toBe(true);
  });

  it('detects tampering with a stored record', async () => {
    const log = new RecordLog(new InMemoryPersistence());
    const { entry } = await commitCapture(log, analyseSample('#5a2a6e'), context, artefacts);

    // Simulate an attacker editing the stored verdict.
    const stored = await log.get(entry.recordId);
    stored!.record.result.category = 'negative';

    const verification = await log.verifyOne(entry.recordId);
    expect(verification?.valid).toBe(false);
    expect(verification?.failures).toContain('bad-signature');
  });

  it('stores refused captures in the chain too', async () => {
    const log = new RecordLog(new InMemoryPersistence());
    const rendered = renderSyntheticCard({
      width: 1400,
      height: 950,
      illumination: NEUTRAL_LIGHT,
      blurRadius: 5,
    });
    const analysis = analyseCapture(rendered.image, { panel });

    const { entry } = await commitCapture(log, analysis, context, artefacts);

    expect(entry.captureAccepted).toBe(false);
    expect(await log.count()).toBe(1);
    expect((await log.verifyAll()).valid).toBe(true);
    // Not shown in the default log view, but present and verifiable.
    expect(await log.search()).toHaveLength(0);
    expect(await log.search({ includeRejected: true })).toHaveLength(1);
  });

  it('gives each record a distinct identifier', async () => {
    const log = new RecordLog(new InMemoryPersistence());
    await commitCapture(log, analyseSample('#5a2a6e'), context, artefacts);
    await commitCapture(log, analyseSample('#5a2a6e'), context, artefacts);
    const all = await log.all();
    expect(all[0].recordId).not.toBe(all[1].recordId);
  });
});
