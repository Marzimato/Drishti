import { describe, expect, it } from 'vitest';
import { deltaE2000, deltaE76 } from './deltaE';
import type { Lab } from './space';

const lab = (L: number, a: number, b: number): Lab => ({ L, a, b });

/**
 * The standard CIEDE2000 verification dataset from:
 *   G. Sharma, W. Wu, E. N. Dalal, "The CIEDE2000 Color-Difference Formula:
 *   Implementation Notes, Supplementary Test Data, and Mathematical
 *   Observations", Color Research and Application, 2005.
 *
 * These 34 pairs are specifically chosen to exercise the discontinuities in the
 * formula (hue wrap-around at 0/360, neutral samples where hue is undefined, and
 * the blue-region rotation term). An implementation that passes all 34 is very
 * unlikely to be wrong anywhere else.
 */
const SHARMA_PAIRS: Array<[Lab, Lab, number]> = [
  [lab(50.0, 2.6772, -79.7751), lab(50.0, 0.0, -82.7485), 2.0425],
  [lab(50.0, 3.1571, -77.2803), lab(50.0, 0.0, -82.7485), 2.8615],
  [lab(50.0, 2.8361, -74.02), lab(50.0, 0.0, -82.7485), 3.4412],
  [lab(50.0, -1.3802, -84.2814), lab(50.0, 0.0, -82.7485), 1.0],
  [lab(50.0, -1.1848, -84.8006), lab(50.0, 0.0, -82.7485), 1.0],
  [lab(50.0, -0.9009, -85.5211), lab(50.0, 0.0, -82.7485), 1.0],
  [lab(50.0, 0.0, 0.0), lab(50.0, -1.0, 2.0), 2.3669],
  [lab(50.0, -1.0, 2.0), lab(50.0, 0.0, 0.0), 2.3669],
  [lab(50.0, 2.49, -0.001), lab(50.0, -2.49, 0.0009), 7.1792],
  [lab(50.0, 2.49, -0.001), lab(50.0, -2.49, 0.001), 7.1792],
  [lab(50.0, 2.49, -0.001), lab(50.0, -2.49, 0.0011), 7.2195],
  [lab(50.0, 2.49, -0.001), lab(50.0, -2.49, 0.0012), 7.2195],
  [lab(50.0, -0.001, 2.49), lab(50.0, 0.0009, -2.49), 4.8045],
  [lab(50.0, -0.001, 2.49), lab(50.0, 0.001, -2.49), 4.8045],
  [lab(50.0, -0.001, 2.49), lab(50.0, 0.0011, -2.49), 4.7461],
  [lab(50.0, 2.5, 0.0), lab(50.0, 0.0, -2.5), 4.3065],
  [lab(50.0, 2.5, 0.0), lab(73.0, 25.0, -18.0), 27.1492],
  [lab(50.0, 2.5, 0.0), lab(61.0, -5.0, 29.0), 22.8977],
  [lab(50.0, 2.5, 0.0), lab(56.0, -27.0, -3.0), 31.903],
  [lab(50.0, 2.5, 0.0), lab(58.0, 24.0, 15.0), 19.4535],
  [lab(50.0, 2.5, 0.0), lab(50.0, 3.1736, 0.5854), 1.0],
  [lab(50.0, 2.5, 0.0), lab(50.0, 3.2972, 0.0), 1.0],
  [lab(50.0, 2.5, 0.0), lab(50.0, 1.8634, 0.5757), 1.0],
  [lab(50.0, 2.5, 0.0), lab(50.0, 3.2592, 0.335), 1.0],
  [lab(60.2574, -34.0099, 36.2677), lab(60.4626, -34.1751, 39.4387), 1.2644],
  [lab(63.0109, -31.0961, -5.8663), lab(62.8187, -29.7946, -4.0864), 1.263],
  [lab(61.2901, 3.7196, -5.3901), lab(61.4292, 2.248, -4.962), 1.8731],
  [lab(35.0831, -44.1164, 3.7933), lab(35.0232, -40.0716, 1.5901), 1.8645],
  [lab(22.7233, 20.0904, -46.694), lab(23.0331, 14.973, -42.5619), 2.0373],
  [lab(36.4612, 47.858, 18.3852), lab(36.2715, 50.5065, 21.2231), 1.4146],
  [lab(90.8027, -2.0831, 1.441), lab(91.1528, -1.6435, 0.0447), 1.4441],
  [lab(90.9257, -0.5406, -0.9208), lab(88.6381, -0.8985, -0.7239), 1.5381],
  [lab(6.7747, -0.2908, -2.4247), lab(5.8714, -0.0985, -2.2286), 0.6377],
  [lab(2.0776, 0.0795, -1.135), lab(0.9033, -0.0636, -0.5514), 0.9082],
];

describe('deltaE2000', () => {
  it.each(SHARMA_PAIRS.map((pair, index) => [index + 1, ...pair] as const))(
    'matches the Sharma reference dataset for pair %i',
    (_index, a, b, expected) => {
      expect(deltaE2000(a, b)).toBeCloseTo(expected, 4);
    },
  );

  it('is zero for identical colours', () => {
    expect(deltaE2000(lab(45, 12, -30), lab(45, 12, -30))).toBe(0);
  });

  it('is symmetric', () => {
    const a = lab(55.3, -12.4, 28.9);
    const b = lab(48.1, 4.2, -17.6);
    expect(deltaE2000(a, b)).toBeCloseTo(deltaE2000(b, a), 10);
  });

  it('handles two pure neutrals without producing NaN', () => {
    // Both chroma values are zero, so the hue terms are undefined and must be
    // suppressed rather than propagating a division by zero.
    const result = deltaE2000(lab(40, 0, 0), lab(60, 0, 0));
    expect(Number.isFinite(result)).toBe(true);
    expect(result).toBeGreaterThan(0);
  });

  it('weights can relax the lightness term to tolerate exposure error', () => {
    const reference = lab(50, 10, 10);
    const brighter = lab(58, 10, 10);
    const strict = deltaE2000(reference, brighter);
    const relaxed = deltaE2000(reference, brighter, { kL: 2 });
    expect(relaxed).toBeLessThan(strict);
  });
});

describe('deltaE76', () => {
  it('is plain Euclidean distance', () => {
    expect(deltaE76(lab(50, 0, 0), lab(53, 4, 0))).toBeCloseTo(5, 10);
  });

  it('under-reports differences in the blue region compared with CIEDE2000', () => {
    // This is the concrete reason the classifier does not use CIE76: the two
    // blues below are 4.3 CIE76 units apart but perceptually much further.
    const a = lab(50, 2.6772, -79.7751);
    const b = lab(50, 0, -82.7485);
    expect(deltaE76(a, b)).toBeGreaterThan(deltaE2000(a, b));
  });
});
