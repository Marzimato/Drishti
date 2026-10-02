import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MAX_AGREEMENT_DELTA_E,
  DEFAULT_MIN_CALIBRATION_FRAMES,
  buildSelfCalibration,
  type CalibrationFrame,
} from './selfCalibrate';
import { PATCHES, hasPerPatchReferences, isFullyMeasured, nominalLabFor } from './spec';
import { deltaE2000 } from '../color/deltaE';
import { labToSrgb, srgbToLinear } from '../color/space';

/**
 * Builds a frame whose patch readings are the nominal colours, nudged by a
 * per-frame offset so successive frames differ slightly — standing in for the
 * frame-to-frame noise of a real handheld capture.
 */
function frameFromNominal(luminanceJitter = 0): CalibrationFrame {
  return {
    readings: PATCHES.map((patch) => {
      const srgb = labToSrgb(nominalLabFor(patch));
      const jittered = {
        r: Math.min(1, Math.max(0, srgb.r + luminanceJitter)),
        g: Math.min(1, Math.max(0, srgb.g + luminanceJitter)),
        b: Math.min(1, Math.max(0, srgb.b + luminanceJitter)),
      };
      return { patchId: patch.id, linear: srgbToLinear(jittered) };
    }),
  };
}

describe('buildSelfCalibration', () => {
  it('refuses fewer than the minimum number of frames', () => {
    const result = buildSelfCalibration([frameFromNominal(), frameFromNominal()]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('too-few-frames');
  });

  it('produces a self-measured calibration from consistent frames', () => {
    const frames = Array.from({ length: 4 }, (_, i) => frameFromNominal(i * 0.002));
    const result = buildSelfCalibration(frames);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.calibration.provenance).toBe('self-measured');
    expect(result.calibration.frameCount).toBe(4);
    expect(result.calibration.patches).toHaveLength(PATCHES.length);
    // Every patch got a reference and an agreement figure.
    for (const patch of result.calibration.patches ?? []) {
      expect(patch.agreementDeltaE).toBeDefined();
      expect(patch.agreementDeltaE!).toBeLessThan(DEFAULT_MAX_AGREEMENT_DELTA_E);
    }
  });

  it('earns per-patch-reference status but is NOT instrument-measured', () => {
    const frames = Array.from({ length: 3 }, () => frameFromNominal());
    const result = buildSelfCalibration(frames);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Self-measured keeps the strict thresholds (describes the physical card)...
    expect(hasPerPatchReferences(result.calibration)).toBe(true);
    // ...but must never be reported as instrument-measured.
    expect(isFullyMeasured(result.calibration)).toBe(false);
  });

  it('recovers the input colour: averaged references match the frames they came from', () => {
    const frames = Array.from({ length: 5 }, () => frameFromNominal());
    const result = buildSelfCalibration(frames);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // With identical frames the averaged Lab should equal the nominal Lab.
    for (const patch of PATCHES) {
      const measured = result.calibration.patches?.find((p) => p.patchId === patch.id);
      expect(measured).toBeDefined();
      expect(deltaE2000(measured!.lab, nominalLabFor(patch))).toBeLessThan(0.5);
    }
  });

  it('is robust to a single bad frame, because it medians rather than means', () => {
    const good = Array.from({ length: 4 }, () => frameFromNominal());
    // One frame with a large offset on every patch — a glare or a stray shadow.
    const bad = frameFromNominal(0.25);
    const result = buildSelfCalibration([...good, bad]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // The median ignores the outlier, so references still track the good frames.
    for (const patch of PATCHES) {
      const measured = result.calibration.patches?.find((p) => p.patchId === patch.id);
      expect(deltaE2000(measured!.lab, nominalLabFor(patch))).toBeLessThan(3);
    }
  });

  it('refuses when frames disagree too much to average', () => {
    // Three frames each wildly different: no consistent reference exists.
    const frames = [frameFromNominal(0), frameFromNominal(0.2), frameFromNominal(0.4)];
    const result = buildSelfCalibration(frames);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('frames-disagree');
    // The failure still reports what it measured, so the operator can see how far off it was.
    expect(result.report?.worstAgreementDeltaE).toBeGreaterThan(DEFAULT_MAX_AGREEMENT_DELTA_E);
  });

  it('refuses when a patch is missing from a frame', () => {
    const complete = frameFromNominal();
    const partial: CalibrationFrame = {
      readings: complete.readings.slice(0, PATCHES.length - 1),
    };
    const result = buildSelfCalibration([complete, complete, partial]);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('incomplete-patch-coverage');
  });

  it('exposes a sane default minimum frame count', () => {
    expect(DEFAULT_MIN_CALIBRATION_FRAMES).toBeGreaterThanOrEqual(3);
  });
});
