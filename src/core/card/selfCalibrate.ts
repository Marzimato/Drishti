/**
 * Self-measured calibration: deriving a card's reference Lab values from the
 * device camera instead of a colour instrument.
 *
 * WHY THIS EXISTS: a nominal card assumes the printer hit its sRGB targets, which
 * it never does — on a real DRISHTI print the worst patch sat ~28 ΔE from nominal.
 * The honest fix is to measure the printed card. With no spectrophotometer, the
 * best available instrument is the same camera that will read the tests, and the
 * way to make a single noisy camera trustworthy is to capture the card several
 * times under even light and average.
 *
 * WHY AVERAGING ACROSS FRAMES IS THE RIGHT MOVE, not a single good photo: paper
 * speckle, halftone texture and sensor noise are per-pixel random, and a shadow or
 * glare lands in a different place each time the card is moved. Averaging several
 * frames cancels all of those, where a single frame cannot — which is exactly why
 * a single frame's within-patch variance (the uneven-patch-illumination gate)
 * should NOT veto calibration. What matters for calibration is whether the frames
 * AGREE, not whether any one frame is pristine.
 *
 * WHAT IT IS NOT: it is not instrument-grade. The result inherits the camera's own
 * colour rendering and the illuminant it was shot under. That is why its provenance
 * is 'self-measured', distinct from 'measured', and carried verbatim into every
 * record so a reviewer always knows which they are looking at.
 *
 * Pure and deterministic: no camera, no DOM, no React, so it is unit tested
 * directly against synthetic per-frame readings.
 */

import { deltaE2000 } from '../color/deltaE';
import { linearRgbToLab, type Lab, type LinearRgb } from '../color/space';
import {
  CARD_SPEC_VERSION,
  PATCHES,
  type CalibrationProvenance,
  type CardCalibration,
  type MeasuredPatch,
} from './spec';

/** One frame's reading of one patch, in linear RGB (the raw sampled mean). */
export interface PatchFrameReading {
  patchId: string;
  linear: LinearRgb;
}

/** All patch readings from a single capture frame. */
export interface CalibrationFrame {
  readings: readonly PatchFrameReading[];
}

export interface SelfCalibrationOptions {
  cardSerial?: string;
  /** Minimum frames required. Fewer than this and averaging is not worthwhile. */
  minFrames?: number;
  /**
   * Reject calibration if any patch's cross-frame agreement is worse than this
   * (mean ΔE of each frame to the averaged value). A high value means the frames
   * disagreed — the lighting was not actually consistent between captures — so the
   * averaged number is not a reliable reference.
   */
  maxAgreementDeltaE?: number;
}

export const DEFAULT_MIN_CALIBRATION_FRAMES = 3;

/**
 * Agreement ceiling, in mean ΔE of each frame to the averaged patch value.
 *
 * Set from what consistent handheld captures of the same card under even light
 * actually produce: frame-to-frame scatter of a few ΔE is normal camera noise, so
 * the ceiling has to sit above that. Well above ~6 means the frames are telling
 * genuinely different stories about the same patch, which only happens when the
 * lighting moved — a wandering shadow, a cloud, a reflection — and that card should
 * be recaptured rather than trusted.
 */
export const DEFAULT_MAX_AGREEMENT_DELTA_E = 6;

export type SelfCalibrationResult =
  | { ok: true; calibration: CardCalibration; report: CalibrationReport }
  | { ok: false; reason: SelfCalibrationFailure; message: string; report?: CalibrationReport };

export type SelfCalibrationFailure =
  | 'too-few-frames'
  | 'incomplete-patch-coverage'
  | 'frames-disagree';

export interface PatchAgreement {
  patchId: string;
  lab: Lab;
  agreementDeltaE: number;
  frameCount: number;
}

export interface CalibrationReport {
  frameCount: number;
  patches: readonly PatchAgreement[];
  /** Worst per-patch agreement, the figure the gate is applied to. */
  worstAgreementDeltaE: number;
  /** Mean agreement across all patches, for display. */
  meanAgreementDeltaE: number;
}

