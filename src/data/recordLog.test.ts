import { beforeEach, describe, expect, it } from 'vitest';
import { InMemoryPersistence, RecordLog, type ChainPosition } from './recordLog';
import {
  GENESIS_HASH,
  RECORD_SCHEMA_VERSION,
  signRecord,
  type SignedTestRecord,
  type TestRecordCore,
} from '../core/record/record';
import {
  generateExtractableKeyPair,
  publicKeyFingerprint,
  sha256Hex,
  type DeviceKeyPair,
} from '../core/record/crypto';

let keys: DeviceKeyPair;
let fingerprint: string;

beforeEach(async () => {
  if (!keys) {
    keys = await generateExtractableKeyPair();
    fingerprint = await publicKeyFingerprint(keys.publicKey);
  }
});

interface BuildOptions {
  recordId?: string;
  capturedAt?: string;
  operatorId?: string;
  category?: 'positive' | 'negative' | 'inconclusive';
  panelId?: string;
  caseReference?: string;
  captureAccepted?: boolean;
  notes?: string;
}

async function buildCore(
  position: ChainPosition,
  options: BuildOptions = {},
): Promise<TestRecordCore> {
  const imageBytes = new Uint8Array([1, 2, 3, position.index]);
  return {
    schemaVersion: RECORD_SCHEMA_VERSION,
    recordId: options.recordId ?? `record-${position.index}`,
    capturedAt: options.capturedAt ?? new Date(Date.UTC(2026, 8, 11, 9, position.index)).toISOString(),
    utcOffsetMinutes: 330,
    operator: { id: options.operatorId ?? 'OFFICER-1', displayName: 'A. Sharma' },
    device: { id: 'device-1', publicKeyFingerprint: fingerprint },
    location: {
      latitude: 12.97,
      longitude: 77.59,
      accuracyMetres: 7,
      altitudeMetres: null,
      fixedAt: '2026-09-11T09:00:00.000Z',
    },
    panelId: options.panelId ?? 'marquis',
    panelName: 'Marquis',
    caseReference: options.caseReference,
    operatorNotes: options.notes,
    // An obsolete card revision on purpose — see the note in record.test.ts. The log
    // must handle records from card versions that are no longer in service.
    cardSpecVersion: 'chromalog-card-1',
    calibrationProvenance: 'nominal',
    captureAccepted: options.captureAccepted ?? true,
    result: {
      category: options.category ?? 'positive',
      outcomeId: 'marquis-purple',
      label: 'Purple to violet, consistent with opiates',
      confidence: 'moderate',
      matchDeltaE: 1.5,
      separationDeltaE: 14,
      referenceProvenance: 'placeholder',
      referenceNeedsVerification: true,
      requiresLaboratoryConfirmation: true,
    },
    measurement: {
      sampleLab: { L: 27, a: 30, b: -27 },
      correctionModel: 'affine3x4',
      correctionMeanDeltaE: 0.2,
      correctionMaxDeltaE: 0.8,
      focusScore: 220,
      cardCoverage: 0.42,
      illuminationGradientStrength: null,
      colourCastRatio: 1,
    },
    qualityIssues: [],
    image: {
      sha256: await sha256Hex(imageBytes),
      byteLength: imageBytes.length,
      mimeType: 'image/jpeg',
      width: 1400,
      height: 950,
    },
    chain: { index: position.index, previousRecordHash: position.previousRecordHash },
  };
}

async function appendOne(log: RecordLog, options: BuildOptions = {}) {
  return log.append(async (position) => {
    const core = await buildCore(position, options);
    const signed = await signRecord({
      core,
      privateKey: keys.privateKey,
      publicKey: keys.publicKey,
    });
    return { core, signed };
  });
}

function makeLog(): RecordLog {
  return new RecordLog(new InMemoryPersistence());
}

