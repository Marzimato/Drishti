/**
 * Reference card detection.
 *
 * Finds the four black corner markers in a camera frame and derives the
 * homography that maps card millimetres onto image pixels. Everything downstream
 * — patch sampling, colour correction, reading the sample window — depends on
 * this being right, so the module is deliberately conservative: it would rather
 * report a specific, actionable failure than return a detection it is unsure of.
 *
 * Approach: Otsu threshold, 8-connected component labelling, shape filtering to
 * find square blob candidates, then a small combinatorial search for the four
 * that form a plausible card. Orientation is resolved by the white key square in
 * the top-left marker, not by assuming the operator held the card upright.
 *
 * Implemented directly rather than via OpenCV.js because the whole detection is
 * ~300 lines against an 8 MB WASM dependency that would have to be cached for
 * offline use on a mid-range phone.
 */

import {
  FIDUCIALS,
  FIDUCIAL_CENTRES_MM,
  FIDUCIAL_RECT_ASPECT,
  ORIENTATION_KEY_INNER_FRACTION,
  type RectMm,
} from '../card/spec';
import {
  applyHomography,
  computeHomography,
  invertHomography,
  isConvexQuad,
  type Homography,
  type Point,
} from './homography';
import {
  bilinearSampleEncoded,
  downscaleRgba,
  otsuThreshold,
  toGrayscale,
  type RgbaImage,
} from './image';

/** Detection runs at this resolution; markers are large so more does not help. */
export const DETECTION_MAX_DIMENSION = 640;

/** A marker must cover at least this fraction of the detection image. */
export const MIN_MARKER_AREA_FRACTION = 0.0002;
/** ...and at most this much, or it is not a marker but a shadow or the desk. */
export const MAX_MARKER_AREA_FRACTION = 0.06;

/**
 * Shape filtering uses second-moment (inertia) descriptors rather than the
 * bounding box, because bounding-box measures are not rotation invariant and the
 * operator can hold the card at any angle.
 *
 * For a filled rectangle with half-extents a and b, the central second moments
 * have eigenvalues a^2/3 and b^2/3. Two consequences we rely on:
 *
 *   momentAspect   = sqrt(lambda1 / lambda2)  -> 1.0 for a square, at any rotation
 *   momentSolidity = area / (12 * sqrt(l1*l2)) -> 1.0 for any filled rectangle
 *
 * Using bounding-box fill ratio instead would reject a marker rotated toward 45
 * degrees (its fill ratio falls to 0.5), and using bounding-box aspect would
 * accept the 1.70-aspect neutral calibration patches as corner markers.
 */

/** Square markers measure 1.0; the ceiling allows for perspective foreshortening. */
export const MAX_MARKER_MOMENT_ASPECT = 1.5;

/**
 * A solid filled square scores 1.0. The top-left marker, hollowed by its white
 * key square, scores about 0.8. Values far outside this band indicate an
 * irregular dark shape rather than printed ink.
 */
export const MIN_MARKER_SOLIDITY = 0.68;
export const MAX_MARKER_SOLIDITY = 1.35;

/** Largest marker area may exceed the smallest by at most this factor. */
export const MAX_MARKER_AREA_RATIO = 4;

/**
 * Once a homography is available, we project the printed 8 x 8 mm marker outline
 * into the image and compare its area with the area actually occupied by the
 * detected blob. Comparing *areas* is rotation invariant, which a linear size
 * comparison is not: an axis-aligned bounding box measured in image space and
 * then re-measured axis-aligned in card space inflates by (cos+sin)^2, reaching
 * 1.77x at 45 degrees and wrongly rejecting a perfectly good detection.
 *
 * The solid markers should score near 1.0 and the hollowed top-left marker near
 * 0.89, so this band mainly catches a blob of grossly the wrong size.
 */
