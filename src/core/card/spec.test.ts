import { describe, expect, it } from 'vitest';
import {
  CARD_HEIGHT_MM,
  CARD_MARGIN_MM,
  CARD_SPEC_VERSION,
  CARD_WIDTH_MM,
  CHROMATIC_PATCH_SPECS,
  FIDUCIALS,
  FIDUCIAL_CENTRES_MM,
  FIDUCIAL_RECT_ASPECT,
  NEUTRAL_PATCHES,
  NEUTRAL_RAMP,
  NOMINAL_CALIBRATION,
  PATCHES,
  SAMPLE_WINDOW_MM,
  isFullyMeasured,
  nominalLabFor,
  normalisedCentre,
  patchSampleRect,
  referenceLabFor,
  type CardCalibration,
  type RectMm,
} from './spec';

function overlaps(a: RectMm, b: RectMm): boolean {
  return (
    a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
  );
}

function withinCard(rect: RectMm): boolean {
  return (
    rect.x >= CARD_MARGIN_MM - 1e-9 &&
    rect.y >= CARD_MARGIN_MM - 1e-9 &&
    rect.x + rect.width <= CARD_WIDTH_MM - CARD_MARGIN_MM + 1e-9 &&
    rect.y + rect.height <= CARD_HEIGHT_MM - CARD_MARGIN_MM + 1e-9
  );
}

