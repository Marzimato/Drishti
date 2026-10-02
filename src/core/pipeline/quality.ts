/**
 * Capture quality gates.
 *
 * The single most valuable thing this application can do is refuse to produce a
 * number it cannot stand behind. A wrong-but-confident reading, signed and
 * timestamped into an evidentiary record, is worse than no reading at all: it
 * carries the authority of the system while being false.
 *
 * So every capture must clear a set of explicit, individually reportable gates
 * before it is classified. Each gate either rejects the capture or raises a
 * warning, and each carries an operator-facing message describing the specific
 * physical action that would fix it — "move into even light", not "error 7".
 *
 * The gates fall into three groups:
 *   - Optics:   is the image sharp, well exposed, and large enough to measure?
 *   - Geometry: is the card really where we think it is?
 *   - Colour:   did the correction actually work, and on what quality of data?
 *
 * The neutral-ramp monotonicity gate deserves special mention: it is an
 * independent check on the geometry. If the homography were wrong — a mis-selected
 * corner, a mirrored card — the grey patches would be read from the wrong places
 * and their lightness would stop descending in the expected order. It therefore
 * catches whole classes of geometric error that the detector itself cannot see.
 */

import type { CardCalibration, PatchSpec } from '../card/spec';
import { NEUTRAL_RAMP, hasPerPatchReferences, isFullyMeasured } from '../card/spec';
import {
  MAX_PLAUSIBLE_FIELD_STRENGTH,
  correctionCastRatio,
  type ColourCorrection,
} from '../color/correction';
import { relativeLuminance } from '../color/space';
import type { CardDetection } from '../vision/detectCard';
import { laplacianVariance, toGrayscale, type RegionSample, type RgbaImage } from '../vision/image';

export type IssueSeverity = 'reject' | 'warn';

export type QualityIssueCode =
  | 'out-of-focus'
  | 'card-too-small'
  | 'card-too-oblique'
  | 'weak-orientation-marker'
  | 'overexposed'
  | 'underexposed'
  | 'uneven-patch-illumination'
  | 'grey-ramp-out-of-order'
  | 'correction-unavailable'
  | 'correction-poor-fit'
  | 'patch-fits-poorly'
  | 'extreme-colour-cast'
  | 'uneven-lighting-across-card'
  | 'illumination-fit-discarded'
  | 'sample-area-not-uniform'
  | 'calibration-not-measured';

export interface QualityIssue {
  code: QualityIssueCode;
  severity: IssueSeverity;
  /** Operator-facing, actionable. */
  message: string;
  measured?: number;
  threshold?: number;
}

export interface QualityMetrics {
  focusScore: number;
  cardCoverage: number;
  quadAspect: number;
  orientationContrast: number;
  meanPatchClipping: number;
  maxPatchClipping: number;
  brightestNeutralLuminance: number;
  darkestNeutralLuminance: number;
  maxPatchNonUniformity: number;
  greyRampInversions: number;
  correctionMeanDeltaE: number | null;
  correctionMaxDeltaE: number | null;
  castRatio: number | null;
  illuminationGradientStrength: number | null;
  sampleNonUniformity: number;
}

export interface QualityAssessment {
  /** True when no gate rejected the capture. Warnings do not block. */
  ok: boolean;
  issues: readonly QualityIssue[];
  metrics: QualityMetrics;
}

/* --------------------------------------------------------------- thresholds */

/**
 * Laplacian variance on the rectified card (scaled by 1e4), below which the
 * capture is too soft to measure.
 *
 * Measured against synthetic renders: a sharp card scores 190-240, a mildly
 * defocused one about 20, and a badly defocused one about 2.5.
 *
 * The threshold is set low on purpose. Because patch colours are read from the
 * central 50% of each patch, moderate blur does not actually degrade the colour
 * measurement — the mildly blurred render produced an identical worst-patch error
 * (0.84 dE) to the sharp one. Rejecting it would inconvenience the operator for no
 * accuracy gain. Blur only becomes harmful when it lets the surrounding card bleed
 * into the sample reading, and that shows up independently as sample-area
 * non-uniformity.
 *
 * Note this metric conflates sharpness with contrast: a correctly focused but very
 * dark frame also scores low. That is why underexposure has its own gate rather
 * than being inferred from this one.
 */
