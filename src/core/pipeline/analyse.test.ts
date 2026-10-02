import { describe, expect, it } from 'vitest';
import { analyseCapture, uncorrectedSampleLab } from './analyse';
import { MIN_FOCUS_SCORE, primaryRejection } from './quality';
import { findPanel } from '../classify/panels';
import { deltaE2000 } from '../color/deltaE';
import { hexToRgb, srgbToLab } from '../color/space';
import { CARD_HEIGHT_MM, CARD_WIDTH_MM } from '../card/spec';
import type { RgbaImage } from '../vision/image';
import {
  makeCardView,
  renderSyntheticCard,
  type IlluminationModel,
  type SyntheticCardOptions,
} from '../vision/__fixtures__/syntheticCard';

const marquis = findPanel('marquis')!;
const cobalt = findPanel('cobalt-thiocyanate')!;

/** Scales an illuminant so its strongest channel just fits the sensor range. */
function autoExposed(
  gain: { r: number; g: number; b: number },
  headroom = 0.95,
): IlluminationModel {
  const peak = Math.max(gain.r, gain.g, gain.b);
  const scale = headroom / peak;
  return { gain: { r: gain.r * scale, g: gain.g * scale, b: gain.b * scale } };
}

const NEUTRAL_LIGHT = autoExposed({ r: 1, g: 1, b: 1 });

function capture(options: SyntheticCardOptions = {}) {
  const rendered = renderSyntheticCard({
    width: 1400,
    height: 950,
    illumination: NEUTRAL_LIGHT,
    ...options,
  });
  return { rendered, result: analyseCapture(rendered.image, { panel: marquis }) };
}

function blankFrame(width: number, height: number, level = 120): RgbaImage {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = level;
    data[i * 4 + 1] = level;
    data[i * 4 + 2] = level - 3;
    data[i * 4 + 3] = 255;
  }
  return { width, height, data };
}

describe('analyseCapture — successful captures', () => {
  it('reads a purple sample as consistent with opiates', () => {
    const { result } = capture({ sampleHex: '#5a2a6e' });

    expect(result.ok).toBe(true);
    expect(result.stage).toBe('complete');
    expect(result.classification.outcomeId).toBe('marquis-purple');
    expect(result.classification.category).toBe('positive');
    expect(result.classification.associatedSubstances).toContain('morphine');
  });

  it('reads an unreacted sample as negative', () => {
    const { result } = capture({ sampleHex: '#efe7c8' });
    expect(result.ok).toBe(true);
    expect(result.classification.category).toBe('negative');
    expect(result.classification.outcomeId).toBe('marquis-no-reaction');
  });

  it('reads an orange-brown sample as consistent with amphetamine-type substances', () => {
    const { result } = capture({ sampleHex: '#b06a24' });
    expect(result.ok).toBe(true);
    expect(result.classification.outcomeId).toBe('marquis-orange-brown');
  });

  it('returns inconclusive for a colour no reagent outcome explains', () => {
    // A clean, well-lit capture of a colour that is simply not on the panel must
    // still refuse to answer rather than snapping to the nearest bucket.
    const { result } = capture({ sampleHex: '#00c853' });
    expect(result.ok).toBe(true);
    expect(result.classification.category).toBe('inconclusive');
    expect(result.classification.inconclusiveReason).toBe('no-reference-match');
  });

  it('recovers the sample colour to within a few Delta-E of truth', () => {
    const sampleHex = '#5a2a6e';
    const { result } = capture({ sampleHex });
    expect(result.sampleLab).toBeDefined();
    expect(deltaE2000(srgbToLab(hexToRgb(sampleHex)), result.sampleLab!)).toBeLessThan(4);
  });

  it('produces a rectified card image of the right shape', () => {
    const { result } = capture({ sampleHex: '#5a2a6e' });
    expect(result.rectifiedCard).toBeDefined();
    const aspect = result.rectifiedCard!.width / result.rectifiedCard!.height;
    expect(aspect).toBeCloseTo(CARD_WIDTH_MM / CARD_HEIGHT_MM, 1);
  });

  it('reports one reading per calibration patch', () => {
    const { result } = capture({ sampleHex: '#5a2a6e' });
    expect(result.patchReadings).toHaveLength(12);
    for (const reading of result.patchReadings!) {
      expect(reading.correctedLab).not.toBeNull();
      expect(reading.sample.sampleCount).toBeGreaterThan(50);
    }
  });

  it('warns that calibration is nominal rather than measured', () => {
    // Intellectual honesty surfaced to the operator: results are comparable
    // between captures, but absolute accuracy is unverified until the printed card
    // is measured.
    const { result } = capture({ sampleHex: '#5a2a6e' });
    const codes = result.quality!.issues.map((issue) => issue.code);
    expect(codes).toContain('calibration-not-measured');
    // A warning must not block the capture.
    expect(result.ok).toBe(true);
  });

  it('always requires laboratory confirmation', () => {
    const { result } = capture({ sampleHex: '#5a2a6e' });
    expect(result.classification.requiresLaboratoryConfirmation).toBe(true);
  });
});

