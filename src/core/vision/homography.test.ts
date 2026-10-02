import { describe, expect, it } from 'vitest';
import {
  applyHomography,
  computeHomography,
  invertHomography,
  isConvexQuad,
  polygonSignedArea,
  reprojectionError,
  type Homography,
  type Point,
} from './homography';

const pt = (x: number, y: number): Point => ({ x, y });

/** Applies a homography given as a plain 9-array, for constructing test data. */
function project(h: readonly number[], p: Point): Point {
  const w = h[6] * p.x + h[7] * p.y + h[8];
  return { x: (h[0] * p.x + h[1] * p.y + h[2]) / w, y: (h[3] * p.x + h[4] * p.y + h[5]) / w };
}

describe('computeHomography', () => {
  it('recovers an identity mapping', () => {
    const square = [pt(0, 0), pt(10, 0), pt(10, 10), pt(0, 10)];
    const h = computeHomography(square, square);
    expect(h).not.toBeNull();
    for (const p of square) {
      const out = applyHomography(h!, p);
      expect(out.x).toBeCloseTo(p.x, 8);
      expect(out.y).toBeCloseTo(p.y, 8);
    }
  });

  it('recovers a pure translation and scale', () => {
    const src = [pt(0, 0), pt(20, 0), pt(20, 10), pt(0, 10)];
    const dst = src.map((p) => pt(p.x * 3 + 50, p.y * 3 - 20));
    const h = computeHomography(src, dst);
    expect(h).not.toBeNull();
    const check = applyHomography(h!, pt(10, 5));
    expect(check.x).toBeCloseTo(80, 6);
    expect(check.y).toBeCloseTo(-5, 6);
  });

  it('recovers a known projective transform from exactly four points', () => {
    // A genuine perspective transform: note the non-zero bottom row, which is
    // what a tilted phone produces.
    const truth = [1.2, 0.15, 30, -0.1, 1.05, 60, 0.0008, 0.0012, 1];
    const src = [pt(0, 0), pt(88.9, 0), pt(88.9, 54), pt(0, 54)];
    const dst = src.map((p) => project(truth, p));

    const h = computeHomography(src, dst);
    expect(h).not.toBeNull();

    // Check agreement on interior points the fit never saw, which is the real
    // test: matching only at the four control points would be trivial.
    for (const probe of [pt(44, 27), pt(12, 40), pt(70, 8), pt(30, 15)]) {
      const expected = project(truth, probe);
      const actual = applyHomography(h!, probe);
      expect(actual.x).toBeCloseTo(expected.x, 6);
      expect(actual.y).toBeCloseTo(expected.y, 6);
    }
  });

  it('stays accurate for a strongly tilted view', () => {
    const truth = [0.9, 0.4, 15, -0.25, 1.3, 40, 0.0035, 0.0021, 1];
    const src = [pt(0, 0), pt(88.9, 0), pt(88.9, 54), pt(0, 54)];
    const dst = src.map((p) => project(truth, p));
    const h = computeHomography(src, dst);
    expect(h).not.toBeNull();
    expect(reprojectionError(h!, src, dst)).toBeLessThan(1e-6);
  });

  it('is numerically stable with large pixel coordinates', () => {
    // A 4000x3000 sensor: the un-normalised DLT loses precision here, so this
    // exercises the Hartley normalisation.
    const src = [pt(0, 0), pt(88.9, 0), pt(88.9, 54), pt(0, 54)];
    const dst = [pt(310, 890), pt(3620, 640), pt(3810, 2510), pt(240, 2680)];
    const h = computeHomography(src, dst);
    expect(h).not.toBeNull();
    expect(reprojectionError(h!, src, dst)).toBeLessThan(1e-6);
  });

  it('uses all correspondences when more than four are supplied', () => {
    const truth = [1.1, 0.05, 10, -0.05, 1.15, 20, 0.0005, 0.0007, 1];
    const src = [pt(0, 0), pt(88.9, 0), pt(88.9, 54), pt(0, 54), pt(44, 27), pt(20, 10)];
    const dst = src.map((p) => project(truth, p));
    const h = computeHomography(src, dst);
    expect(h).not.toBeNull();
    expect(reprojectionError(h!, src, dst)).toBeLessThan(1e-6);
  });

  it('returns null with fewer than four correspondences', () => {
    expect(computeHomography([pt(0, 0), pt(1, 0), pt(0, 1)], [pt(0, 0), pt(1, 0), pt(0, 1)])).toBeNull();
  });

  it('returns null for a degenerate all-collinear configuration', () => {
    const collinear = [pt(0, 0), pt(1, 1), pt(2, 2), pt(3, 3)];
    const dst = [pt(0, 0), pt(1, 0), pt(2, 0), pt(3, 0)];
    expect(computeHomography(collinear, dst)).toBeNull();
  });

  it('throws when the correspondence counts differ', () => {
    expect(() => computeHomography([pt(0, 0)], [pt(0, 0), pt(1, 1)])).toThrow();
  });
});