describe('card geometry', () => {
  it('has a stable spec version', () => {
    // A change here means previously captured records refer to a different
    // physical card, and any already-printed card must be reprinted. This constant
    // should only ever change deliberately.
    expect(CARD_SPEC_VERSION).toBe('drishti-card-3');
  });

  it('places every patch inside the printable area', () => {
    for (const patch of PATCHES) {
      expect(withinCard(patch.rect), `${patch.id} outside card`).toBe(true);
    }
  });

  it('never overlaps two patches', () => {
    for (let i = 0; i < PATCHES.length; i++) {
      for (let j = i + 1; j < PATCHES.length; j++) {
        expect(
          overlaps(PATCHES[i].rect, PATCHES[j].rect),
          `${PATCHES[i].id} overlaps ${PATCHES[j].id}`,
        ).toBe(false);
      }
    }
  });

  it('keeps every patch clear of the fiducial markers', () => {
    // An overlap here would be silently catastrophic: the black marker would bleed
    // into a calibration patch and skew the entire correction matrix.
    for (const patch of PATCHES) {
      for (const fiducial of FIDUCIALS) {
        expect(
          overlaps(patch.rect, fiducial.rect),
          `${patch.id} overlaps ${fiducial.corner} fiducial`,
        ).toBe(false);
      }
    }
  });

  it('has exactly one fiducial carrying the orientation key', () => {
    const keyed = FIDUCIALS.filter((f) => f.hasOrientationKey);
    expect(keyed).toHaveLength(1);
    expect(keyed[0].corner).toBe('topLeft');
  });

  it('orders fiducial centres clockwise from the top left', () => {
    expect(FIDUCIAL_CENTRES_MM).toHaveLength(4);
    const [tl, tr, br, bl] = FIDUCIAL_CENTRES_MM;
    expect(tl.x).toBeLessThan(tr.x);
    expect(tl.y).toBeCloseTo(tr.y, 9);
    expect(br.x).toBeCloseTo(tr.x, 9);
    expect(br.y).toBeGreaterThan(tr.y);
    expect(bl.x).toBeCloseTo(tl.x, 9);
    expect(bl.y).toBeCloseTo(br.y, 9);
  });

  it('has a landscape fiducial rectangle, which resolves 90-degree ambiguity', () => {
    expect(FIDUCIAL_RECT_ASPECT).toBeGreaterThan(1.5);
    expect(FIDUCIAL_RECT_ASPECT).toBeCloseTo(75.9 / 41, 6);
  });

  it('splits patches evenly between neutral and chromatic roles', () => {
    expect(NEUTRAL_PATCHES).toHaveLength(6);
    expect(CHROMATIC_PATCH_SPECS).toHaveLength(6);
    expect(PATCHES).toHaveLength(12);
  });

  it('provides enough patches to over-determine a 4-parameter per-channel fit', () => {
    // The colour correction solves for 4 coefficients per channel, so 12
    // observations gives a comfortable margin.
    expect(PATCHES.length).toBeGreaterThan(4);
  });

  it('gives every patch a unique id', () => {
    expect(new Set(PATCHES.map((p) => p.id)).size).toBe(PATCHES.length);
  });

  it('brackets the sample window with a patch row above and below', () => {
    const sampleTop = SAMPLE_WINDOW_MM.y;
    const sampleBottom = SAMPLE_WINDOW_MM.y + SAMPLE_WINDOW_MM.height;

    const rowA = PATCHES.filter((p) => p.row === 'A');
    const rowB = PATCHES.filter((p) => p.row === 'B');
    expect(rowA).toHaveLength(6);
    expect(rowB).toHaveLength(6);

    for (const patch of rowA) {
      expect(patch.rect.y + patch.rect.height).toBeLessThanOrEqual(sampleTop);
    }
    for (const patch of rowB) {
      expect(patch.rect.y).toBeGreaterThanOrEqual(sampleBottom);
    }
  });

  it('keeps the sample window clear of all patches and markers', () => {
    for (const patch of PATCHES) {
      expect(overlaps(SAMPLE_WINDOW_MM, patch.rect), `sample window hits ${patch.id}`).toBe(false);
    }
    for (const fiducial of FIDUCIALS) {
      expect(
        overlaps(SAMPLE_WINDOW_MM, fiducial.rect),
        `sample window hits ${fiducial.corner}`,
      ).toBe(false);
    }
    expect(withinCard(SAMPLE_WINDOW_MM)).toBe(true);
  });

  it('spreads the neutral patches across both rows and several columns', () => {
    // This is the property that makes the illumination-plane fit solvable: the
    // neutrals must vary in both axes. All-in-one-row would be rank deficient.
    const positions = NEUTRAL_PATCHES.map((p) => normalisedCentre(p.rect));
    const distinctV = new Set(positions.map((p) => p.v.toFixed(4)));
    const distinctU = new Set(positions.map((p) => p.u.toFixed(4)));

    expect(distinctV.size).toBeGreaterThanOrEqual(2);
    expect(distinctU.size).toBeGreaterThanOrEqual(3);

    // And the vertical spread must be wide enough to interpolate the sample.
    const vs = positions.map((p) => p.v);
    const sampleV = normalisedCentre(SAMPLE_WINDOW_MM).v;
    expect(Math.min(...vs)).toBeLessThan(sampleV);
    expect(Math.max(...vs)).toBeGreaterThan(sampleV);
  });

  it('does not correlate neutral lightness with horizontal position', () => {
    /**
     * The confound that broke a real capture. Laying the neutrals out in
     * descending lightness left to right makes the printer's tone response
     * mathematically indistinguishable from a horizontal brightness gradient, so
     * the illumination fit attributes tone error to space and invents a gradient
     * that is not there.
     *
     * Compares the level/position covariance against the worst case (a perfectly
     * monotonic arrangement) and requires it to be a small fraction of it.
     */
    const neutrals = NEUTRAL_PATCHES.map((patch) => ({
      u: normalisedCentre(patch.rect).u,
      level: Number(patch.label),
    }));

    const covariance = (points: Array<{ u: number; level: number }>) => {
      const meanU = points.reduce((sum, p) => sum + p.u, 0) / points.length;
      const meanLevel = points.reduce((sum, p) => sum + p.level, 0) / points.length;
      return (
        points.reduce((sum, p) => sum + (p.u - meanU) * (p.level - meanLevel), 0) / points.length
      );
    };

    const sortedU = [...neutrals].map((p) => p.u).sort((a, b) => a - b);
    const descendingLevels = [...neutrals].map((p) => p.level).sort((a, b) => b - a);
    const worstCase = covariance(sortedU.map((u, i) => ({ u, level: descendingLevels[i] })));

    const actual = covariance(neutrals);
    expect(Math.abs(actual)).toBeLessThan(Math.abs(worstCase) * 0.15);
  });

  it('keeps the two rows close in mean neutral lightness', () => {
    // Otherwise lightness is confounded with the vertical axis instead.
    const meanLevel = (row: 'A' | 'B') => {
      const levels = NEUTRAL_PATCHES.filter((p) => p.row === row).map((p) => Number(p.label));
      return levels.reduce((sum, level) => sum + level, 0) / levels.length;
    };
    expect(Math.abs(meanLevel('A') - meanLevel('B'))).toBeLessThan(40);
  });

  it('interleaves neutral and chromatic patches within each row', () => {
    for (const row of ['A', 'B'] as const) {
      const roles = PATCHES.filter((p) => p.row === row).map((p) => p.role);
      expect(new Set(roles).size).toBe(2);
    }
  });

  it('aligns both patch rows on the same x grid', () => {
    const rowA = PATCHES.filter((p) => p.row === 'A');
    const rowB = PATCHES.filter((p) => p.row === 'B');
    for (let i = 0; i < 6; i++) {
      expect(rowB[i].rect.x).toBeCloseTo(rowA[i].rect.x, 9);
      expect(rowB[i].rect.width).toBeCloseTo(rowA[i].rect.width, 9);
    }
  });

  it('keeps every patch clearly oblong so none can pass as a square marker', () => {
    // The detector accepts blobs up to an aspect of 1.5 as candidate markers.
    // Every calibration patch must sit outside that window by a clear margin,
    // otherwise a patch can be selected as a corner and the whole homography is
    // silently wrong.
    for (const patch of PATCHES) {
      const aspect = patch.rect.width / patch.rect.height;
      expect(aspect, `${patch.id} is too close to square`).toBeGreaterThan(1.6);
    }
  });

  it('orders the neutral ramp lightest to darkest', () => {
    const levels = NEUTRAL_RAMP.map((p) => Number(p.label));
    for (let i = 1; i < levels.length; i++) {
      expect(levels[i]).toBeLessThan(levels[i - 1]);
    }
    expect(NEUTRAL_RAMP).toHaveLength(6);
  });
});

