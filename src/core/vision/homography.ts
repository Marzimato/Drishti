/**
 * Planar homography estimation and application.
 *
 * The reference card is a rigid plane. Once we know where its four fiducial
 * markers landed in the camera frame, a homography lets us address any point on
 * the card by its physical millimetre coordinates, regardless of how the phone
 * was tilted or rotated. That is what makes "sample the patch that is 12 mm from
 * the left edge" a well-defined operation on a hand-held photograph.
 */

import { solveLeastSquares } from '../math/linalg';

export interface Point {
  x: number;
  y: number;
}

/** Row-major 3x3 projective transform. */
export type Homography = readonly [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];

interface Normalisation {
  scale: number;
  centroid: Point;
}

/**
 * Hartley isotropic normalisation: translate the centroid to the origin and
 * scale so the mean distance from the origin is sqrt(2).
 *
 * Without this, the DLT system mixes terms of wildly different magnitude (pixel
 * coordinates near 3000 multiplied together reach 1e7, while the homogeneous
 * terms are order 1), and the normal-equations solve loses precision. With it the
 * system is well conditioned for any realistic frame size.
 */
function computeNormalisation(points: readonly Point[]): Normalisation {
  const n = points.length;
  let cx = 0;
  let cy = 0;
  for (const p of points) {
    cx += p.x;
    cy += p.y;
  }
  cx /= n;
  cy /= n;

  let meanDistance = 0;
  for (const p of points) meanDistance += Math.hypot(p.x - cx, p.y - cy);
  meanDistance /= n;

  // Degenerate input (all points coincident) would divide by zero.
  const scale = meanDistance > 1e-12 ? Math.SQRT2 / meanDistance : 1;
  return { scale, centroid: { x: cx, y: cy } };
}

function normalisePoint(p: Point, n: Normalisation): Point {
  return { x: (p.x - n.centroid.x) * n.scale, y: (p.y - n.centroid.y) * n.scale };
}

/** The 3x3 matrix that performs a given normalisation. */
function normalisationMatrix(n: Normalisation): number[][] {
  return [
    [n.scale, 0, -n.scale * n.centroid.x],
    [0, n.scale, -n.scale * n.centroid.y],
    [0, 0, 1],
  ];
}

function inverseNormalisationMatrix(n: Normalisation): number[][] {
  return [
    [1 / n.scale, 0, n.centroid.x],
    [0, 1 / n.scale, n.centroid.y],
    [0, 0, 1],
  ];
}

function mul3(a: number[][], b: number[][]): number[][] {
  const out = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  for (let i = 0; i < 3; i++) {
    for (let k = 0; k < 3; k++) {
      const aik = a[i][k];
      if (aik === 0) continue;
      for (let j = 0; j < 3; j++) out[i][j] += aik * b[k][j];
    }
  }
  return out;
}

/**
 * Estimates the homography mapping `src` onto `dst`.
 *
 * Requires at least four correspondences; with more than four it returns the
 * least-squares fit. Returns null if the configuration is degenerate (for
 * example three or more collinear points), which the caller must treat as a
 * failed detection.
 */