export const MIN_FOCUS_SCORE = 8;

/**
 * Illumination gradient strength (fractional brightness swing across the card)
 * above which the operator is told the lighting is uneven. The two-stage
 * correction handles gradients well — a 0.64-strength gradient still fitted to
 * 0.27 dE worst-patch error — so this is a warning, not a rejection.
 */
export const MAX_COMFORTABLE_GRADIENT_STRENGTH = 0.35;

/**
 * Minimum fraction of the frame covered by the marker quad. Below this there are
 * too few pixels per patch for the averaging to beat sensor noise.
 */
export const MIN_CARD_COVERAGE = 0.06;

/** Plausible range for the apparent marker-rectangle aspect (true value ~1.85). */
export const MIN_ACCEPTABLE_QUAD_ASPECT = 1.15;
export const MAX_ACCEPTABLE_QUAD_ASPECT = 2.9;

/** Minimum contrast on the orientation key before we distrust the orientation. */
export const MIN_ORIENTATION_CONTRAST_WARN = 0.3;

/** Clipping fractions across the calibration patches. */
export const MAX_MEAN_PATCH_CLIPPING = 0.12;
export const MAX_SINGLE_PATCH_CLIPPING = 0.6;

/** The white patch must stay bright enough to carry signal. */
export const MIN_BRIGHTEST_NEUTRAL_LUMINANCE = 0.06;

/**
 * Within-patch variation, as standard deviation over mean in linear light.
 *
 * Recalibrated against a real printed card rather than synthetic renders. The
 * original 0.25 came from synthetic data, which has no halftone structure, no paper
 * texture, no camera sharpening and no JPEG artefacts — so it could not exhibit the
 * very variation this gate measures, and the threshold was correspondingly
 * optimistic.
 *
 * Measured on a real inkjet card at 0% clipping with a clean neutral ramp: patches
 * ranged 0.015 to 0.296, with the darkest patches highest. For contrast, a capture
 * with a genuinely wrong homography measured 0.778. 0.45 therefore sits clear of
 * normal print variation while still catching gross failures.
 *
 * KNOWN LIMITATION: because the figure is normalised by the patch mean, a fixed
 * amount of noise or texture produces a larger relative value on a dark patch than
 * a light one. Real measurements show this clearly — the neutral ramp's variation
 * rises monotonically as the patches darken, from 0.015 at white to 0.248 at the
 * darkest step, with no shadow present at all. The gate therefore partly measures
 * patch lightness rather than illumination evenness.
 *
 * The proper fix is to measure *spatial structure* instead of total variance: a
 * shadow across a patch is a low-frequency ramp, whereas halftone and sensor noise
 * are high-frequency. Fitting a plane to the samples within each patch and
 * reporting the fitted gradient would isolate shading from texture and remove the
 * lightness bias entirely. That needs sampleCardRegion to retain per-sample
 * positions, so it is deliberately left as follow-up rather than bundled into a
 * threshold change.
 */
export const MAX_PATCH_NON_UNIFORMITY = 0.45;

/**
 * Correction residual limits, in CIEDE2000 against the reference values.
 *
 * These depend on whether the card has been measured, because the two cases are
 * asking different questions.
 *
 * With a **measured** card, the reference values describe the card as it physically
 * is. A large residual then means the capture itself is bad — bad lighting, a
 * non-linear camera response, a misaligned homography — and should be refused.
 *
 * With a **nominal** card, the reference values are the colours sent to the printer,
 * and the printer will not have reproduced them exactly. Part of the residual is
 * therefore expected print error rather than a bad capture, and refusing on it
 * would reject every capture on a slightly imperfect card. Measured on a real
 * inkjet print: about 4.9 mean and 13.4 worst, the worst being a red patch
 * hue-shifted toward magenta.
 *
 * The nominal limits are looser to accommodate that, which is a deliberate
 * trade and not a free pass: the capture still carries the
 * 'calibration-not-measured' warning, and a residual of this size does consume real
 * classification margin. Measuring the card is what earns the strict limits back.
 */