describe('analyseCapture — lighting invariance', () => {
  it('reaches the same verdict for the same sample under very different light', () => {
    // The property that makes a field result defensible across officers, times of
    // day and locations.
    const sampleHex = '#5a2a6e';
    const scenarios: Array<[string, IlluminationModel]> = [
      ['neutral', NEUTRAL_LIGHT],
      ['tungsten', autoExposed({ r: 1.28, g: 1, b: 0.55 })],
      ['shade', autoExposed({ r: 0.62, g: 0.7, b: 0.92 })],
      ['sodium', autoExposed({ r: 1.5, g: 0.9, b: 0.35 })],
      ['dim', { gain: { r: 0.32, g: 0.32, b: 0.32 } }],
    ];

    for (const [name, illumination] of scenarios) {
      const rendered = renderSyntheticCard({
        width: 1400,
        height: 950,
        illumination,
        sampleHex,
      });
      const result = analyseCapture(rendered.image, { panel: marquis });
      expect(result.ok, `${name}: capture refused`).toBe(true);
      expect(result.classification.outcomeId, `${name}: wrong outcome`).toBe('marquis-purple');
    }
  });

  it('shows that correction is what makes the reading correct', () => {
    // Under a strong cast the raw pixels are far from truth; corrected they are
    // close. This is the difference the reference card buys.
    const sampleHex = '#5a2a6e';
    const rendered = renderSyntheticCard({
      width: 1400,
      height: 950,
      illumination: autoExposed({ r: 1.5, g: 0.9, b: 0.35 }),
      sampleHex,
    });
    const result = analyseCapture(rendered.image, { panel: marquis });
    expect(result.ok).toBe(true);

    const truth = srgbToLab(hexToRgb(sampleHex));
    const corrected = deltaE2000(truth, result.sampleLab!);
    const raw = deltaE2000(truth, uncorrectedSampleLab(result)!);

    expect(raw).toBeGreaterThan(10);
    expect(corrected).toBeLessThan(4);
  });

  it('tolerates uneven lighting but says so', () => {
    const { result } = capture({
      sampleHex: '#5a2a6e',
      illumination: { ...NEUTRAL_LIGHT, gradient: { axis: 'x', amount: 0.55 } },
    });

    expect(result.ok).toBe(true);
    expect(result.classification.outcomeId).toBe('marquis-purple');
    expect(result.quality!.issues.map((i) => i.code)).toContain('uneven-lighting-across-card');
  });
});

