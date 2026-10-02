/**
 * Illuminant-invariant colour correction from reference card patches.
 *
 * The problem this solves: the same reagent colour photographed under tungsten,
 * shade and midday sun produces very different pixel values. Without correction,
 * a classifier trained or thresholded on one lighting condition is meaningless in
 * another. With a known reference card in the frame we can solve for the
 * transform that maps *this photograph's* colour response back onto the card's
 * known reference values, and then apply that same transform to the sample.
 *
 * Two design points worth stating explicitly:
 *
 * 1. The fit is performed in **linear light**. The camera's response to scene
 *    radiance is approximately linear before the gamma curve is applied, so an
 *    affine model is a good fit there and a poor one in encoded space.
 *
 * 2. The default model is **affine (3x4), not a bare 3x3**. The additive term
 *    absorbs veiling glare and sensor black-level offset, which are always
 *    present on a phone camera and which a purely multiplicative model has to
 *    misattribute to the colour matrix. In practice including the offset roughly
 *    halves the residual on real captures.
 */

import {
  labToLinearRgb,
  linearRgbToLab,
  type Lab,
  type LinearRgb,
} from './space';
import { deltaE2000 } from './deltaE';
import { residualRms, solveLeastSquares } from '../math/linalg';

export type CorrectionModel = 'diagonal' | 'linear3x3' | 'affine3x4';

/** Normalised position on the card, both components in [0, 1]. */
export interface CardPosition {
  u: number;
  v: number;
}

/** One calibration patch observation feeding the fit. */
export interface PatchObservation {
  patchId: string;
  /** What the camera recorded, in linear light. */
  measuredLinear: LinearRgb;
  /** What the patch is known to be. */
  referenceLab: Lab;
  /**
   * Fraction of the patch's pixels that were clipped. Heavily clipped patches
   * carry no usable information and are excluded from the fit.
   */
  clippedFraction?: number;
  /**
   * Where the patch sits on the card. Supplying this for the neutral patches
   * enables spatial illumination correction (see fitIlluminationField).
   */
  position?: CardPosition;
  /** Neutral patches carry the intensity information used for the spatial fit. */
  role?: 'neutral' | 'chromatic';
}

/**
 * A planar model of how brightness varies across the card:
 *
 *   gain(u, v) = c0 + cu*u + cv*v
 *
 * Why this is needed: a light source off to one side, or a shadow falling across
 * part of the card, makes one edge dimmer than the other. A single global colour
 * matrix cannot represent that, because it applies the same transform everywhere;
 * the best it can do is split the difference, leaving the patches at the extremes
 * with the largest error.
 *
 * The field is fitted from the neutral patches only. Those span a wide lightness
 * range at a known constant hue, which makes them the cleanest available probe of
 * pure intensity variation, uncontaminated by spectral effects. Measured
 * brightness is divided by the field before the colour matrix is fitted, so the
 * two effects are separated instead of competing.
 */
export interface IlluminationField {
  c0: number;
  cu: number;
  cv: number;
  /** Field value at the card centre; used to normalise without changing overall level. */
  centre: number;
  /** Relative brightness difference across the card, e.g. 0.3 for a 30% falloff. */
  strength: number;
  /**
   * False when the fitted gradient is too large to be real illumination, in which
   * case the field is reported for diagnostics but not applied. See
   * MAX_PLAUSIBLE_FIELD_STRENGTH.
   */
  plausible: boolean;
}