describe('invertHomography', () => {
  it('round-trips points back to their origin', () => {
    const src = [pt(0, 0), pt(88.9, 0), pt(88.9, 54), pt(0, 54)];
    const dst = [pt(120, 300), pt(980, 250), pt(1010, 760), pt(90, 800)];
    const h = computeHomography(src, dst)!;
    const inverse = invertHomography(h)!;

    for (const probe of [pt(10, 10), pt(44.45, 27), pt(80, 50)]) {
      const forward = applyHomography(h, probe);
      const back = applyHomography(inverse, forward);
      expect(back.x).toBeCloseTo(probe.x, 6);
      expect(back.y).toBeCloseTo(probe.y, 6);
    }
  });

  it('returns null for a singular matrix', () => {
    const singular: Homography = [1, 2, 3, 2, 4, 6, 1, 1, 1];
    expect(invertHomography(singular)).toBeNull();
  });
});

describe('applyHomography', () => {
  it('returns NaN for points that map to infinity', () => {
    // Bottom row chosen so that x = 1 lands exactly on the vanishing line.
    const h: Homography = [1, 0, 0, 0, 1, 0, -1, 0, 1];
    const result = applyHomography(h, pt(1, 5));
    expect(Number.isNaN(result.x)).toBe(true);
    expect(Number.isNaN(result.y)).toBe(true);
  });
});

describe('reprojectionError', () => {
  it('is near zero for a consistent set', () => {
    const src = [pt(0, 0), pt(10, 0), pt(10, 10), pt(0, 10)];
    const dst = [pt(0, 0), pt(20, 0), pt(20, 20), pt(0, 20)];
    const h = computeHomography(src, dst)!;
    expect(reprojectionError(h, src, dst)).toBeLessThan(1e-9);
  });

  it('grows when one correspondence is an outlier', () => {
    // Simulates mistaking a dark background object for a fiducial marker.
    const src = [pt(0, 0), pt(88.9, 0), pt(88.9, 54), pt(0, 54)];
    const good = [pt(100, 100), pt(900, 100), pt(900, 590), pt(100, 590)];
    const withOutlier = [pt(100, 100), pt(900, 100), pt(900, 590), pt(300, 480)];

    const hGood = computeHomography(src, good)!;
    // Five correspondences with one bad point cannot be fitted exactly, so the
    // residual exposes the problem.
    const srcFive = [...src, pt(44, 27)];
    const dstFive = [...withOutlier, pt(500, 345)];
    const hBad = computeHomography(srcFive, dstFive)!;

    expect(reprojectionError(hGood, src, good)).toBeLessThan(1e-6);
    expect(reprojectionError(hBad, srcFive, dstFive)).toBeGreaterThan(1);
  });
});

describe('quad helpers', () => {
  it('detects a convex quad', () => {
    expect(isConvexQuad([pt(0, 0), pt(10, 0), pt(10, 10), pt(0, 10)])).toBe(true);
  });

  it('rejects a self-intersecting quad', () => {
    // Swapped vertices produce a bow-tie, which is what a mis-ordered fiducial
    // set looks like.
    expect(isConvexQuad([pt(0, 0), pt(10, 0), pt(0, 10), pt(10, 10)])).toBe(false);
  });

  it('rejects a concave quad', () => {
    expect(isConvexQuad([pt(0, 0), pt(10, 0), pt(2, 2), pt(0, 10)])).toBe(false);
  });

  it('computes signed area with orientation', () => {
    const ccw = [pt(0, 0), pt(10, 0), pt(10, 10), pt(0, 10)];
    expect(polygonSignedArea(ccw)).toBeCloseTo(100, 8);
    expect(polygonSignedArea([...ccw].reverse())).toBeCloseTo(-100, 8);
  });
});