/**
 * Keep this band tight. It is a load-bearing safety check, not a nuisance filter.
 *
 * Widening it to [0.35, 2.8] to let very oblique captures through instead allowed
 * an incorrect four-marker grouping to be accepted on a moderately tilted capture.
 * The resulting homography sampled the card from the wrong places and produced
 * absurd downstream metrics (a "538% illumination gradient", sample non-uniformity
 * above 1.2). The quality gates did catch it, so no wrong result was emitted, but
 * relying on downstream gates to clean up a bad detection is the wrong division of
 * responsibility: geometry errors should be rejected as geometry errors.
 */
export const MIN_MARKER_AREA_AGREEMENT = 0.5;
export const MAX_MARKER_AREA_AGREEMENT = 2;

/**
 * Plausible range for the apparent aspect ratio of the marker-centre rectangle.
 * The card's true value is ~1.85; perspective compresses or stretches this, and
 * outside this range the view is too oblique for a reliable colour reading
 * anyway, so rejecting is the right call.
 */
export const MIN_QUAD_ASPECT = 0.9;
export const MAX_QUAD_ASPECT = 3.6;

/** Minimum brightness contrast between the key square and the surrounding ink. */
export const MIN_ORIENTATION_CONTRAST = 0.18;

/** Candidates considered by the combinatorial search, largest first. */
const MAX_CANDIDATES_CONSIDERED = 14;

/**
 * How many candidate quads are fully validated before giving up. Bounded so a
 * cluttered frame cannot make detection quadratically slow, but generous enough
 * that the correct quad is reached even when several decoys score above it.
 */
const MAX_QUADS_VALIDATED = 40;

export type DetectionFailureReason =
  | 'image-too-small'
  | 'too-few-marker-candidates'
  | 'no-plausible-quad'
  | 'orientation-key-not-found'
  | 'marker-size-implausible'
  | 'degenerate-homography';

export interface DetectionFailure {
  ok: false;
  reason: DetectionFailureReason;
  /** Operator-facing guidance, not a stack trace. */
  message: string;
  candidateCount: number;
}

export interface CardDetection {
  ok: true;
  /** Card millimetres to full-resolution image pixels. */
  cardToImage: Homography;
  /** The inverse, for hit-testing and overlay drawing. */
  imageToCard: Homography;
  /** Marker centres in full-resolution pixels, ordered TL, TR, BR, BL. */
  markersPx: readonly Point[];
  /** Apparent aspect ratio of the marker rectangle. */
  quadAspect: number;
  /** Luma gap between the orientation key and its surrounding ink, 0..1. */
  orientationContrast: number;
  /** Fraction of the frame occupied by the detected card outline. */
  cardCoverage: number;
}

export type DetectionResult = CardDetection | DetectionFailure;

interface Blob {
  area: number;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  centroid: Point;
  /** Bounding-box fill fraction. Diagnostics only: not rotation invariant. */
  fillRatio: number;
  /** sqrt of the ratio of second-moment eigenvalues; 1.0 for a square. */
  momentAspect: number;
  /** area / (12 * sqrt(l1*l2)); 1.0 for a filled rectangle at any rotation. */
  momentSolidity: number;
}

function fail(
  reason: DetectionFailureReason,
  message: string,
  candidateCount: number,
): DetectionFailure {
  return { ok: false, reason, message, candidateCount };
}

/**
 * Labels 8-connected components of the dark mask.
 *
 * Uses an explicit stack rather than recursion: a large dark background region
 * can span hundreds of thousands of pixels and would overflow the call stack.
 */