describe('patchSampleRect', () => {
  it('is strictly inside its patch', () => {
    for (const patch of PATCHES) {
      const sample = patchSampleRect(patch);
      expect(sample.x).toBeGreaterThan(patch.rect.x);
      expect(sample.y).toBeGreaterThan(patch.rect.y);
      expect(sample.x + sample.width).toBeLessThan(patch.rect.x + patch.rect.width);
      expect(sample.y + sample.height).toBeLessThan(patch.rect.y + patch.rect.height);
    }
  });

  it('stays large enough to average a meaningful number of pixels', () => {
    // At a typical capture where the 88.9 mm card spans ~1000 px, 1 mm is ~11 px,
    // so a 6 x 3.7 mm sample window is several thousand pixels.
    for (const patch of PATCHES) {
      const sample = patchSampleRect(patch);
      expect(sample.width).toBeGreaterThan(3);
      expect(sample.height).toBeGreaterThan(2);
    }
  });

  it('is concentric with its patch', () => {
    for (const patch of PATCHES) {
      const sample = patchSampleRect(patch);
      expect(sample.x + sample.width / 2).toBeCloseTo(patch.rect.x + patch.rect.width / 2, 9);
      expect(sample.y + sample.height / 2).toBeCloseTo(patch.rect.y + patch.rect.height / 2, 9);
    }
  });
});