/** Component-wise median of a list of Lab values. Robust to a single bad frame. */
function medianLab(labs: readonly Lab[]): Lab {
  const pick = (key: keyof Lab): number => {
    const sorted = labs.map((lab) => lab[key]).sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  };
  return { L: pick('L'), a: pick('a'), b: pick('b') };
}

/**
 * Builds a self-measured calibration from several capture frames.
 *
 * For each patch, every frame's reading is converted to Lab, the component-wise
 * median is taken as the reference (median not mean, so one glared frame cannot
 * drag the value), and agreement is the mean ΔE of the individual frames to that
 * median. If the worst patch's agreement exceeds the ceiling, the whole calibration
 * is refused — a reference is only as good as its least consistent patch.
 */
export function buildSelfCalibration(
  frames: readonly CalibrationFrame[],
  options: SelfCalibrationOptions = {},
): SelfCalibrationResult {
  const minFrames = options.minFrames ?? DEFAULT_MIN_CALIBRATION_FRAMES;
  const maxAgreement = options.maxAgreementDeltaE ?? DEFAULT_MAX_AGREEMENT_DELTA_E;

  if (frames.length < minFrames) {
    return {
      ok: false,
      reason: 'too-few-frames',
      message: `Capture the card at least ${minFrames} times under the same even light. ${frames.length} so far.`,
    };
  }

  const agreements: PatchAgreement[] = [];

  for (const patch of PATCHES) {
    const labs: Lab[] = [];
    for (const frame of frames) {
      const reading = frame.readings.find((r) => r.patchId === patch.id);
      if (reading) labs.push(linearRgbToLab(reading.linear));
    }

    // Every patch must be present in every frame; a patch missing from any frame
    // means a detection or sampling gap, and silently averaging fewer frames for
    // one patch than another would make the references inconsistent with each other.
    if (labs.length !== frames.length) {
      return {
        ok: false,
        reason: 'incomplete-patch-coverage',
        message: `Patch "${patch.id}" was not read in every frame. Recapture so all patches are visible in each shot.`,
      };
    }

    const lab = medianLab(labs);
    const agreementDeltaE =
      labs.reduce((sum, l) => sum + deltaE2000(lab, l), 0) / labs.length;

    agreements.push({ patchId: patch.id, lab, agreementDeltaE, frameCount: labs.length });
  }

  const worstAgreementDeltaE = Math.max(...agreements.map((a) => a.agreementDeltaE));
  const meanAgreementDeltaE =
    agreements.reduce((sum, a) => sum + a.agreementDeltaE, 0) / agreements.length;

  const report: CalibrationReport = {
    frameCount: frames.length,
    patches: agreements,
    worstAgreementDeltaE,
    meanAgreementDeltaE,
  };

  if (worstAgreementDeltaE > maxAgreement) {
    const worst = agreements.reduce((a, b) => (a.agreementDeltaE > b.agreementDeltaE ? a : b));
    return {
      ok: false,
      reason: 'frames-disagree',
      message: `The captures disagree too much to average (patch "${worst.patchId}" varied ${worst.agreementDeltaE.toFixed(1)} ΔE between frames). The lighting was not consistent across captures. Shoot all frames under the same even light without moving the light source.`,
      report,
    };
  }

  const provenance: CalibrationProvenance = 'self-measured';
  const patches: MeasuredPatch[] = agreements.map((a) => ({
    patchId: a.patchId,
    lab: { L: round(a.lab.L), a: round(a.lab.a), b: round(a.lab.b) },
    agreementDeltaE: round(a.agreementDeltaE, 2),
  }));

  return {
    ok: true,
    report,
    calibration: {
      cardSpecVersion: CARD_SPEC_VERSION,
      provenance,
      cardSerial: options.cardSerial,
      measuredWith: `Device camera, ${frames.length} frames averaged`,
      measuredAt: new Date().toISOString(),
      frameCount: frames.length,
      patches,
    },
  };
}

function round(value: number, decimals = 4): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