function findDarkBlobs(
  gray: Float32Array,
  width: number,
  height: number,
  threshold: number,
): Blob[] {
  const visited = new Uint8Array(width * height);
  const blobs: Blob[] = [];
  const stack: number[] = [];

  for (let start = 0; start < gray.length; start++) {
    if (visited[start] || gray[start] > threshold) continue;

    stack.push(start);
    visited[start] = 1;

    let area = 0;
    let minX = width;
    let maxX = -1;
    let minY = height;
    let maxY = -1;
    let sumX = 0;
    let sumY = 0;
    let sumXX = 0;
    let sumYY = 0;
    let sumXY = 0;

    while (stack.length > 0) {
      const index = stack.pop()!;
      const x = index % width;
      const y = (index - x) / width;

      area++;
      sumX += x;
      sumY += y;
      sumXX += x * x;
      sumYY += y * y;
      sumXY += x * y;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;

      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx;
          if (nx < 0 || nx >= width) continue;
          const neighbour = ny * width + nx;
          if (visited[neighbour] || gray[neighbour] > threshold) continue;
          visited[neighbour] = 1;
          stack.push(neighbour);
        }
      }
    }

    const boxWidth = maxX - minX + 1;
    const boxHeight = maxY - minY + 1;
    const cx = sumX / area;
    const cy = sumY / area;

    // Central second moments. The +1/12 terms are the standard discrete-pixel
    // correction: a pixel is a unit square, not a point, and without this the
    // moments of small blobs are underestimated.
    const mu20 = sumXX / area - cx * cx + 1 / 12;
    const mu02 = sumYY / area - cy * cy + 1 / 12;
    const mu11 = sumXY / area - cx * cy;

    const common = (mu20 + mu02) / 2;
    const spread = Math.sqrt(((mu20 - mu02) / 2) ** 2 + mu11 * mu11);
    const lambda1 = common + spread;
    const lambda2 = common - spread;

    const momentAspect = lambda2 > 1e-9 ? Math.sqrt(lambda1 / lambda2) : Number.POSITIVE_INFINITY;
    const equivalentArea = 12 * Math.sqrt(Math.max(lambda1 * lambda2, 1e-12));
    const momentSolidity = equivalentArea > 0 ? area / equivalentArea : 0;

    blobs.push({
      area,
      minX,
      maxX,
      minY,
      maxY,
      centroid: { x: cx, y: cy },
      fillRatio: area / (boxWidth * boxHeight),
      momentAspect,
      momentSolidity,
    });
  }

  return blobs;
}

function isMarkerCandidate(blob: Blob, frameArea: number): boolean {
  const areaFraction = blob.area / frameArea;
  if (areaFraction < MIN_MARKER_AREA_FRACTION || areaFraction > MAX_MARKER_AREA_FRACTION) {
    return false;
  }
  if (blob.momentAspect > MAX_MARKER_MOMENT_ASPECT) return false;
  if (blob.momentSolidity < MIN_MARKER_SOLIDITY || blob.momentSolidity > MAX_MARKER_SOLIDITY) {
    return false;
  }
  return true;
}

/** Orders four points into convex cyclic order by angle about their centroid. */
function cyclicOrder(points: readonly Point[]): Point[] {
  const cx = points.reduce((sum, p) => sum + p.x, 0) / points.length;
  const cy = points.reduce((sum, p) => sum + p.y, 0) / points.length;
  return [...points].sort(
    (a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx),
  );
}

function combinations<T>(items: readonly T[], choose: number): T[][] {
  const result: T[][] = [];
  const current: T[] = [];
  const walk = (start: number) => {
    if (current.length === choose) {
      result.push([...current]);
      return;
    }
    for (let i = start; i < items.length; i++) {
      current.push(items[i]);
      walk(i + 1);
      current.pop();
    }
  };
  walk(0);
  return result;
}

interface QuadCandidate {
  blobs: Blob[];
  ordered: Point[];
  score: number;
}

/**
 * Scores a set of four blobs on how card-like they are.
 *
 * Note that reprojection error is useless as a selection criterion here: four
 * point correspondences determine a homography exactly, so any four points fit
 * perfectly. Selection therefore has to rest on geometry — convexity, the
 * expected side-length ratio, and consistency of marker sizes.
 */
