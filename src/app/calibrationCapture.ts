/**
 * Turns a captured camera frame into the per-patch readings the self-calibration
 * averager consumes.
 *
 * Kept separate from core/card/selfCalibrate.ts on purpose: that module is pure
 * colour maths with no dependency on the vision pipeline, so it can be unit tested
 * in isolation. This file is the glue that reuses the same detector and sampler the
 * normal capture path uses, so a frame is read for calibration exactly as it would
 * be read for a measurement — no second, subtly different sampling code to drift.
 */

import { PATCHES, patchSampleRect } from '../core/card/spec';
import type { CalibrationFrame } from '../core/card/selfCalibrate';
import { detectCard } from '../core/vision/detectCard';
import { sampleCardRegion, type RgbaImage } from '../core/vision/image';

export type FrameOutcome =
  | { ok: true; frame: CalibrationFrame }
  | { ok: false; message: string };

/**
 * Detects the card in a frame and samples every patch, returning the raw linear
 * means. Fails with the detector's own operator-facing message when the card
 * cannot be found, so the calibration UI can surface it just like the capture
 * screen does.
 *
 * Note it deliberately does NOT run the quality gates: a single calibration frame
 * is allowed to be individually imperfect, because averaging across frames is what
 * makes the result trustworthy, and cross-frame agreement is the gate that matters
 * here. It still needs a valid detection, since without geometry the patches cannot
 * be located at all.
 */
export function readCalibrationFrame(image: RgbaImage): FrameOutcome {
  const detection = detectCard(image);
  if (!detection.ok) {
    return { ok: false, message: detection.message };
  }

  const readings = PATCHES.map((patch) => ({
    patchId: patch.id,
    linear: sampleCardRegion(image, detection.cardToImage, patchSampleRect(patch)).linear,
  }));

  return { ok: true, frame: { readings } };
}