describe('analyseCapture — geometry tolerance', () => {
  it('handles a mildly tilted view', () => {
    const { result } = capture({
      sampleHex: '#5a2a6e',
      cardToImage: makeCardView(1400, 950, { tiltX: 0.0015, tiltY: 0.0008 }),
    });
    expect(result.ok).toBe(true);
    expect(result.classification.outcomeId).toBe('marquis-purple');
  });

  it('handles a moderately tilted view', () => {
    const { result } = capture({
      sampleHex: '#5a2a6e',
      cardToImage: makeCardView(1400, 950, { tiltX: 0.003, tiltY: 0.0015 }),
    });
    expect(result.ok).toBe(true);
    expect(result.quality!.metrics.greyRampInversions).toBe(0);
    expect(result.classification.outcomeId).toBe('marquis-purple');
  });

  it('handles a rotated card', () => {
    const rendered = renderSyntheticCard({
      width: 1100,
      height: 1100,
      illumination: NEUTRAL_LIGHT,
      sampleHex: '#5a2a6e',
      cardToImage: makeCardView(1100, 1100, { rotationDeg: 20, marginFraction: 0.1 }),
    });
    const result = analyseCapture(rendered.image, { panel: marquis });
    expect(result.ok).toBe(true);
    expect(result.classification.outcomeId).toBe('marquis-purple');
  });

  it('refuses a very oblique view', () => {
    const { result } = capture({
      sampleHex: '#5a2a6e',
      cardToImage: makeCardView(1400, 950, { tiltX: 0.0045, tiltY: 0.002 }),
    });
    expect(result.ok).toBe(false);
    expect(result.classification.category).toBe('inconclusive');
  });
});

describe('analyseCapture — refusals', () => {
  it('refuses when no card is present, and still returns a recordable result', () => {
    const result = analyseCapture(blankFrame(800, 600), { panel: marquis });

    expect(result.ok).toBe(false);
    expect(result.stage).toBe('detection');
    // The attempt is still a loggable event: "a test was attempted and could not
    // be read" is materially different from "no test was attempted".
    expect(result.classification.category).toBe('inconclusive');
    expect(result.classification.inconclusiveReason).toBe('capture-rejected');
    expect(result.rejectionMessage).toMatch(/reference card/i);
  });

  it('refuses a badly defocused capture', () => {
    const { result } = capture({ sampleHex: '#5a2a6e', blurRadius: 5 });
    expect(result.ok).toBe(false);
    expect(result.stage).toBe('quality');
    expect(primaryRejection(result.quality!)!.code).toBe('out-of-focus');
    expect(result.quality!.metrics.focusScore).toBeLessThan(MIN_FOCUS_SCORE);
  });

  it('accepts a mildly soft capture, because it does not harm the measurement', () => {
    // Patch colours are read from patch interiors, so moderate blur leaves the
    // colour measurement intact. Rejecting it would frustrate the operator for no
    // accuracy benefit.
    const { result } = capture({ sampleHex: '#5a2a6e', blurRadius: 2 });
    expect(result.ok).toBe(true);
    expect(result.classification.outcomeId).toBe('marquis-purple');
  });

  it('refuses a blown-out capture', () => {
    const { result } = capture({
      sampleHex: '#5a2a6e',
      illumination: { gain: { r: 2.6, g: 2.6, b: 2.6 } },
    });
    expect(result.ok).toBe(false);
    expect(result.quality!.issues.map((i) => i.code)).toContain('overexposed');
  });

  it('refuses a capture that is far too dark', () => {
    const { result } = capture({
      sampleHex: '#5a2a6e',
      illumination: { gain: { r: 0.05, g: 0.05, b: 0.05 } },
    });
    expect(result.ok).toBe(false);
    expect(result.quality!.issues.map((i) => i.code)).toContain('underexposed');
  });

  it('refuses when the card is too small in frame to measure', () => {
    const { result } = capture({
      sampleHex: '#5a2a6e',
      cardToImage: makeCardView(1400, 950, { marginFraction: 0.36 }),
    });
    expect(result.ok).toBe(false);
    expect(result.quality!.issues.map((i) => i.code)).toContain('card-too-small');
  });

  it('gives every rejection an actionable operator message', () => {
    const failures = [
      analyseCapture(blankFrame(800, 600), { panel: marquis }),
      capture({ sampleHex: '#5a2a6e', blurRadius: 5 }).result,
      capture({
        sampleHex: '#5a2a6e',
        illumination: { gain: { r: 2.6, g: 2.6, b: 2.6 } },
      }).result,
    ];

    for (const result of failures) {
      expect(result.ok).toBe(false);
      expect(result.rejectionMessage, 'missing rejection message').toBeTruthy();
      // Should describe a physical action, not an error code.
      expect(result.rejectionMessage!.length).toBeGreaterThan(20);
      expect(result.classification.requiresLaboratoryConfirmation).toBe(true);
    }
  });
});