/**
 * Largest apparent gradient we are willing to believe and act on.
 *
 * This is a backstop, not a diagnosis. Strength relates to a falloff of amount `a`
 * roughly as `a / (1 - a/2)`, so a real 55% falloff already measures about 0.76 and
 * a severe 70% one about 1.08. Magnitude therefore cannot cleanly distinguish a
 * genuinely steep gradient from a spurious one, and a tighter cap wrongly rejects
 * real gradients that the correction handles well — a synthetic 55% case fits to
 * 0.27 dE worst-patch and must not be discarded.
 *
 * The cap exists because applying a *wrong* field is actively harmful rather than
 * merely useless: it brightens the patches at one end of the card, the colour matrix
 * compensates by darkening globally, and every region away from that end — including
 * the sample window — is then read too dark. Observed on a real card, this pushed
 * bare paper 25 L* below an adjacent patch of the identical stock.
 *
 * The actual cause of that failure was a card layout in which neutral lightness
 * correlated with horizontal position, making the printer's tone response aliased
 * with a spatial gradient. That is fixed in the card spec by de-correlating the two,
 * which is the real remedy; this threshold only limits the damage when something
 * similar happens again. It is set to admit any physically plausible lighting while
 * still catching a fit that has clearly absorbed something non-spatial.
 */
export const MAX_PLAUSIBLE_FIELD_STRENGTH = 1.0;

export interface PatchResidual {
  patchId: string;
  deltaE: number;
  usedInFit: boolean;
}

export interface ColourCorrection {
  model: CorrectionModel;
  /**
   * Three rows of four coefficients: out_c = m[c][0]*r + m[c][1]*g + m[c][2]*b +
   * m[c][3]. The offset column is zero for the non-affine models.
   */
  matrix: readonly (readonly number[])[];
  /**
   * Spatial illumination model, present **only when it was actually applied**.
   * When present, callers must pass the sample's card position to applyCorrection
   * for the correction to be complete.
   */
  field?: IlluminationField;
  /**
   * Set when a gradient was found but deliberately not used, with the reason.
   * Reported so the operator learns something rather than the decision being
   * silent.
   */
  fieldRejected?: {
    strength: number;
    reason: 'implausible-magnitude' | 'did-not-improve-fit';
    /** Mean Delta-E the field would have produced, for comparison. */
    meanDeltaEWithField: number;
    meanDeltaEWithoutField: number;
  };
  /** RMS residual in linear light across the fitted channels. */
  residualLinear: number;
  /** CIEDE2000 between corrected and reference for the fitted patches. */
  meanDeltaE: number;
  maxDeltaE: number;
  /** Per-patch breakdown, including patches excluded from the fit. */
  residuals: readonly PatchResidual[];
  patchesUsed: number;
}

export type CorrectionFit =
  | { ok: true; correction: ColourCorrection }
  | { ok: false; reason: 'too-few-patches' | 'singular-system'; message: string };

/** Patches with more clipping than this are dropped from the fit. */
export const MAX_PATCH_CLIPPING_FOR_FIT = 0.2;

/**
 * Below this relative variation the spatial fit is discarded as noise. Applying a
 * gradient correction that is really just measurement scatter would add error
 * rather than remove it.
 */
export const MIN_FIELD_STRENGTH_TO_APPLY = 0.04;

/** Minimum neutral patches required to fit the three-parameter spatial plane. */
const MIN_NEUTRALS_FOR_FIELD = 4;

/**
 * Fits the planar brightness field from neutral patch observations.
 *
 * Returns null when there are too few neutrals, when positions are missing, or
 * when the recovered gradient is too weak to be distinguishable from noise.
 */