describe('chain position', () => {
  it('starts at index zero pointing at the genesis hash', async () => {
    const log = makeLog();
    const position = await log.nextChainPosition();
    expect(position.index).toBe(0);
    expect(position.previousRecordHash).toBe(GENESIS_HASH);
  });

  it('advances after each append', async () => {
    const log = makeLog();
    await appendOne(log);
    const position = await log.nextChainPosition();
    expect(position.index).toBe(1);
    expect(position.previousRecordHash).not.toBe(GENESIS_HASH);
  });
});

describe('append', () => {
  it('stores a verifiable record', async () => {
    const log = makeLog();
    const entry = await appendOne(log, { caseReference: 'FIR-1/2026' });

    expect(entry.chainIndex).toBe(0);
    expect(entry.syncState).toBe('pending');
    expect(entry.caseReference).toBe('FIR-1/2026');

    const verification = await log.verifyOne(entry.recordId);
    expect(verification?.valid).toBe(true);
  });

  it('builds a chain that verifies end to end', async () => {
    const log = makeLog();
    for (let i = 0; i < 5; i++) await appendOne(log);

    const result = await log.verifyAll();
    expect(result.valid).toBe(true);
    expect(await log.count()).toBe(5);
  });

  it('rejects a record that does not commit to the assigned position', async () => {
    // Guards against a caller building the core with a stale chain position.
    const log = makeLog();
    await appendOne(log);

    await expect(
      log.append(async () => {
        const core = await buildCore({ index: 0, previousRecordHash: GENESIS_HASH });
        const signed = await signRecord({
          core,
          privateKey: keys.privateKey,
          publicKey: keys.publicKey,
        });
        return { core, signed };
      }),
    ).rejects.toThrow(/chain index/i);
  });

  it('serialises concurrent appends so the chain never forks', async () => {
    // The important concurrency property. Without the append queue, these would
    // all read the same chain head and claim the same index.
    const log = makeLog();
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => appendOne(log, { recordId: `concurrent-${i}` })),
    );

    const indices = results.map((entry) => entry.chainIndex).sort((a, b) => a - b);
    expect(indices).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);

    const verification = await log.verifyAll();
    expect(verification.valid).toBe(true);
  });

  it('keeps accepting appends after one fails', async () => {
    const log = makeLog();
    await appendOne(log);

    await expect(
      log.append(async () => {
        throw new Error('signing failed');
      }),
    ).rejects.toThrow(/signing failed/);

    // The queue must not be left permanently rejected.
    const entry = await appendOne(log, { recordId: 'after-failure' });
    expect(entry.chainIndex).toBe(1);
    expect((await log.verifyAll()).valid).toBe(true);
  });

  it('records a rejected capture as a first-class log entry', async () => {
    const log = makeLog();
    await appendOne(log, { recordId: 'rejected', captureAccepted: false, category: 'inconclusive' });

    // Hidden from the default view, but present in the chain and findable.
    expect(await log.search()).toHaveLength(0);
    expect(await log.search({ includeRejected: true })).toHaveLength(1);
    expect(await log.count()).toBe(1);
  });
});

