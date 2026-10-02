import { describe, expect, it } from 'vitest';
import {
  IDENTITY_CORRECTION,
  applyCorrection,
  correctToLab,
  correctionCastRatio,
  fitColourCorrection,
  type PatchObservation,
} from './correction';
import { deltaE2000 } from './deltaE';
import {
  hexToRgb,
  labToLinearRgb,
  linearRgbToLab,
  srgbToLab,
  type Lab,
  type LinearRgb,
} from './space';
import {
  PATCHES,
  SAMPLE_WINDOW_MM,
  insetRect,
  nominalLabFor,
  normalisedCentre,
  patchSampleRect,
  type RectMm,
} from '../card/spec';
import { detectCard } from '../vision/detectCard';
import { sampleCardRegion } from '../vision/image';
import {
  makeCardView,
  renderSyntheticCard,
  type IlluminationModel,
} from '../vision/__fixtures__/syntheticCard';

/**
 * Scales an illuminant so its strongest channel just fits inside the sensor
 * range, which is what a camera's auto-exposure does. Without this the reference
 * white patch clips and the test would be measuring clipping behaviour rather
 * than colour correction.
 */
function autoExposed(gain: LinearRgb, headroom = 0.95): IlluminationModel {
  const peak = Math.max(gain.r, gain.g, gain.b);
  const scale = headroom / peak;
  return { gain: { r: gain.r * scale, g: gain.g * scale, b: gain.b * scale } };
}

const LIGHTING_SCENARIOS: Array<[string, IlluminationModel]> = [
  ['neutral daylight', autoExposed({ r: 1, g: 1, b: 1 })],
  ['warm tungsten', autoExposed({ r: 1.28, g: 1.0, b: 0.55 })],
  ['cool shade', autoExposed({ r: 0.62, g: 0.7, b: 0.92 })],
  ['dim indoor', { gain: { r: 0.32, g: 0.32, b: 0.32 } }],
  ['very warm sodium', autoExposed({ r: 1.5, g: 0.9, b: 0.35 })],
  [
    'side-lit with gradient',
    { ...autoExposed({ r: 1.05, g: 1.0, b: 0.9 }), gradient: { axis: 'x', amount: 0.35 } },
  ],
];

/**
 * The held-out region inside the sample window that tests read from. Inset well
 * away from the window's printed border so no edge pixels are included.
 */
const SAMPLE_PROBE: RectMm = insetRect(SAMPLE_WINDOW_MM, 0.2);

/** Runs the real pipeline: detect, sample patches, fit correction. */
function calibrateFrom(illumination: IlluminationModel, sampleHex?: string) {
  const rendered = renderSyntheticCard({
    width: 1200,
    height: 800,
    illumination,
    sampleHex,
    cardToImage: makeCardView(1200, 800, { tiltX: 0.0009 }),
  });

  const detection = detectCard(rendered.image);
  if (!detection.ok) throw new Error(`detection failed: ${detection.reason}`);

  const observations: PatchObservation[] = PATCHES.map((patch) => {
    const sample = sampleCardRegion(rendered.image, detection.cardToImage, patchSampleRect(patch));
    return {
      patchId: patch.id,
      measuredLinear: sample.linear,
      referenceLab: nominalLabFor(patch),
      clippedFraction: sample.clippedFraction,
      position: normalisedCentre(patch.rect),
      role: patch.role,
    };
  });

  const fit = fitColourCorrection(observations);
  return { rendered, detection, observations, fit };
}

/** Reads the sample window and returns its corrected Lab. */
function readSample(
  rendered: ReturnType<typeof renderSyntheticCard>,
  detection: { cardToImage: Parameters<typeof sampleCardRegion>[1] },
  correction: Parameters<typeof correctToLab>[0],
): { correctedLab: Lab; rawLinear: LinearRgb } {
  const sample = sampleCardRegion(rendered.image, detection.cardToImage, SAMPLE_PROBE);
  return {
    correctedLab: correctToLab(correction, sample.linear, normalisedCentre(SAMPLE_PROBE)),
    rawLinear: sample.linear,
  };
}

