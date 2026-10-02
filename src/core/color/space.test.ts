import { describe, expect, it } from 'vitest';
import {
  WHITE_POINT_D50,
  WHITE_POINT_D65,
  adaptXyz,
  hexToRgb,
  labToSrgb,
  linearToSrgbChannel,
  relativeLuminance,
  rgb8ToRgb,
  rgbToHex,
  srgbToLab,
  srgbToLinear,
  srgbToLinearChannel,
  xyzToLab,
} from './space';

describe('sRGB transfer function', () => {
  it('round-trips across the full range', () => {
    for (let i = 0; i <= 255; i++) {
      const encoded = i / 255;
      const back = linearToSrgbChannel(srgbToLinearChannel(encoded));
      expect(back).toBeCloseTo(encoded, 12);
    }
  });

  it('is continuous at the linear/power segment join', () => {
    const below = srgbToLinearChannel(0.04045 - 1e-9);
    const above = srgbToLinearChannel(0.04045 + 1e-9);
    expect(Math.abs(above - below)).toBeLessThan(1e-7);
  });

  it('maps the endpoints exactly', () => {
    expect(srgbToLinearChannel(0)).toBe(0);
    expect(srgbToLinearChannel(1)).toBeCloseTo(1, 12);
  });

  it('encodes 18% mid grey to roughly 0.46, matching the sRGB curve', () => {
    expect(linearToSrgbChannel(0.18)).toBeCloseTo(0.4613561, 5);
  });
});

/**
 * Tolerance for comparisons against published Lab values for the sRGB primaries.
 *
 * Literature tables (Lindbloom's being the most commonly cited) derive the
 * sRGB->XYZ matrix from D65 rounded to 0.95047 / 1.00000 / 1.08883, giving a
 * luminance coefficient of 0.2126729. We derive ours at full precision
 * (0.2126390...) so that the matrix rows sum *exactly* to our white point, which
 * is what guarantees white maps to L*=100, a=b=0 with no residual chroma.
 *
 * The two conventions differ by ~0.004 in L* for the primaries. That is four
 * orders of magnitude below the ~1.0 Delta-E that is perceptually meaningful, so
 * either is defensible; internal consistency is worth more to us. This tolerance
 * accommodates the convention difference while still failing loudly if the
 * matrix or the transfer function is actually wrong (those errors show up in
 * whole units, not thousandths).
 */
const PRIMARY_TOLERANCE_DP = 1;

describe('sRGB to Lab', () => {
  it('maps white to L*=100 with no chroma', () => {
    const white = srgbToLab({ r: 1, g: 1, b: 1 });
    expect(white.L).toBeCloseTo(100, 8);
    expect(white.a).toBeCloseTo(0, 8);
    expect(white.b).toBeCloseTo(0, 8);
  });

  it('maps black to the origin', () => {
    const black = srgbToLab({ r: 0, g: 0, b: 0 });
    expect(black.L).toBeCloseTo(0, 10);
    expect(black.a).toBeCloseTo(0, 10);
    expect(black.b).toBeCloseTo(0, 10);
  });

  it('maps pure red correctly', () => {
    const red = srgbToLab({ r: 1, g: 0, b: 0 });
    expect(red.L).toBeCloseTo(53.2408, PRIMARY_TOLERANCE_DP);
    expect(red.a).toBeCloseTo(80.0925, PRIMARY_TOLERANCE_DP);
    expect(red.b).toBeCloseTo(67.2032, PRIMARY_TOLERANCE_DP);
  });

  it('maps pure green correctly', () => {
    const green = srgbToLab({ r: 0, g: 1, b: 0 });
    expect(green.L).toBeCloseTo(87.7347, PRIMARY_TOLERANCE_DP);
    expect(green.a).toBeCloseTo(-86.1827, PRIMARY_TOLERANCE_DP);
    expect(green.b).toBeCloseTo(83.1793, PRIMARY_TOLERANCE_DP);
  });

  it('maps pure blue correctly', () => {
    const blue = srgbToLab({ r: 0, g: 0, b: 1 });
    expect(blue.L).toBeCloseTo(32.297, PRIMARY_TOLERANCE_DP);
    expect(blue.a).toBeCloseTo(79.1875, PRIMARY_TOLERANCE_DP);
    expect(blue.b).toBeCloseTo(-107.8602, PRIMARY_TOLERANCE_DP);
  });

  it('keeps neutral greys neutral', () => {
    for (const level of [32, 64, 128, 192, 224]) {
      const grey = srgbToLab(rgb8ToRgb(level, level, level));
      expect(grey.a).toBeCloseTo(0, 8);
      expect(grey.b).toBeCloseTo(0, 8);
    }
  });

  it('round-trips Lab back to sRGB for in-gamut colours', () => {
    const original = rgb8ToRgb(120, 84, 200);
    const back = labToSrgb(srgbToLab(original));
    expect(back.r).toBeCloseTo(original.r, 10);
    expect(back.g).toBeCloseTo(original.g, 10);
    expect(back.b).toBeCloseTo(original.b, 10);
  });
});