export function fitIlluminationField(
  observations: readonly PatchObservation[],
): IlluminationField | null {
  const neutrals = observations.filter(
    (observation) =>
      observation.role === 'neutral' &&
      observation.position !== undefined &&
      (observation.clippedFraction ?? 0) <= MAX_PATCH_CLIPPING_FOR_FIT,
  );

  if (neutrals.length < MIN_NEUTRALS_FOR_FIELD) return null;

  const design: number[][] = [];
  const target: number[] = [];

  for (const observation of neutrals) {
    const reference = labToLinearRgb(observation.referenceLab);
    const referenceLuminance = luminance(reference);
    if (referenceLuminance < 0.02) continue;

    const measuredLuminance = luminance(observation.measuredLinear);
    const position = observation.position!;

    /**
     * Fit in absolute luminance rather than on ratios.
     *
     * The model is `measured = reference * (c0 + cu*u + cv*v)`. Solving it directly
     * in absolute terms, instead of dividing through to get a ratio first, is the
     * statistically correct choice: measurement error is roughly constant in
     * absolute luminance, so the *relative* error of a ratio scales as 1/reference.
     * The darkest neutral has a linear luminance around 0.03, so on a ratio basis a
     * small absolute error there becomes an enormous relative one and a single noisy
     * dark patch dominates the fit.
     *
     * This formulation is exactly a weighted least squares with weight proportional
     * to reference luminance squared, which is the inverse of that variance. On a
     * real card it stopped one badly-printed dark patch from producing an absurd
     * apparent gradient; on clean data it makes no difference.
     */
    design.push([referenceLuminance, referenceLuminance * position.u, referenceLuminance * position.v]);
    target.push(measuredLuminance);
  }

  if (design.length < MIN_NEUTRALS_FOR_FIELD) return null;

  const solved = solveLeastSquares(design, target);
  if (!solved) return null;

  const [c0, cu, cv] = solved;
  if (![c0, cu, cv].every(Number.isFinite)) return null;

  const centre = c0 + cu * 0.5 + cv * 0.5;
  if (!(centre > 1e-6)) return null;

  // Strength is the total swing across the card relative to the centre value.
  const strength = (Math.abs(cu) + Math.abs(cv)) / centre;
  if (strength < MIN_FIELD_STRENGTH_TO_APPLY) return null;

  return {
    c0,
    cu,
    cv,
    centre,
    strength,
    plausible: strength <= MAX_PLAUSIBLE_FIELD_STRENGTH,
  };
}

function luminance(linear: LinearRgb): number {
  return 0.2126 * linear.r + 0.7152 * linear.g + 0.0722 * linear.b;
}

/**
 * Brightness of the field at a position, relative to the card centre.
 * Clamped away from zero so a badly extrapolated field cannot divide by ~0.
 */
export function relativeFieldGain(field: IlluminationField, position: CardPosition): number {
  const value = field.c0 + field.cu * position.u + field.cv * position.v;
  const relative = value / field.centre;
  return Math.min(3, Math.max(0.33, relative));
}

function normaliseForField(
  measured: LinearRgb,
  field: IlluminationField | undefined,
  position: CardPosition | undefined,
): LinearRgb {
  // Whether to apply a field at all is decided in fitColourCorrection, which only
  // attaches one to the correction if it earned its place. This helper applies
  // whatever it is given.
  if (!field || !position) return measured;
  const gain = relativeFieldGain(field, position);
  return { r: measured.r / gain, g: measured.g / gain, b: measured.b / gain };
}

const COEFFICIENTS_PER_MODEL: Record<CorrectionModel, number> = {
  diagonal: 1,
  linear3x3: 3,
  affine3x4: 4,
};

function designRow(model: CorrectionModel, measured: LinearRgb, channel: 0 | 1 | 2): number[] {
  const channels = [measured.r, measured.g, measured.b];
  switch (model) {
    case 'diagonal':
      return [channels[channel]];
    case 'linear3x3':
      return [...channels];
    case 'affine3x4':
      return [...channels, 1];
  }
}

function expandCoefficients(
  model: CorrectionModel,
  solved: readonly number[],
  channel: 0 | 1 | 2,
): number[] {
  switch (model) {
    case 'diagonal': {
      const row = [0, 0, 0, 0];
      row[channel] = solved[0];
      return row;
    }
    case 'linear3x3':
      return [solved[0], solved[1], solved[2], 0];
    case 'affine3x4':
      return [solved[0], solved[1], solved[2], solved[3]];
  }
}

