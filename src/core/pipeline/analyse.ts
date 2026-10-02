/**
 * The one entry point that turns a camera frame into a result.
 *
 * Sequence, and why it is in this order:
 *
 *   1. Detect the card.            Nothing else is meaningful without geometry.
 *   2. Rectify it.                 Gives a resolution-independent view for the
 *                                  focus measure and for the audit thumbnail.
 *   3. Sample the reference patches.
 *   4. Fit the colour correction.  Must happen before reading the sample, since
 *                                  the sample reading is only meaningful once
 *                                  expressed in corrected coordinates.
 *   5. Read the sample window.
 *   6. Assess quality.             Deliberately *after* the correction fit,
 *                                  because the fit residual is itself one of the
 *                                  strongest quality signals available.
 *   7. Classify, but only if every gate passed.
 *
 * A failure at any stage still returns a well-formed result carrying an
 * inconclusive classification. The fact that an operator attempted a test and the
 * software declined to read it is itself worth recording: it is the audit trail
 * that distinguishes "no test was done" from "a test was done and was unusable".
 */

import {
  CARD_HEIGHT_MM,
  CARD_WIDTH_MM,
  NOMINAL_CALIBRATION,
  PATCHES,
  SAMPLE_READ_POSITION,
  SAMPLE_READ_RECT_MM,
  normalisedCentre,
  patchSampleRect,
  referenceLabFor,
  type CardCalibration,
  type PatchSpec,
} from '../card/spec';
import {
  fitColourCorrection,
  correctToLab,
  type ColourCorrection,
  type CorrectionModel,
  type PatchObservation,
} from '../color/correction';
import { linearRgbToLab, linearToSrgb, rgbToHex, type Lab } from '../color/space';
import {
  classifySample,
  rejectedCaptureResult,
  type ClassificationResult,
} from '../classify/engine';
import type { ReagentPanel } from '../classify/panels';
import { detectCard, type CardDetection } from '../vision/detectCard';
import {
  rectifyCard,
  sampleCardRegion,
  type RegionSample,
  type RgbaImage,
} from '../vision/image';
import {
  assessCaptureQuality,
  primaryRejection,
  type QualityAssessment,
} from './quality';

export interface AnalyseOptions {
  panel: ReagentPanel;
  /** Defaults to nominal values, flagged as such. */
  calibration?: CardCalibration;
  correctionModel?: CorrectionModel;
  /** Width of the rectified card image. */
  rectifiedWidth?: number;
}

export interface PatchReading {
  patch: PatchSpec;
  sample: RegionSample;
  /** Reference value this patch was compared against. */
  referenceLab: Lab;
  /** Lab after correction, for the audit view. */
  correctedLab: Lab | null;
}

export type AnalysisStage = 'detection' | 'correction' | 'quality' | 'complete';

export interface AnalysisResult {
  /** True only when every stage succeeded and no gate rejected the capture. */
  ok: boolean;
  stage: AnalysisStage;
  /** Always present so a rejected attempt is still recordable. */
  classification: ClassificationResult;
  /** Operator-facing summary of why the capture was refused, when it was. */
  rejectionMessage?: string;
  detection?: CardDetection;
  rectifiedCard?: RgbaImage;
  correction?: ColourCorrection;
  quality?: QualityAssessment;
  patchReadings?: readonly PatchReading[];
  sampleRegion?: RegionSample;
  /** Corrected sample colour. Null when correction was unavailable. */
  sampleLab?: Lab;
  /** Corrected sample colour as a hex string, for display. */
  sampleHex?: string;
  /** Uncorrected sample colour, kept so the two can be shown side by side. */
  rawSampleHex?: string;
}

export function analyseCapture(image: RgbaImage, options: AnalyseOptions): AnalysisResult {
  const calibration = options.calibration ?? NOMINAL_CALIBRATION;
  const panel = options.panel;

  const detection = detectCard(image);
  if (!detection.ok) {
    return {
      ok: false,
      stage: 'detection',
      classification: rejectedCaptureResult(panel, detection.message),
      rejectionMessage: detection.message,
    };
  }

  const rectifiedCard = rectifyCard(
    image,
    detection.cardToImage,
    CARD_WIDTH_MM,
    CARD_HEIGHT_MM,
    options.rectifiedWidth,
  );

  const patchSamples = PATCHES.map((patch) => ({
    patch,
    sample: sampleCardRegion(image, detection.cardToImage, patchSampleRect(patch)),
  }));

  const observations: PatchObservation[] = patchSamples.map(({ patch, sample }) => ({
    patchId: patch.id,
    measuredLinear: sample.linear,
    referenceLab: referenceLabFor(patch, calibration),
    clippedFraction: sample.clippedFraction,
    position: normalisedCentre(patch.rect),
    role: patch.role,
  }));

  const fit = fitColourCorrection(observations, { model: options.correctionModel });
  const correction = fit.ok ? fit.correction : null;

  const sampleRegion = sampleCardRegion(image, detection.cardToImage, SAMPLE_READ_RECT_MM);

  const quality = assessCaptureQuality({
    detection,
    rectifiedCard,
    patchSamples,
    correction,
    sampleRegion,
    calibration,
  });

  const patchReadings: PatchReading[] = patchSamples.map(({ patch, sample }) => ({
    patch,
    sample,
    referenceLab: referenceLabFor(patch, calibration),
    correctedLab: correction
      ? correctToLab(correction, sample.linear, normalisedCentre(patch.rect))
      : null,
  }));

  const rawSampleHex = rgbToHex(linearToSrgb(sampleRegion.linear));

  if (!correction) {
    const message = fit.ok ? 'Colour calibration failed.' : fit.message;
    return {
      ok: false,
      stage: 'correction',
      classification: rejectedCaptureResult(panel, message),
      rejectionMessage: message,
      detection,
      rectifiedCard,
      quality,
      patchReadings,
      sampleRegion,
      rawSampleHex,
    };
  }

  const sampleLab = correctToLab(correction, sampleRegion.linear, SAMPLE_READ_POSITION);
  const sampleHex = rgbToHex(linearToSrgb(sampleRegion.linear));

  const base = {
    detection,
    rectifiedCard,
    correction,
    quality,
    patchReadings,
    sampleRegion,
    sampleLab,
    sampleHex,
    rawSampleHex,
  };

  if (!quality.ok) {
    const rejection = primaryRejection(quality);
    const message = rejection?.message ?? 'Capture did not meet quality requirements.';
    return {
      ok: false,
      stage: 'quality',
      classification: rejectedCaptureResult(panel, message),
      rejectionMessage: message,
      ...base,
    };
  }

  return {
    ok: true,
    stage: 'complete',
    classification: classifySample(sampleLab, panel),
    ...base,
  };
}

/** Uncorrected sample colour in Lab, for showing what calibration changed. */
export function uncorrectedSampleLab(result: AnalysisResult): Lab | null {
  if (!result.sampleRegion) return null;
  return linearRgbToLab(result.sampleRegion.linear);
}