describe('search', () => {
  let log: RecordLog;

  beforeEach(async () => {
    log = makeLog();
    await appendOne(log, {
      recordId: 'a',
      category: 'positive',
      caseReference: 'FIR-100/2026',
      operatorId: 'OFFICER-1',
      capturedAt: '2026-09-01T10:00:00.000Z',
      panelId: 'marquis',
    });
    await appendOne(log, {
      recordId: 'b',
      category: 'negative',
      caseReference: 'FIR-200/2026',
      operatorId: 'OFFICER-2',
      capturedAt: '2026-09-05T10:00:00.000Z',
      panelId: 'marquis',
      notes: 'roadside stop near depot',
    });
    await appendOne(log, {
      recordId: 'c',
      category: 'inconclusive',
      caseReference: 'FIR-300/2026',
      operatorId: 'OFFICER-1',
      capturedAt: '2026-09-10T10:00:00.000Z',
      panelId: 'cobalt-thiocyanate',
    });
  });

  it('returns most recent first', async () => {
    const results = await log.search();
    expect(results.map((entry) => entry.recordId)).toEqual(['c', 'b', 'a']);
  });

  it('filters by category', async () => {
    const results = await log.search({ category: 'negative' });
    expect(results.map((entry) => entry.recordId)).toEqual(['b']);
  });

  it('filters by panel', async () => {
    const results = await log.search({ panelId: 'cobalt-thiocyanate' });
    expect(results.map((entry) => entry.recordId)).toEqual(['c']);
  });

  it('filters by operator', async () => {
    const results = await log.search({ operatorId: 'OFFICER-1' });
    expect(results.map((entry) => entry.recordId)).toEqual(['c', 'a']);
  });

  it('filters by date range inclusively', async () => {
    const results = await log.search({
      from: '2026-09-05T00:00:00.000Z',
      to: '2026-09-05T23:59:59.999Z',
    });
    expect(results.map((entry) => entry.recordId)).toEqual(['b']);
  });

  it('searches free text across case reference, operator and notes', async () => {
    expect((await log.search({ text: 'FIR-200' })).map((e) => e.recordId)).toEqual(['b']);
    expect((await log.search({ text: 'depot' })).map((e) => e.recordId)).toEqual(['b']);
    expect((await log.search({ text: 'OFFICER-2' })).map((e) => e.recordId)).toEqual(['b']);
  });

  it('is case insensitive', async () => {
    expect((await log.search({ text: 'fir-200' })).map((e) => e.recordId)).toEqual(['b']);
  });

  it('combines filters', async () => {
    const results = await log.search({ operatorId: 'OFFICER-1', category: 'positive' });
    expect(results.map((entry) => entry.recordId)).toEqual(['a']);
  });

  it('returns nothing for a non-matching search', async () => {
    expect(await log.search({ text: 'no-such-thing' })).toHaveLength(0);
  });
});

describe('sync state', () => {
  it('starts pending and can be marked synced', async () => {
    const log = makeLog();
    const entry = await appendOne(log);
    expect(await log.pendingSync()).toHaveLength(1);

    await log.markSynced(entry.recordId);
    expect(await log.pendingSync()).toHaveLength(0);
    expect((await log.get(entry.recordId))?.syncState).toBe('synced');
  });

  it('can be marked failed and remains findable', async () => {
    const log = makeLog();
    const entry = await appendOne(log);
    await log.markSyncFailed(entry.recordId);
    expect((await log.search({ syncState: 'failed' })).map((e) => e.recordId)).toEqual([
      entry.recordId,
    ]);
  });

  it('never alters the signed record when sync state changes', async () => {
    const log = makeLog();
    const entry = await appendOne(log);
    const before = JSON.stringify(entry.record);

    await log.markSynced(entry.recordId);
    const after = await log.get(entry.recordId);

    expect(JSON.stringify(after?.record)).toBe(before);
    expect((await log.verifyOne(entry.recordId))?.valid).toBe(true);
  });
});

describe('export', () => {
  it('exports signed records as JSON with a verification note', async () => {
    const log = makeLog();
    await appendOne(log);
    await appendOne(log);

    const json = JSON.parse(await log.exportJson()) as {
      recordCount: number;
      note: string;
      records: SignedTestRecord[];
    };

    expect(json.recordCount).toBe(2);
    expect(json.records).toHaveLength(2);
    expect(json.records[0].signature.value).toBeTruthy();
    expect(json.note).toMatch(/laboratory/i);
  });

  it('exports a CSV summary with one row per record', async () => {
    const log = makeLog();
    await appendOne(log, { caseReference: 'FIR-1/2026' });
    await appendOne(log, { caseReference: 'FIR-2/2026' });

    const lines = (await log.exportCsv()).trim().split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('chain_index');
    expect(lines[1]).toContain('FIR-1/2026');
    expect(lines[1]).toContain('yes');
  });

  it('quotes CSV fields containing commas', async () => {
    const log = makeLog();
    await appendOne(log, { caseReference: 'FIR-1, annexe 4' });
    const csv = await log.exportCsv();
    expect(csv).toContain('"FIR-1, annexe 4"');
  });
});