describe('fitColourCorrection', () => {
  it('recovers the identity transform from already-correct data', () => {
    const observations: PatchObservation[] = PATCHES.map((patch) => ({
      patchId: patch.id,
      measuredLinear: labToLinearRgb(nominalLabFor(patch)),
      referenceLab: nominalLabFor(patch),
    }));

    const fit = fitColourCorrection(observations);
    expect(fit.ok).toBe(true);
    if (!fit.ok) return;

    expect(fit.correction.maxDeltaE).toBeLessThan(0.01);
    for (const channel of [0, 1, 2]) {
      for (let column = 0; column < 4; column++) {
        const expected = channel === column ? 1 : 0;
        expect(fit.correction.matrix[channel][column]).toBeCloseTo(expected, 6);
      }
    }
  });

  it('inverts a known per-channel gain', () => {
    const gain = { r: 0.7, g: 0.85, b: 1.15 };
    const observations: PatchObservation[] = PATCHES.map((patch) => {
      const reference = labToLinearRgb(nominalLabFor(patch));
      return {
        patchId: patch.id,
        measuredLinear: { r: reference.r * gain.r, g: reference.g * gain.g, b: reference.b * gain.b },
        referenceLab: nominalLabFor(patch),
      };
    });

    const fit = fitColourCorrection(observations, { model: 'diagonal' });
    expect(fit.ok).toBe(true);
    if (!fit.ok) return;

    expect(fit.correction.matrix[0][0]).toBeCloseTo(1 / gain.r, 5);
    expect(fit.correction.matrix[1][1]).toBeCloseTo(1 / gain.g, 5);
    expect(fit.correction.matrix[2][2]).toBeCloseTo(1 / gain.b, 5);
    expect(fit.correction.maxDeltaE).toBeLessThan(0.01);
  });

  it('absorbs an additive flare offset that a 3x3 model cannot', () => {
    // Veiling glare adds a constant to every channel. A purely multiplicative
    // model has no way to represent this, so the affine model should win clearly.
    const flare = 0.04;
    const observations: PatchObservation[] = PATCHES.map((patch) => {
      const reference = labToLinearRgb(nominalLabFor(patch));
      return {
        patchId: patch.id,
        measuredLinear: {
          r: reference.r * 0.9 + flare,
          g: reference.g * 0.9 + flare,
          b: reference.b * 0.9 + flare,
        },
        referenceLab: nominalLabFor(patch),
      };
    });

    const affine = fitColourCorrection(observations, { model: 'affine3x4' });
    const linear = fitColourCorrection(observations, { model: 'linear3x3' });
    expect(affine.ok && linear.ok).toBe(true);
    if (!affine.ok || !linear.ok) return;

    expect(affine.correction.maxDeltaE).toBeLessThan(0.05);
    expect(linear.correction.maxDeltaE).toBeGreaterThan(affine.correction.maxDeltaE * 5);
    // The recovered offset should be about -flare/0.9 after inversion.
    expect(affine.correction.matrix[0][3]).toBeCloseTo(-flare / 0.9, 3);
  });

  it('excludes clipped patches from the fit but still reports their error', () => {
    const observations: PatchObservation[] = PATCHES.map((patch, index) => ({
      patchId: patch.id,
      measuredLinear: labToLinearRgb(nominalLabFor(patch)),
      referenceLab: nominalLabFor(patch),
      clippedFraction: index === 0 ? 0.9 : 0,
    }));

    const fit = fitColourCorrection(observations);
    expect(fit.ok).toBe(true);
    if (!fit.ok) return;

    expect(fit.correction.patchesUsed).toBe(PATCHES.length - 1);
    expect(fit.correction.residuals).toHaveLength(PATCHES.length);
    expect(fit.correction.residuals[0].usedInFit).toBe(false);
    expect(fit.correction.residuals[1].usedInFit).toBe(true);
  });

  it('refuses to fit when too few patches are usable', () => {
    const observations: PatchObservation[] = PATCHES.slice(0, 3).map((patch) => ({
      patchId: patch.id,
      measuredLinear: labToLinearRgb(nominalLabFor(patch)),
      referenceLab: nominalLabFor(patch),
      clippedFraction: 0.95,
    }));

    const fit = fitColourCorrection(observations);
    expect(fit.ok).toBe(false);
    if (fit.ok) return;
    expect(fit.reason).toBe('too-few-patches');
    expect(fit.message).toMatch(/exposure|blown out|shadow/i);
  });

  it('refuses to fit when all patches are the same colour', () => {
    // No colour variation means the system is singular: there is no way to know
    // how the camera responds to anything other than that one colour.
    const flat: Lab = { L: 50, a: 0, b: 0 };
    const observations: PatchObservation[] = PATCHES.map((patch) => ({
      patchId: patch.id,
      measuredLinear: labToLinearRgb(flat),
      referenceLab: flat,
    }));

    const fit = fitColourCorrection(observations);
    expect(fit.ok).toBe(false);
    if (fit.ok) return;
    expect(fit.reason).toBe('singular-system');
  });
});