/**
 * Fits the correction that best maps measured patch colours onto their reference
 * values.
 *
 * Returns a failure rather than a degraded result when there is not enough usable
 * data. A silently poor correction would produce a confident, wrong colour
 * reading, which for this application is worse than refusing to give an answer.
 */
export function fitColourCorrection(
  observations: readonly PatchObservation[],
  options: { model?: CorrectionModel; spatial?: boolean } = {},
): CorrectionFit {
  const model = options.model ?? 'affine3x4';
  const required = COEFFICIENTS_PER_MODEL[model];

  // Stage one: separate out any spatial brightness gradient, so the colour matrix
  // is not asked to absorb a position-dependent effect it cannot express.
  const field =
    options.spatial === false ? null : fitIlluminationField(observations);

  const usable = observations.filter(
    (observation) => (observation.clippedFraction ?? 0) <= MAX_PATCH_CLIPPING_FOR_FIT,
  );

  if (usable.length < required) {
    return {
      ok: false,
      reason: 'too-few-patches',
      message:
        usable.length === 0
          ? 'No usable calibration patches. The card may be blown out or in deep shadow.'
          : `Only ${usable.length} usable calibration patches; ${required} are needed. Adjust exposure so the card is neither blown out nor too dark.`,
    };
  }

  // Reference values are converted into linear light once, because that is the
  // space the fit operates in.
  const referenceLinear = usable.map((observation) => labToLinearRgb(observation.referenceLab));
  const usedIds = new Set(usable.map((observation) => observation.patchId));

  /** Fits the colour matrix, optionally normalising by a spatial field first. */
  const fitWith = (candidateField: IlluminationField | null): ColourCorrection | null => {
    const normalised = usable.map((observation) =>
      normaliseForField(observation.measuredLinear, candidateField ?? undefined, observation.position),
    );

    const matrix: number[][] = [];
    let residualSum = 0;

    for (const channel of [0, 1, 2] as const) {
      const design = normalised.map((measured) => designRow(model, measured, channel));
      const target = referenceLinear.map((linear) => [linear.r, linear.g, linear.b][channel]);

      const solved = solveLeastSquares(design, target);
      if (!solved) return null;

      matrix.push(expandCoefficients(model, solved, channel));
      const channelResidual = residualRms(design, solved, target);
      residualSum += channelResidual * channelResidual;
    }

    const draft: ColourCorrection = {
      model,
      matrix,
      ...(candidateField ? { field: candidateField } : {}),
      residualLinear: Math.sqrt(residualSum / 3),
      meanDeltaE: 0,
      maxDeltaE: 0,
      residuals: [],
      patchesUsed: usable.length,
    };

    // Evaluate in Lab, which is what matters perceptually, rather than reporting
    // the linear-light residual alone.
    const residuals: PatchResidual[] = observations.map((observation) => {
      const corrected = applyCorrection(draft, observation.measuredLinear, observation.position);
      return {
        patchId: observation.patchId,
        deltaE: deltaE2000(observation.referenceLab, linearRgbToLab(corrected)),
        usedInFit: usedIds.has(observation.patchId),
      };
    });

    const fitted = residuals.filter((r) => r.usedInFit).map((r) => r.deltaE);
    return {
      ...draft,
      residuals,
      meanDeltaE: fitted.reduce((a, b) => a + b, 0) / fitted.length,
      maxDeltaE: Math.max(...fitted),
    };
  };

  const withoutField = fitWith(null);
  if (!withoutField) {
    return {
      ok: false,
      reason: 'singular-system',
      message:
        'Calibration patches did not provide enough colour variation to solve for a correction. Make sure the whole card is visible and in focus.',
    };
  }

  if (!field) return { ok: true, correction: withoutField };

  /**
   * Decide empirically whether the spatial field earns its place.
   *
   * This replaces an earlier magnitude threshold, which was a guess and got it
   * wrong in both directions: too tight and it discarded a genuine 55% gradient,
   * too loose and it applied a partly-spurious one that nearly doubled the fit
   * error on a real card.
   *
   * The comparison is meaningful rather than circular because the field's three
   * parameters are fitted on the **six neutral patches only**, while the residual
   * below is evaluated over **all twelve**. The six chromatic patches are therefore
   * held out from the field fit, so if the gradient is real they improve too, and if
   * it is an artefact of the neutrals they get worse. Adding parameters cannot win
   * here by overfitting alone.
   *
   * An absurd magnitude is still vetoed outright: beyond that range the fit is
   * extrapolating far past the data and can distort regions between the patches
   * even while scoring well on them.
   */
  if (!field.plausible) {
    return {
      ok: true,
      correction: {
        ...withoutField,
        fieldRejected: {
          strength: field.strength,
          reason: 'implausible-magnitude',
          meanDeltaEWithField: Number.NaN,
          meanDeltaEWithoutField: withoutField.meanDeltaE,
        },
      },
    };
  }

  const withField = fitWith(field);
  if (!withField) return { ok: true, correction: withoutField };

  if (withField.meanDeltaE < withoutField.meanDeltaE) {
    return { ok: true, correction: withField };
  }

  return {
    ok: true,
    correction: {
      ...withoutField,
      fieldRejected: {
        strength: field.strength,
        reason: 'did-not-improve-fit',
        meanDeltaEWithField: withField.meanDeltaE,
        meanDeltaEWithoutField: withoutField.meanDeltaE,
      },
    },
  };
}