function scoreQuad(blobs: Blob[]): QuadCandidate | null {
  const ordered = cyclicOrder(blobs.map((b) => b.centroid));
  if (!isConvexQuad(ordered)) return null;

  const areas = blobs.map((b) => b.area);
  const areaRatio = Math.max(...areas) / Math.min(...areas);
  if (areaRatio > MAX_MARKER_AREA_RATIO) return null;

  const sides = ordered.map((p, i) => {
    const q = ordered[(i + 1) % 4];
    return Math.hypot(q.x - p.x, q.y - p.y);
  });

  // Opposite sides should roughly match; a bad grouping usually shows a large
  // mismatch here.
  const pairA = (sides[0] + sides[2]) / 2;
  const pairB = (sides[1] + sides[3]) / 2;
  if (pairA <= 0 || pairB <= 0) return null;

  const longPair = Math.max(pairA, pairB);
  const shortPair = Math.min(pairA, pairB);
  const aspect = longPair / shortPair;
  if (aspect < MIN_QUAD_ASPECT || aspect > MAX_QUAD_ASPECT) return null;

  const oppositeMismatch =
    Math.abs(sides[0] - sides[2]) / longPair + Math.abs(sides[1] - sides[3]) / longPair;
  const aspectPenalty = Math.abs(Math.log(aspect / FIDUCIAL_RECT_ASPECT));
  const areaPenalty = Math.log(areaRatio);

  // Prefer larger quads: the card should dominate the frame, and a small
  // plausible quad is more likely to be background clutter.
  const quadScale = longPair * shortPair;

  const score = aspectPenalty * 3 + oppositeMismatch * 2 + areaPenalty - Math.log(quadScale) * 0.35;
  return { blobs, ordered, score };
}

/**
 * Mean luma of the inner key region of a marker versus its surrounding ink,
 * measured on the full-resolution frame.
 *
 * Sampled at full resolution because the key square is only ~2.7 mm across; at
 * detection resolution it can be a handful of pixels and the contrast washes out.
 */
function measureOrientationContrast(
  image: RgbaImage,
  blob: Blob,
  detectionScale: number,
): number {
  const toFull = (value: number) => value / detectionScale;
  const boxWidth = (blob.maxX - blob.minX + 1) / detectionScale;
  const boxHeight = (blob.maxY - blob.minY + 1) / detectionScale;
  const centreX = toFull(blob.centroid.x);
  const centreY = toFull(blob.centroid.y);

  // Sample well inside the key square so marker-edge softness does not intrude.
  const innerHalfWidth = (boxWidth * ORIENTATION_KEY_INNER_FRACTION) / 2 * 0.6;
  const innerHalfHeight = (boxHeight * ORIENTATION_KEY_INNER_FRACTION) / 2 * 0.6;

  const innerLuma = meanLumaInBox(image, centreX, centreY, innerHalfWidth, innerHalfHeight);

  // The ring: sample four points between the key square and the marker edge.
  const ringOffsetX = boxWidth * 0.36;
  const ringOffsetY = boxHeight * 0.36;
  const ringSamples = [
    meanLumaInBox(image, centreX - ringOffsetX, centreY, innerHalfWidth, innerHalfHeight),
    meanLumaInBox(image, centreX + ringOffsetX, centreY, innerHalfWidth, innerHalfHeight),
    meanLumaInBox(image, centreX, centreY - ringOffsetY, innerHalfWidth, innerHalfHeight),
    meanLumaInBox(image, centreX, centreY + ringOffsetY, innerHalfWidth, innerHalfHeight),
  ].filter((value): value is number => value !== null);

  if (innerLuma === null || ringSamples.length === 0) return 0;
  const ringLuma = ringSamples.reduce((a, b) => a + b, 0) / ringSamples.length;
  return innerLuma - ringLuma;
}

function meanLumaInBox(
  image: RgbaImage,
  centreX: number,
  centreY: number,
  halfWidth: number,
  halfHeight: number,
  grid = 5,
): number | null {
  let sum = 0;
  let count = 0;
  for (let iy = 0; iy < grid; iy++) {
    const fy = grid === 1 ? 0.5 : iy / (grid - 1);
    const y = centreY + (fy * 2 - 1) * halfHeight;
    for (let ix = 0; ix < grid; ix++) {
      const fx = grid === 1 ? 0.5 : ix / (grid - 1);
      const x = centreX + (fx * 2 - 1) * halfWidth;
      const sample = bilinearSampleEncoded(image, x, y);
      if (!sample) continue;
      sum += 0.2126 * sample.r + 0.7152 * sample.g + 0.0722 * sample.b;
      count++;
    }
  }
  return count === 0 ? null : sum / count;
}