describe('analyseCapture — advisory-only gates', () => {
  const ADVISORY_ONLY = new Set([
    'uneven-patch-illumination',
    'sample-area-not-uniform',
    'correction-poor-fit',
  ]);

  // Heavy sensor noise inflates within-patch and sample-area variance, which is
  // exactly what the advisory-only texture/lighting gates measure. In a fully-tuned
  // build these might block; in this prototype they inform without blocking.
  const noisy: SyntheticCardOptions = {
    sampleHex: '#5a2a6e',
    noiseAmplitude: 0.14,
    seed: 7,
  };

  it('does not reject a noisy capture, since the texture gates are advisory', () => {
    const rendered = renderSyntheticCard({
      width: 1400,
      height: 950,
      illumination: NEUTRAL_LIGHT,
      ...noisy,
    });
    const result = analyseCapture(rendered.image, { panel: marquis });

    expect(result.ok).toBe(true);
    // Nothing that blocked is in the advisory-only set — i.e. no reject came from one.
    const rejectCodes = result
      .quality!.issues.filter((i) => i.severity === 'reject')
      .map((i) => i.code);
    expect(rejectCodes.length).toBe(0);
  });

  it('still reports the advisory-only gates as warnings, with their numbers', () => {
    const rendered = renderSyntheticCard({
      width: 1400,
      height: 950,
      illumination: NEUTRAL_LIGHT,
      ...noisy,
    });
    const result = analyseCapture(rendered.image, { panel: marquis });

    const advisories = result.quality!.issues.filter((i) => ADVISORY_ONLY.has(i.code));
    // At least one of the texture/lighting gates tripped and was reported.
    expect(advisories.length).toBeGreaterThan(0);
    // Reported as advisory, never as a blocker, and still carrying the measured value.
    for (const issue of advisories) {
      expect(issue.severity).toBe('warn');
      expect(issue.measured).toBeDefined();
    }
  });

  it('still rejects a fatal gate — advisory status never extends to those', () => {
    // A blown-out frame fails on overexposure, which is not an advisory-only gate.
    // No stage of maturity makes a meaningless reading acceptable.
    const rendered = renderSyntheticCard({
      width: 1400,
      height: 950,
      illumination: { gain: { r: 2.6, g: 2.6, b: 2.6 } },
      sampleHex: '#5a2a6e',
    });
    const result = analyseCapture(rendered.image, { panel: marquis });

    expect(result.ok).toBe(false);
    expect(result.quality!.issues.map((i) => i.code)).toContain('overexposed');
  });
});

describe('analyseCapture — panel selection', () => {
  it('classifies the same capture against whichever reagent panel is selected', () => {
    // The sample is cobalt-blue: positive on the cobalt panel, and not a Marquis
    // outcome at all.
    const rendered = renderSyntheticCard({
      width: 1400,
      height: 950,
      illumination: NEUTRAL_LIGHT,
      sampleHex: '#1f4fa8',
    });

    const asCobalt = analyseCapture(rendered.image, { panel: cobalt });
    expect(asCobalt.ok).toBe(true);
    expect(asCobalt.classification.outcomeId).toBe('cobalt-blue');
    expect(asCobalt.classification.category).toBe('positive');

    const asMarquis = analyseCapture(rendered.image, { panel: marquis });
    expect(asMarquis.classification.category).toBe('inconclusive');
    expect(asMarquis.classification.panelId).toBe('marquis');
  });
});