describe('nominal reference values', () => {
  it('makes the neutral ramp monotonically darker with neutral chroma', () => {
    const labs = NEUTRAL_RAMP.map(nominalLabFor);
    for (let i = 1; i < labs.length; i++) {
      expect(labs[i].L).toBeLessThan(labs[i - 1].L);
    }
    for (const lab of labs) {
      expect(Math.abs(lab.a)).toBeLessThan(1e-6);
      expect(Math.abs(lab.b)).toBeLessThan(1e-6);
    }
  });

  it('spans a wide lightness range so the tone response is constrained', () => {
    const labs = NEUTRAL_RAMP.map(nominalLabFor);
    const lightest = labs[0].L;
    const darkest = labs[labs.length - 1].L;

    // Bright enough to anchor the top of the tone curve...
    expect(lightest).toBeGreaterThan(84);
    // ...but far enough below paper white to survive a card printer. See the note
    // on NEUTRAL_LEVELS_8BIT: a 6% tint (level 240, L*95) did not print at all on
    // PVC, so the ceiling here is a real manufacturing constraint, not a style
    // preference. L*90 corresponds to roughly a 10% tint.
    expect(lightest).toBeLessThan(90);

    expect(darkest).toBeLessThan(30);
    expect(lightest - darkest).toBeGreaterThan(60);
  });

  it('spaces the neutral steps evenly in L*, not in code value', () => {
    /**
     * The tone-response fit weights every neutral equally, so the steps should be
     * equally informative. Even 8-bit spacing is not: sRGB encoding is non-linear,
     * and the old [240, 214, 173, 132, 91, 50] ladder ranged from a 5.6 L* step at
     * the light end to 17.6 L* at the dark end — a 3.1x spread that left both ends
     * of the curve under-sampled relative to the middle.
     */
    const labs = NEUTRAL_RAMP.map(nominalLabFor);
    const steps = labs.slice(1).map((lab, i) => labs[i].L - lab.L);

    for (const step of steps) {
      expect(step).toBeGreaterThan(0);
    }
    expect(Math.max(...steps) / Math.min(...steps)).toBeLessThan(1.25);
  });

  it('gives every neutral patch a printable, non-white target', () => {
    for (const patch of NEUTRAL_RAMP) {
      expect(patch.nominalHex, `${patch.id} is pure white`).not.toBe('#ffffff');

      // Every neutral must be at least a 10% tint. Below roughly 8% coverage a
      // dye-sublimation card printer's thermal head does not transfer enough dye to
      // register, and the patch is absent from the printed card.
      const level = Number(patch.label);
      expect(level, `${patch.id} is too faint to print reliably`).toBeLessThanOrEqual(230);
    }
  });

  it('spreads the chromatic patches around the hue circle', () => {
    const hues = CHROMATIC_PATCH_SPECS.map((patch) => {
      const lab = nominalLabFor(patch);
      let h = (Math.atan2(lab.b, lab.a) * 180) / Math.PI;
      if (h < 0) h += 360;
      return h;
    }).sort((a, b) => a - b);

    // Every patch should be genuinely chromatic.
    for (const patch of CHROMATIC_PATCH_SPECS) {
      const lab = nominalLabFor(patch);
      expect(Math.hypot(lab.a, lab.b)).toBeGreaterThan(15);
    }

    // No two patches should crowd the same hue, otherwise they contribute
    // redundant information to the fit.
    for (let i = 1; i < hues.length; i++) {
      expect(hues[i] - hues[i - 1]).toBeGreaterThan(20);
    }
  });

  it('keeps chromatic patches at moderate saturation so a card printer can hit them', () => {
    for (const patch of CHROMATIC_PATCH_SPECS) {
      const lab = nominalLabFor(patch);
      // Fully saturated sRGB primaries reach chroma above 100; staying under 70
      // keeps these inside a typical CMYK gamut.
      expect(Math.hypot(lab.a, lab.b)).toBeLessThan(70);
    }
  });
});

describe('calibration provenance', () => {
  it('defaults to nominal and says so', () => {
    expect(NOMINAL_CALIBRATION.provenance).toBe('nominal');
    expect(NOMINAL_CALIBRATION.patches).toBeUndefined();
  });

  it('falls back to nominal values when no measurement exists', () => {
    const patch = PATCHES[0];
    expect(referenceLabFor(patch, NOMINAL_CALIBRATION)).toEqual(nominalLabFor(patch));
  });

  it('prefers a measured value when one is supplied', () => {
    const patch = PATCHES[0];
    const measuredLab = { L: 96.2, a: -0.4, b: 1.1 };
    const calibration: CardCalibration = {
      cardSpecVersion: CARD_SPEC_VERSION,
      provenance: 'measured',
      patches: [{ patchId: patch.id, lab: measuredLab }],
    };
    expect(referenceLabFor(patch, calibration)).toEqual(measuredLab);
    // Patches without measurements still fall back rather than throwing.
    expect(referenceLabFor(PATCHES[1], calibration)).toEqual(nominalLabFor(PATCHES[1]));
  });

  it('treats a partially measured calibration as not fully measured', () => {
    const calibration: CardCalibration = {
      cardSpecVersion: CARD_SPEC_VERSION,
      provenance: 'measured',
      patches: [{ patchId: PATCHES[0].id, lab: { L: 96, a: 0, b: 0 } }],
    };
    expect(isFullyMeasured(calibration)).toBe(false);
  });

  it('recognises a complete measured calibration', () => {
    const calibration: CardCalibration = {
      cardSpecVersion: CARD_SPEC_VERSION,
      provenance: 'measured',
      patches: PATCHES.map((patch) => ({ patchId: patch.id, lab: nominalLabFor(patch) })),
    };
    expect(isFullyMeasured(calibration)).toBe(true);
  });

  it('never reports a nominal calibration as fully measured', () => {
    expect(isFullyMeasured(NOMINAL_CALIBRATION)).toBe(false);
  });
});