export function detectCard(image: RgbaImage): DetectionResult {
  if (image.width < 120 || image.height < 120) {
    return fail('image-too-small', 'Camera frame is too small to analyse.', 0);
  }

  const { image: small, scale } = downscaleRgba(image, DETECTION_MAX_DIMENSION);
  const gray = toGrayscale(small);
  const threshold = otsuThreshold(gray);

  const frameArea = small.width * small.height;
  const blobs = findDarkBlobs(gray.data, small.width, small.height, threshold);
  const candidates = blobs
    .filter((blob) => isMarkerCandidate(blob, frameArea))
    .sort((a, b) => b.area - a.area)
    .slice(0, MAX_CANDIDATES_CONSIDERED);

  if (candidates.length < 4) {
    return fail(
      'too-few-marker-candidates',
      candidates.length === 0
        ? 'No corner markers found. Make sure the whole reference card is in frame.'
        : 'Only part of the reference card is visible. Fit all four corner markers in frame.',
      candidates.length,
    );
  }

  const scored = combinations(candidates, 4)
    .map(scoreQuad)
    .filter((candidate): candidate is QuadCandidate => candidate !== null)
    .sort((a, b) => a.score - b.score);

  if (scored.length === 0) {
    return fail(
      'no-plausible-quad',
      'Could not match four corner markers to the card shape. Hold the card flatter and fill more of the frame.',
      candidates.length,
    );
  }

  // Validate candidate quads in score order and accept the first that passes
  // every check, rather than committing to the best-scoring quad and validating
  // it afterwards. Under strong perspective the calibration patches foreshorten
  // toward square and can out-score the real markers, so a single-shot guess is
  // not reliable; a validated search recovers the correct quad instead of failing.
  let firstFailure: DetectionFailure | null = null;

  for (const quad of scored.slice(0, MAX_QUADS_VALIDATED)) {
    const attempt = buildDetection(image, quad, scale, candidates.length);
    if (attempt.ok) return attempt;
    if (!firstFailure) firstFailure = attempt;
  }

  return (
    firstFailure ??
    fail(
      'no-plausible-quad',
      'Could not match four corner markers to the card shape. Hold the card flatter and fill more of the frame.',
      candidates.length,
    )
  );
}