export const MAX_CORRECTION_MEAN_DELTA_E_MEASURED = 4;
export const MAX_CORRECTION_MAX_DELTA_E_MEASURED = 9;
export const MAX_CORRECTION_MEAN_DELTA_E_NOMINAL = 8;
export const MAX_CORRECTION_MAX_DELTA_E_NOMINAL = 16;

/** Colour cast beyond this ratio is workable but worth flagging. */
export const MAX_COMFORTABLE_CAST_RATIO = 2.5;

/** Sample-area non-uniformity above this suggests the reading is not of one colour. */
export const MAX_SAMPLE_NON_UNIFORMITY = 0.45;

export interface QualityInput {
  detection: CardDetection;
  /** Output of rectifyCard, used for the focus measure. */
  rectifiedCard: RgbaImage;
  patchSamples: ReadonlyArray<{ patch: PatchSpec; sample: RegionSample }>;
  /** Null when the correction could not be fitted at all. */
  correction: ColourCorrection | null;
  sampleRegion: RegionSample;
  calibration: CardCalibration;
}

/**
 * Gates that are advisory rather than blocking in this build.
 *
 * DRISHTI is a prototype in its entirety, so this is not a toggle — it is simply
 * how these three gates behave. They fail on things that make a reading *less
 * trustworthy* but still meaningful: paper texture and raking light inflating
 * within-patch variance, and a correction residual that is partly expected print
 * error on a nominal card. At prototype stage these should inform the operator, not
 * stop them, so an end-to-end result can be produced on a hand-printed card under
 * field lighting while the thresholds are still being tuned against real data.
 *
 * They still run and still report their measured values and limits, so the numbers
 * are available for that tuning — only the severity is fixed to advisory.
 *
 * Everything NOT in this set remains a hard rejection, because those gates fail on
 * things that make a reading *meaningless* rather than merely weak: no card found, a
 * grossly oblique view, a blown-out or black frame, a grey ramp that reads out of
 * order (the homography is wrong), or a correction that could not be fitted at all.
 * Passing those through would not produce a loose result, it would produce a
 * fabricated one — which no stage of maturity makes acceptable.
 */
export const ADVISORY_ONLY_GATES: ReadonlySet<QualityIssueCode> = new Set([
  'uneven-patch-illumination',
  'sample-area-not-uniform',
  'correction-poor-fit',
]);

/**
 * Within-region variation: luminance standard deviation over luminance mean.
 *
 * Exported so the diagnostic view can report the same figure per patch using the
 * identical computation, rather than a near-miss reimplementation that would
 * disagree with the gate it is meant to explain.
 */
export function regionNonUniformity(sample: RegionSample): number {
  const meanLuminance = relativeLuminance(sample.rawMeanLinear);
  // Standard deviation of the luminance-weighted channels, relative to the mean.
  const stdLuminance = relativeLuminance(sample.stdLinear);
  if (meanLuminance < 1e-6) return Number.POSITIVE_INFINITY;
  return stdLuminance / meanLuminance;
}

/**
 * Counts places where the grey ramp fails to get darker.
 *
 * A small tolerance is allowed so that sensor noise on two adjacent steps cannot
 * trip the gate; only a real ordering failure counts.
 */
function countGreyRampInversions(
  patchSamples: QualityInput['patchSamples'],
  toleranceLinear = 0.006,
): number {
  const byId = new Map(patchSamples.map((entry) => [entry.patch.id, entry.sample]));
  const luminances: number[] = [];

  for (const patch of NEUTRAL_RAMP) {
    const sample = byId.get(patch.id);
    if (!sample) continue;
    luminances.push(relativeLuminance(sample.linear));
  }

  let inversions = 0;
  for (let i = 1; i < luminances.length; i++) {
    if (luminances[i] > luminances[i - 1] + toleranceLinear) inversions++;
  }
  return inversions;
}