export function computeHomography(
  src: readonly Point[],
  dst: readonly Point[],
): Homography | null {
  if (src.length !== dst.length) {
    throw new Error('computeHomography() needs matching source and destination counts');
  }
  if (src.length < 4) return null;

  const srcNorm = computeNormalisation(src);
  const dstNorm = computeNormalisation(dst);

  const rows: number[][] = [];
  const rhs: number[] = [];

  for (let i = 0; i < src.length; i++) {
    const { x, y } = normalisePoint(src[i], srcNorm);
    const { x: u, y: v } = normalisePoint(dst[i], dstNorm);

    // Fixing h33 = 1 turns the 9-unknown homogeneous problem into an 8-unknown
    // inhomogeneous one. This is valid for any homography that does not send the
    // card plane through the camera centre, which no real photograph does.
    rows.push([x, y, 1, 0, 0, 0, -x * u, -y * u]);
    rhs.push(u);
    rows.push([0, 0, 0, x, y, 1, -x * v, -y * v]);
    rhs.push(v);
  }

  const h = solveLeastSquares(rows, rhs);
  if (!h) return null;

  const normalised = [
    [h[0], h[1], h[2]],
    [h[3], h[4], h[5]],
    [h[6], h[7], 1],
  ];

  // Undo the normalisation: H = inv(Tdst) * Hnorm * Tsrc
  const denormalised = mul3(inverseNormalisationMatrix(dstNorm), mul3(normalised, normalisationMatrix(srcNorm)));

  const flat = [
    denormalised[0][0],
    denormalised[0][1],
    denormalised[0][2],
    denormalised[1][0],
    denormalised[1][1],
    denormalised[1][2],
    denormalised[2][0],
    denormalised[2][1],
    denormalised[2][2],
  ];

  if (!flat.every(Number.isFinite)) return null;

  // Scale so the bottom-right entry is 1, giving a canonical representation that
  // is easy to compare and serialise.
  const w = flat[8];
  if (Math.abs(w) < 1e-12) return null;
  const scaled = flat.map((value) => value / w) as unknown as number[];

  return scaled as unknown as Homography;
}

export function applyHomography(h: Homography, p: Point): Point {
  const w = h[6] * p.x + h[7] * p.y + h[8];
  // A near-zero denominator means the point maps to infinity (behind the camera
  // plane). Returning NaN lets sampling code reject it rather than reading a
  // wildly wrong pixel.
  if (Math.abs(w) < 1e-12) return { x: Number.NaN, y: Number.NaN };
  return {
    x: (h[0] * p.x + h[1] * p.y + h[2]) / w,
    y: (h[3] * p.x + h[4] * p.y + h[5]) / w,
  };
}

export function invertHomography(h: Homography): Homography | null {
  const [a, b, c, d, e, f, g, i, j] = h;

  const cofA = e * j - f * i;
  const cofB = -(d * j - f * g);
  const cofC = d * i - e * g;

  const det = a * cofA + b * cofB + c * cofC;
  if (Math.abs(det) < 1e-14) return null;

  const inv = 1 / det;
  const out = [
    cofA * inv,
    -(b * j - c * i) * inv,
    (b * f - c * e) * inv,
    cofB * inv,
    (a * j - c * g) * inv,
    -(a * f - c * d) * inv,
    cofC * inv,
    -(a * i - b * g) * inv,
    (a * e - b * d) * inv,
  ];

  const w = out[8];
  if (Math.abs(w) < 1e-12) return null;
  return out.map((value) => value / w) as unknown as Homography;
}

/**
 * Mean reprojection error in destination units.
 *
 * This is the single most useful health metric for a detection: if the four
 * fiducials do not sit on a consistent plane projection (because one "fiducial"
 * was actually a dark object in the background), the error jumps from well under
 * a pixel to many pixels, and we can reject the capture.
 */
export function reprojectionError(
  h: Homography,
  src: readonly Point[],
  dst: readonly Point[],
): number {
  let total = 0;
  for (let i = 0; i < src.length; i++) {
    const projected = applyHomography(h, src[i]);
    if (!Number.isFinite(projected.x) || !Number.isFinite(projected.y)) return Number.POSITIVE_INFINITY;
    total += Math.hypot(projected.x - dst[i].x, projected.y - dst[i].y);
  }
  return total / src.length;
}

/** Signed area of a polygon; used to test orientation and convexity. */
export function polygonSignedArea(points: readonly Point[]): number {
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    area += a.x * b.y - b.x * a.y;
  }
  return area / 2;
}

export function isConvexQuad(points: readonly Point[]): boolean {
  if (points.length !== 4) return false;
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = points[i];
    const b = points[(i + 1) % 4];
    const c = points[(i + 2) % 4];
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(cross) < 1e-9) continue;
    const currentSign = cross > 0 ? 1 : -1;
    if (sign === 0) sign = currentSign;
    else if (currentSign !== sign) return false;
  }
  return sign !== 0;
}