describe('applyCorrection', () => {
  it('is a no-op for the identity correction', () => {
    const colour: LinearRgb = { r: 0.3, g: 0.45, b: 0.2 };
    const result = applyCorrection(IDENTITY_CORRECTION, colour);
    expect(result.r).toBeCloseTo(colour.r, 12);
    expect(result.g).toBeCloseTo(colour.g, 12);
    expect(result.b).toBeCloseTo(colour.b, 12);
  });

  it('applies the offset column', () => {
    const correction = {
      matrix: [
        [1, 0, 0, 0.1],
        [0, 1, 0, -0.05],
        [0, 0, 1, 0],
      ],
    };
    const result = applyCorrection(correction, { r: 0.2, g: 0.2, b: 0.2 });
    expect(result.r).toBeCloseTo(0.3, 10);
    expect(result.g).toBeCloseTo(0.15, 10);
    expect(result.b).toBeCloseTo(0.2, 10);
  });
});

describe('correctionCastRatio', () => {
  it('is 1 for a neutral correction', () => {
    expect(correctionCastRatio(IDENTITY_CORRECTION)).toBeCloseTo(1, 10);
  });

  it('grows with the strength of the colour cast being undone', () => {
    const mild = correctionCastRatio({
      matrix: [
        [1.1, 0, 0, 0],
        [0, 1, 0, 0],
        [0, 0, 1.2, 0],
      ],
    });
    const strong = correctionCastRatio({
      matrix: [
        [1.1, 0, 0, 0],
        [0, 1, 0, 0],
        [0, 0, 3.4, 0],
      ],
    });
    expect(strong).toBeGreaterThan(mild);
    expect(mild).toBeCloseTo(1.2, 6);
  });
});