export function assessCaptureQuality(input: QualityInput): QualityAssessment {
  const issues: QualityIssue[] = [];

  /**
   * Records an issue, forcing the advisory-only gates to warn severity in one
   * place.
   *
   * A gate declares the severity it would have in a fully-tuned build; if it is in
   * ADVISORY_ONLY_GATES it is capped at 'warn' here. Centralising it means a gate
   * author cannot forget the rule, and the measured number is reported either way.
   */
  const add = (issue: QualityIssue) => {
    if (issue.severity === 'reject' && ADVISORY_ONLY_GATES.has(issue.code)) {
      issues.push({ ...issue, severity: 'warn' });
      return;
    }
    issues.push(issue);
  };

  const focusScore = laplacianVariance(toGrayscale(input.rectifiedCard)) * 1e4;

  const clippings = input.patchSamples.map((entry) => entry.sample.clippedFraction);
  const meanPatchClipping =
    clippings.length === 0 ? 0 : clippings.reduce((a, b) => a + b, 0) / clippings.length;
  const maxPatchClipping = clippings.length === 0 ? 0 : Math.max(...clippings);

  const neutralIds = new Set(NEUTRAL_RAMP.map((patch) => patch.id));
  const neutralLuminances = input.patchSamples
    .filter((entry) => neutralIds.has(entry.patch.id))
    .map((entry) => relativeLuminance(entry.sample.linear));

  const brightestNeutralLuminance =
    neutralLuminances.length === 0 ? 0 : Math.max(...neutralLuminances);
  const darkestNeutralLuminance =
    neutralLuminances.length === 0 ? 0 : Math.min(...neutralLuminances);

  const maxPatchNonUniformity =
    input.patchSamples.length === 0
      ? 0
      : Math.max(...input.patchSamples.map((entry) => regionNonUniformity(entry.sample)));

  const greyRampInversions = countGreyRampInversions(input.patchSamples);
  const sampleNonUniformity = regionNonUniformity(input.sampleRegion);

  const metrics: QualityMetrics = {
    focusScore,
    cardCoverage: input.detection.cardCoverage,
    quadAspect: input.detection.quadAspect,
    orientationContrast: input.detection.orientationContrast,
    meanPatchClipping,
    maxPatchClipping,
    brightestNeutralLuminance,
    darkestNeutralLuminance,
    maxPatchNonUniformity,
    greyRampInversions,
    correctionMeanDeltaE: input.correction?.meanDeltaE ?? null,
    correctionMaxDeltaE: input.correction?.maxDeltaE ?? null,
    castRatio: input.correction ? correctionCastRatio(input.correction) : null,
    illuminationGradientStrength: input.correction?.field?.strength ?? null,
    sampleNonUniformity,
  };

  /* ------------------------------------------------------------------ optics */

  if (focusScore < MIN_FOCUS_SCORE) {
    add({
      code: 'out-of-focus',
      severity: 'reject',
      message:
        'The card is not sharp. Hold steadier, move slightly further away, and let the camera focus before capturing.',
      measured: focusScore,
      threshold: MIN_FOCUS_SCORE,
    });
  }

  if (input.detection.cardCoverage < MIN_CARD_COVERAGE) {
    add({
      code: 'card-too-small',
      severity: 'reject',
      message: 'The card is too small in frame to measure accurately. Move closer.',
      measured: input.detection.cardCoverage,
      threshold: MIN_CARD_COVERAGE,
    });
  }

  if (meanPatchClipping > MAX_MEAN_PATCH_CLIPPING || maxPatchClipping > MAX_SINGLE_PATCH_CLIPPING) {
    add({
      code: 'overexposed',
      severity: 'reject',
      message:
        'Parts of the card are blown out. Move out of direct light or reduce exposure, then capture again.',
      measured: Math.max(meanPatchClipping, maxPatchClipping),
      threshold: MAX_MEAN_PATCH_CLIPPING,
    });
  }

  if (brightestNeutralLuminance < MIN_BRIGHTEST_NEUTRAL_LUMINANCE) {
    add({
      code: 'underexposed',
      severity: 'reject',
      message: 'The card is too dark to measure. Add light or increase exposure.',
      measured: brightestNeutralLuminance,
      threshold: MIN_BRIGHTEST_NEUTRAL_LUMINANCE,
    });
  }

  if (maxPatchNonUniformity > MAX_PATCH_NON_UNIFORMITY) {
    add({
      code: 'uneven-patch-illumination',
      severity: 'reject',
      message:
        'A shadow or reflection is falling across the card. Move so the light is even and no glare lands on it.',
      measured: maxPatchNonUniformity,
      threshold: MAX_PATCH_NON_UNIFORMITY,
    });
  }

  /* ---------------------------------------------------------------- geometry */

  if (
    input.detection.quadAspect < MIN_ACCEPTABLE_QUAD_ASPECT ||
    input.detection.quadAspect > MAX_ACCEPTABLE_QUAD_ASPECT
  ) {
    add({
      code: 'card-too-oblique',
      severity: 'reject',
      message:
        'The card is at too steep an angle. Hold the camera square to the card and try again.',
      measured: input.detection.quadAspect,
      threshold: MAX_ACCEPTABLE_QUAD_ASPECT,
    });
  }

  if (input.detection.orientationContrast < MIN_ORIENTATION_CONTRAST_WARN) {
    add({
      code: 'weak-orientation-marker',
      severity: 'warn',
      message:
        'The top-left orientation marker is faint. Check the card is clean and undamaged in that corner.',
      measured: input.detection.orientationContrast,
      threshold: MIN_ORIENTATION_CONTRAST_WARN,
    });
  }

  if (greyRampInversions > 0) {
    add({
      code: 'grey-ramp-out-of-order',
      severity: 'reject',
      message:
        'The grey reference steps did not read in the expected order, so the card may not be correctly aligned or may be damaged. Reposition and capture again.',
      measured: greyRampInversions,
      threshold: 0,
    });
  }

  /* ------------------------------------------------------------------ colour */

  // The strict residual limits apply whenever the references describe the physical
  // card — instrument-measured or self-measured alike — because then a large
  // residual really does mean a bad capture. Nominal keeps the looser limits since
  // part of its residual is expected print error. The message still distinguishes
  // the two below.
  const calibrationHasRealReferences = hasPerPatchReferences(input.calibration);
  const maxMeanDeltaE = calibrationHasRealReferences
    ? MAX_CORRECTION_MEAN_DELTA_E_MEASURED
    : MAX_CORRECTION_MEAN_DELTA_E_NOMINAL;
  const maxWorstDeltaE = calibrationHasRealReferences
    ? MAX_CORRECTION_MAX_DELTA_E_MEASURED
    : MAX_CORRECTION_MAX_DELTA_E_NOMINAL;

  if (!input.correction) {
    add({
      code: 'correction-unavailable',
      severity: 'reject',
      message:
        'Colour calibration could not be computed from the card. Make sure all reference patches are visible and evenly lit.',
    });
  } else {
    if (
      input.correction.meanDeltaE > maxMeanDeltaE ||
      input.correction.maxDeltaE > maxWorstDeltaE
    ) {
      add({
        code: 'correction-poor-fit',
        severity: 'reject',
        message: calibrationHasRealReferences
          ? 'Colour calibration did not fit the reference card well enough to trust a result. Improve the lighting and capture again.'
          : 'Colour calibration did not fit the reference card well enough to trust a result. This card is using nominal values, so a poor fit may mean the print differs from specification rather than that the capture is bad. Measuring the card would distinguish the two.',
        measured: input.correction.maxDeltaE,
        threshold: maxWorstDeltaE,
      });
    }

    /**
     * Flags a single badly-fitting patch even when the aggregate passes.
     *
     * A lone outlier is diagnostically different from generally poor agreement: it
     * points at one patch that printed off-specification, and it locally distorts
     * the corrected colour space around that hue. Samples near it read less
     * accurately while everything else looks fine, which is worth telling the
     * operator rather than hiding inside an average.
     */
    const worstPatch = [...input.correction.residuals]
      .filter((residual) => residual.usedInFit)
      .sort((a, b) => b.deltaE - a.deltaE)[0];

    if (
      worstPatch &&
      input.correction.meanDeltaE <= maxMeanDeltaE &&
      worstPatch.deltaE > input.correction.meanDeltaE * 2 &&
      worstPatch.deltaE > 8
    ) {
      add({
        code: 'patch-fits-poorly',
        severity: 'warn',
        message: `Reference patch "${worstPatch.patchId}" fits far worse than the others, so colours near it are read less accurately. That patch has most likely printed off-specification.`,
        measured: worstPatch.deltaE,
        threshold: maxWorstDeltaE,
      });
    }

    const cast = correctionCastRatio(input.correction);
    if (cast > MAX_COMFORTABLE_CAST_RATIO) {
      add({
        code: 'extreme-colour-cast',
        severity: 'warn',
        message:
          'The ambient light is strongly coloured. The result has been corrected, but capturing under more neutral light will be more precise.',
        measured: cast,
        threshold: MAX_COMFORTABLE_CAST_RATIO,
      });
    }

    const field = input.correction.field;
    const rejected = input.correction.fieldRejected;
    const gradientStrength = field?.strength ?? 0;

    if (rejected) {
      add({
        code: 'illumination-fit-discarded',
        severity: 'warn',
        message:
          rejected.reason === 'implausible-magnitude'
            ? 'The apparent brightness gradient across the card was too large to be real lighting, so it was ignored and a single global correction was used instead. If the card is curled, flattening it should help; otherwise the printed grey steps may not match their specified values.'
            : 'A brightness gradient was detected but ignored, because correcting for it made agreement with the reference card worse rather than better. That usually means the apparent gradient comes from the printed grey steps not matching their specified values, rather than from the lighting.',
        measured: rejected.strength,
        threshold: MAX_PLAUSIBLE_FIELD_STRENGTH,
      });
    } else if (gradientStrength > MAX_COMFORTABLE_GRADIENT_STRENGTH) {
      add({
        code: 'uneven-lighting-across-card',
        severity: 'warn',
        message:
          'Light is falling unevenly across the card. This has been compensated for, but even lighting gives a more precise result.',
        measured: gradientStrength,
        threshold: MAX_COMFORTABLE_GRADIENT_STRENGTH,
      });
    }
  }

  if (sampleNonUniformity > MAX_SAMPLE_NON_UNIFORMITY) {
    add({
      code: 'sample-area-not-uniform',
      severity: 'reject',
      message:
        'The reading area does not contain a single even colour. Reposition the test result so it fills the marked area.',
      measured: sampleNonUniformity,
      threshold: MAX_SAMPLE_NON_UNIFORMITY,
    });
  }

  if (!isFullyMeasured(input.calibration)) {
    add({
      code: 'calibration-not-measured',
      severity: 'warn',
      message: hasPerPatchReferences(input.calibration)
        ? 'This card is self-measured from the device camera rather than a colour instrument. The references describe this physical card, but they inherit the camera\u2019s own colour rendering; an instrument measurement is more accurate still.'
        : 'This card is using nominal reference values rather than measured ones. Results remain comparable between captures, but absolute colour accuracy is unverified.',
    });
  }

  return {
    ok: !issues.some((issue) => issue.severity === 'reject'),
    issues,
    metrics,
  };
}

/** The first rejecting issue, for a concise operator-facing summary. */
export function primaryRejection(assessment: QualityAssessment): QualityIssue | undefined {
  return assessment.issues.find((issue) => issue.severity === 'reject');
}