/**
 * Applies a fitted correction to a measured linear colour.
 *
 * When the correction carries a spatial illumination field, `position` must be
 * supplied for the correction to be complete. Omitting it falls back to the card
 * centre, which is a reasonable approximation but leaves part of the gradient
 * uncorrected — so callers reading the sample window should always pass it.
 */
export function applyCorrection(
  correction: Pick<ColourCorrection, 'matrix' | 'field'>,
  measured: LinearRgb,
  position?: CardPosition,
): LinearRgb {
  const input = normaliseForField(measured, correction.field, position);
  const m = correction.matrix;
  return {
    r: m[0][0] * input.r + m[0][1] * input.g + m[0][2] * input.b + m[0][3],
    g: m[1][0] * input.r + m[1][1] * input.g + m[1][2] * input.b + m[1][3],
    b: m[2][0] * input.r + m[2][1] * input.g + m[2][2] * input.b + m[2][3],
  };
}

/** Convenience: corrected colour expressed directly in Lab. */
export function correctToLab(
  correction: Pick<ColourCorrection, 'matrix' | 'field'>,
  measured: LinearRgb,
  position?: CardPosition,
): Lab {
  return linearRgbToLab(applyCorrection(correction, measured, position));
}

/**
 * Strength of the colour cast the correction is undoing, as the ratio between the
 * largest and smallest diagonal gain.
 *
 * Reported to the operator because a very large value means the ambient light was
 * heavily coloured. The correction still works, but the sample's own signal is
 * being recovered from a smaller share of the sensor's range, so precision is
 * lower and that is worth surfacing rather than hiding.
 */
export function correctionCastRatio(correction: Pick<ColourCorrection, 'matrix'>): number {
  const gains = [
    correction.matrix[0][0],
    correction.matrix[1][1],
    correction.matrix[2][2],
  ].map(Math.abs);
  const smallest = Math.min(...gains);
  if (smallest < 1e-9) return Number.POSITIVE_INFINITY;
  return Math.max(...gains) / smallest;
}

/** An identity correction, for the "no calibration applied" comparison path. */
export const IDENTITY_CORRECTION: ColourCorrection = {
  model: 'linear3x3',
  matrix: [
    [1, 0, 0, 0],
    [0, 1, 0, 0],
    [0, 0, 1, 0],
  ],
  residualLinear: 0,
  meanDeltaE: 0,
  maxDeltaE: 0,
  residuals: [],
  patchesUsed: 0,
};