/** Attempts to turn one candidate quad into a validated detection. */
function buildDetection(
  image: RgbaImage,
  best: QuadCandidate,
  scale: number,
  candidateCount: number,
): DetectionResult {
  // Identify the top-left marker by its white key square.
  const contrasts = best.blobs.map((blob) => ({
    blob,
    contrast: measureOrientationContrast(image, blob, scale),
  }));
  contrasts.sort((a, b) => b.contrast - a.contrast);
  const keyed = contrasts[0];

  if (keyed.contrast < MIN_ORIENTATION_CONTRAST) {
    return fail(
      'orientation-key-not-found',
      'Could not read the orientation marker in the top-left corner. Clean the card and avoid glare on that corner.',
      candidateCount,
    );
  }

  const topLeft = keyed.blob.centroid;
  const cyclic = best.ordered;
  const keyIndex = cyclic.findIndex(
    (p) => Math.abs(p.x - topLeft.x) < 1e-9 && Math.abs(p.y - topLeft.y) < 1e-9,
  );
  if (keyIndex < 0) {
    return fail(
      'no-plausible-quad',
      'Internal ordering error while matching corner markers.',
      candidateCount,
    );
  }

  // The two neighbours of the top-left corner in the cyclic order are the
  // top-right and bottom-left corners. The card is landscape, so the further
  // neighbour is the top-right one. This resolves handedness without assuming
  // anything about how the card was rotated in frame.
  const previous = cyclic[(keyIndex + 3) % 4];
  const next = cyclic[(keyIndex + 1) % 4];
  const opposite = cyclic[(keyIndex + 2) % 4];

  const distanceNext = Math.hypot(next.x - topLeft.x, next.y - topLeft.y);
  const distancePrevious = Math.hypot(previous.x - topLeft.x, previous.y - topLeft.y);

  const topRight = distanceNext >= distancePrevious ? next : previous;
  const bottomLeft = distanceNext >= distancePrevious ? previous : next;
  const bottomRight = opposite;

  const orderedSmall = [topLeft, topRight, bottomRight, bottomLeft];
  const markersPx = orderedSmall.map((p) => ({ x: p.x / scale, y: p.y / scale }));

  const cardToImage = computeHomography(FIDUCIAL_CENTRES_MM, markersPx);
  if (!cardToImage) {
    return fail(
      'degenerate-homography',
      'Corner markers do not form a usable shape. Reposition and try again.',
      candidateCount,
    );
  }
  const imageToCard = invertHomography(cardToImage);
  if (!imageToCard) {
    return fail(
      'degenerate-homography',
      'Corner markers do not form a usable shape. Reposition and try again.',
      candidateCount,
    );
  }

  // Sanity check the scale: project each printed marker outline through the
  // homography we just derived and compare its area with the blob's actual area.
  for (let i = 0; i < orderedSmall.length; i++) {
    const point = orderedSmall[i];
    const blob = best.blobs.find(
      (b) => Math.abs(b.centroid.x - point.x) < 1e-9 && Math.abs(b.centroid.y - point.y) < 1e-9,
    );
    if (!blob) continue;

    const expectedAreaPx = projectedRectAreaPx(FIDUCIALS[i].rect, cardToImage);
    if (expectedAreaPx === null || expectedAreaPx <= 0) continue;

    // Blob areas are counted at detection resolution; rescale to full resolution.
    const actualAreaPx = blob.area / (scale * scale);
    const agreement = actualAreaPx / expectedAreaPx;

    if (agreement < MIN_MARKER_AREA_AGREEMENT || agreement > MAX_MARKER_AREA_AGREEMENT) {
      // Two situations produce this: a very oblique view, or something dark
      // overlapping a marker. The message covers both rather than asserting a
      // cause the code cannot actually distinguish.
      return fail(
        'marker-size-implausible',
        'Could not read the corner markers reliably. Hold the camera square to the card, fit the whole card in frame, and keep anything dark clear of the corners.',
        candidateCount,
      );
    }
  }

  const longSide = Math.hypot(topRight.x - topLeft.x, topRight.y - topLeft.y);
  const shortSide = Math.hypot(bottomLeft.x - topLeft.x, bottomLeft.y - topLeft.y);
  const quadAspect = shortSide > 0 ? longSide / shortSide : 0;

  const markerQuadArea = Math.abs(shoelace(markersPx));
  const cardCoverage = markerQuadArea / (image.width * image.height);

  return {
    ok: true,
    cardToImage,
    imageToCard,
    markersPx,
    quadAspect,
    orientationContrast: keyed.contrast,
    cardCoverage,
  };
}

/** Pixel area of a card-space rectangle after projection through a homography. */
function projectedRectAreaPx(rect: RectMm, cardToImage: Homography): number | null {
  const corners: Point[] = [
    { x: rect.x, y: rect.y },
    { x: rect.x + rect.width, y: rect.y },
    { x: rect.x + rect.width, y: rect.y + rect.height },
    { x: rect.x, y: rect.y + rect.height },
  ];
  const projected: Point[] = [];
  for (const corner of corners) {
    const mapped = applyHomography(cardToImage, corner);
    if (!Number.isFinite(mapped.x) || !Number.isFinite(mapped.y)) return null;
    projected.push(mapped);
  }
  return Math.abs(shoelace(projected));
}

function shoelace(points: readonly Point[]): number {
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    area += a.x * b.y - b.x * a.y;
  }
  return area / 2;
}