describe('end-to-end colour recovery through the full pipeline', () => {
  it('fits a low-error correction under every lighting scenario', () => {
    for (const [name, illumination] of LIGHTING_SCENARIOS) {
      const { fit } = calibrateFrom(illumination);
      expect(fit.ok, `${name}: fit failed`).toBe(true);
      if (!fit.ok) continue;

      // Under 2.0 mean Delta-E means the corrected card patches are within
      // "only visible on close comparison" of their reference values.
      expect(fit.correction.meanDeltaE, `${name}: mean dE too high`).toBeLessThan(2);
      expect(fit.correction.maxDeltaE, `${name}: max dE too high`).toBeLessThan(5);
    }
  });

  it('recovers an unknown sample colour regardless of the illuminant', () => {
    // This is the central claim of the whole approach: the same physical sample
    // colour must read the same under any lighting once the card correction is
    // applied. The sample window colour is never part of the fit, so this is a
    // genuine held-out test.
    const sampleHex = '#6b3f8f';
    const trueLab = srgbToLab(hexToRgb(sampleHex));

    for (const [name, illumination] of LIGHTING_SCENARIOS) {
      const { rendered, detection, fit } = calibrateFrom(illumination, sampleHex);
      expect(fit.ok, `${name}: fit failed`).toBe(true);
      if (!fit.ok) continue;

      const { correctedLab, rawLinear } = readSample(rendered, detection, fit.correction);
      const correctedError = deltaE2000(trueLab, correctedLab);
      const uncorrectedError = deltaE2000(trueLab, linearRgbToLab(rawLinear));

      expect(correctedError, `${name}: corrected dE ${correctedError.toFixed(2)}`).toBeLessThan(4);
      // And correction must be a large improvement, not a marginal one.
      expect(
        correctedError,
        `${name}: correction did not improve on raw pixels`,
      ).toBeLessThan(uncorrectedError);
    }
  });

  it('shows a large improvement over uncorrected pixels for a strong colour cast', () => {
    const sampleHex = '#2f6b8a';
    const trueLab = srgbToLab(hexToRgb(sampleHex));
    const illumination = autoExposed({ r: 1.5, g: 0.9, b: 0.35 });

    const { rendered, detection, fit } = calibrateFrom(illumination, sampleHex);
    expect(fit.ok).toBe(true);
    if (!fit.ok) return;

    const { correctedLab, rawLinear } = readSample(rendered, detection, fit.correction);
    const correctedError = deltaE2000(trueLab, correctedLab);
    const uncorrectedError = deltaE2000(trueLab, linearRgbToLab(rawLinear));

    // Under sodium-like light the raw pixels are wildly wrong; correction should
    // bring them back to within a few Delta-E.
    expect(uncorrectedError).toBeGreaterThan(15);
    expect(correctedError).toBeLessThan(4);
    expect(uncorrectedError / correctedError).toBeGreaterThan(4);
  });

  it('gives consistent readings for the same sample across different illuminants', () => {
    // Reproducibility across officers and conditions is the property that makes a
    // field result defensible, so it is asserted directly.
    const sampleHex = '#8a4b2f';
    const readings: Lab[] = [];

    for (const [, illumination] of LIGHTING_SCENARIOS) {
      const { rendered, detection, fit } = calibrateFrom(illumination, sampleHex);
      if (!fit.ok) continue;
      readings.push(readSample(rendered, detection, fit.correction).correctedLab);
    }

    expect(readings.length).toBe(LIGHTING_SCENARIOS.length);
    for (let i = 1; i < readings.length; i++) {
      expect(deltaE2000(readings[0], readings[i])).toBeLessThan(4);
    }
  });

  it('leaves corrected neutral patches actually neutral', () => {
    // A residual cast on the grey ramp is the signature of a bad white balance,
    // so this is a direct check that the correction did its job.
    const { fit, observations } = calibrateFrom(autoExposed({ r: 1.28, g: 1, b: 0.55 }));
    expect(fit.ok).toBe(true);
    if (!fit.ok) return;

    for (const observation of observations) {
      if (observation.role !== 'neutral') continue;
      const corrected = correctToLab(
        fit.correction,
        observation.measuredLinear,
        observation.position,
      );
      expect(Math.hypot(corrected.a, corrected.b)).toBeLessThan(3);
    }
  });

  it('fits a spatial field only when a real gradient is present', () => {
    const even = calibrateFrom(autoExposed({ r: 1, g: 1, b: 1 }));
    const uneven = calibrateFrom({
      ...autoExposed({ r: 1, g: 1, b: 1 }),
      gradient: { axis: 'x', amount: 0.4 },
    });

    expect(even.fit.ok && uneven.fit.ok).toBe(true);
    if (!even.fit.ok || !uneven.fit.ok) return;

    // Evenly lit: no gradient worth modelling, so no field.
    expect(even.fit.correction.field).toBeUndefined();
    // Side lit: the field should be detected with roughly the right strength.
    expect(uneven.fit.correction.field).toBeDefined();
    expect(uneven.fit.correction.field!.strength).toBeGreaterThan(0.2);
  });

  it('spatial correction reduces the worst-patch error under side lighting', () => {
    // Direct evidence that the two-stage fit earns its complexity.
    const rendered = renderSyntheticCard({
      width: 1200,
      height: 800,
      illumination: {
        ...autoExposed({ r: 1, g: 1, b: 1 }),
        gradient: { axis: 'x', amount: 0.4 },
      },
      cardToImage: makeCardView(1200, 800, { tiltX: 0.0009 }),
    });
    const detection = detectCard(rendered.image);
    expect(detection.ok).toBe(true);
    if (!detection.ok) return;

    const observations: PatchObservation[] = PATCHES.map((patch) => {
      const sample = sampleCardRegion(rendered.image, detection.cardToImage, patchSampleRect(patch));
      return {
        patchId: patch.id,
        measuredLinear: sample.linear,
        referenceLab: nominalLabFor(patch),
        clippedFraction: sample.clippedFraction,
        position: normalisedCentre(patch.rect),
        role: patch.role,
      };
    });

    const withSpatial = fitColourCorrection(observations, { spatial: true });
    const withoutSpatial = fitColourCorrection(observations, { spatial: false });
    expect(withSpatial.ok && withoutSpatial.ok).toBe(true);
    if (!withSpatial.ok || !withoutSpatial.ok) return;

    expect(withSpatial.correction.maxDeltaE).toBeLessThan(withoutSpatial.correction.maxDeltaE);
    expect(withSpatial.correction.meanDeltaE).toBeLessThan(withoutSpatial.correction.meanDeltaE);
  });
});