describe('xyzToLab', () => {
  it('returns L*=100 for the chosen white point regardless of illuminant', () => {
    expect(xyzToLab(WHITE_POINT_D65, WHITE_POINT_D65).L).toBeCloseTo(100, 10);
    expect(xyzToLab(WHITE_POINT_D50, WHITE_POINT_D50).L).toBeCloseTo(100, 10);
  });

  it('uses the linear segment below the epsilon threshold', () => {
    // Very dark values must not go through the cube root branch, otherwise the
    // near-black patches on the reference card get a badly wrong L*.
    const veryDark = { x: 0.0005, y: 0.0005, z: 0.0005 };
    const result = xyzToLab(veryDark, WHITE_POINT_D65);
    expect(result.L).toBeGreaterThan(0);
    expect(result.L).toBeLessThan(1);
  });
});

/**
 * The Bradford cone-response matrix and its inverse are used in their standard
 * published form, rounded to 7 decimal places. That rounding means
 * inverse(forward(x)) differs from x by around 1e-8, so round-trip assertions
 * are made to 6 decimal places rather than 8. An error of 1e-8 in XYZ is far
 * below camera noise and irrelevant to classification.
 */
const BRADFORD_ROUNDTRIP_DP = 6;

describe('adaptXyz', () => {
  it('is a no-op when the source and destination white points match', () => {
    const colour = { x: 0.3, y: 0.25, z: 0.4 };
    const result = adaptXyz(colour, WHITE_POINT_D65, WHITE_POINT_D65);
    expect(result.x).toBeCloseTo(colour.x, BRADFORD_ROUNDTRIP_DP);
    expect(result.y).toBeCloseTo(colour.y, BRADFORD_ROUNDTRIP_DP);
    expect(result.z).toBeCloseTo(colour.z, BRADFORD_ROUNDTRIP_DP);
  });

  it('maps the source white to the destination white', () => {
    const result = adaptXyz(WHITE_POINT_D65, WHITE_POINT_D65, WHITE_POINT_D50);
    expect(result.x).toBeCloseTo(WHITE_POINT_D50.x, 4);
    expect(result.y).toBeCloseTo(WHITE_POINT_D50.y, 4);
    expect(result.z).toBeCloseTo(WHITE_POINT_D50.z, 4);
  });

  it('is reversible', () => {
    const colour = { x: 0.2, y: 0.18, z: 0.15 };
    const there = adaptXyz(colour, WHITE_POINT_D65, WHITE_POINT_D50);
    const back = adaptXyz(there, WHITE_POINT_D50, WHITE_POINT_D65);
    expect(back.x).toBeCloseTo(colour.x, BRADFORD_ROUNDTRIP_DP);
    expect(back.y).toBeCloseTo(colour.y, BRADFORD_ROUNDTRIP_DP);
    expect(back.z).toBeCloseTo(colour.z, BRADFORD_ROUNDTRIP_DP);
  });
});

describe('hex helpers', () => {
  it('round-trips 8-bit colours', () => {
    expect(rgbToHex(hexToRgb('#3f7fbf'))).toBe('#3f7fbf');
  });

  it('expands shorthand notation', () => {
    expect(rgbToHex(hexToRgb('#abc'))).toBe('#aabbcc');
  });

  it('rejects malformed input', () => {
    expect(() => hexToRgb('nope')).toThrow();
    expect(() => hexToRgb('#12345')).toThrow();
  });
});

describe('relativeLuminance', () => {
  it('is 1 for linear white and 0 for black', () => {
    expect(relativeLuminance({ r: 1, g: 1, b: 1 })).toBeCloseTo(1, 10);
    expect(relativeLuminance({ r: 0, g: 0, b: 0 })).toBe(0);
  });

  it('weights green most heavily', () => {
    const green = relativeLuminance(srgbToLinear({ r: 0, g: 1, b: 0 }));
    const red = relativeLuminance(srgbToLinear({ r: 1, g: 0, b: 0 }));
    const blue = relativeLuminance(srgbToLinear({ r: 0, g: 0, b: 1 }));
    expect(green).toBeGreaterThan(red);
    expect(red).toBeGreaterThan(blue);
  });
});
