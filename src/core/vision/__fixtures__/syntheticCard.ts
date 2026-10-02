/**
 * Synthetic reference-card renderer for tests.
 *
 * This is the backbone of the test strategy. It renders the card defined in
 * card/spec.ts through an arbitrary homography, under an arbitrary illuminant,
 * with optional lighting gradient, defocus and sensor noise. Because we know
 * exactly what colour every point on the card *should* be and exactly what
 * distortion we applied, we can assert that the pipeline recovers the truth —
 * which is impossible to do rigorously with photographs of a real card, where the
 * ground truth is only ever approximately known.
 *
 * Rendering is inverse-mapped: for each output pixel we project back into card
 * space and evaluate the artwork there. That guarantees full coverage with no
 * seams or holes, which a forward-mapped rasteriser would produce under
 * perspective.
 */

import {
  hexToRgb,
  linearToSrgbChannel,
  srgbToLinear,
  type LinearRgb,
  type Rgb,
} from '../../color/space';
import {
  CARD_HEIGHT_MM,
  CARD_WIDTH_MM,
  FIDUCIALS,
  ORIENTATION_KEY_INNER_FRACTION,
  PATCHES,
  SAMPLE_WINDOW_MM,
  type RectMm,
} from '../../card/spec';
import { applyHomography, computeHomography, invertHomography, type Homography, type Point } from '../homography';
import type { RgbaImage } from '../image';

/** Deterministic PRNG so a failing test always fails the same way. */
function createRandom(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    // xorshift32
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x100000000;
  };
}

export interface IlluminationModel {
  /**
   * Per-channel linear gain, standing in for the illuminant's colour and
   * intensity. Neutral daylight is {1,1,1}; warm tungsten is something like
   * {1.25, 1.0, 0.62}.
   */
  gain: LinearRgb;
  /**
   * Spatial falloff, standing in for a light source off to one side or a shadow
   * across the card. `amount` is the fractional brightness drop at the far edge.
   */
  gradient?: {
    axis: 'x' | 'y' | 'radial';
    amount: number;
  };
}

export const NEUTRAL_ILLUMINATION: IlluminationModel = { gain: { r: 1, g: 1, b: 1 } };

/** Approximate tungsten: strongly warm, which is the hard case for white balance. */
export const TUNGSTEN_ILLUMINATION: IlluminationModel = {
  gain: { r: 1.28, g: 1.0, b: 0.55 },
};

/** Approximate deep shade / overcast: cool and dim. */
export const SHADE_ILLUMINATION: IlluminationModel = {
  gain: { r: 0.62, g: 0.7, b: 0.92 },
};

export interface SyntheticCardOptions {
  width?: number;
  height?: number;
  /** Card-millimetres to image-pixels. Defaults to a centred, slightly tilted view. */
  cardToImage?: Homography;
  illumination?: IlluminationModel;
  /** Colour occupying the sample window, as a hex string. Defaults to bare card. */
  sampleHex?: string;
  /** Gaussian-ish blur radius in pixels, applied after rendering. */
  blurRadius?: number;
  /** Additive noise amplitude in encoded units (0.01 is ~2.5 levels of 255). */
  noiseAmplitude?: number;
  seed?: number;
  /** Colour of the surface the card is lying on. */
  backgroundHex?: string;
  /** Card stock colour. Real card stock is very slightly off-white. */
  cardStockHex?: string;
}

function rectContains(rect: RectMm, p: Point): boolean {
  return (
    p.x >= rect.x && p.x <= rect.x + rect.width && p.y >= rect.y && p.y <= rect.y + rect.height
  );
}

/**
 * Builds a homography placing the card in frame with a given tilt.
 *
 * `tilt` values around 0.001-0.002 correspond to the mild perspective of a phone
 * held by hand; 0.004 and above is a pronounced angle.
 */
export function makeCardView(
  width: number,
  height: number,
  options: { marginFraction?: number; tiltX?: number; tiltY?: number; rotationDeg?: number } = {},
): Homography {
  const marginFraction = options.marginFraction ?? 0.08;
  const tiltX = options.tiltX ?? 0;
  const tiltY = options.tiltY ?? 0;
  const rotationDeg = options.rotationDeg ?? 0;

  // Fit the card into the frame with a margin, preserving aspect ratio.
  const usableWidth = width * (1 - 2 * marginFraction);
  const usableHeight = height * (1 - 2 * marginFraction);
  const scale = Math.min(usableWidth / CARD_WIDTH_MM, usableHeight / CARD_HEIGHT_MM);

  const cardCorners: Point[] = [
    { x: 0, y: 0 },
    { x: CARD_WIDTH_MM, y: 0 },
    { x: CARD_WIDTH_MM, y: CARD_HEIGHT_MM },
    { x: 0, y: CARD_HEIGHT_MM },
  ];

  const cx = width / 2;
  const cy = height / 2;
  const theta = (rotationDeg * Math.PI) / 180;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);

  // Place the card centred and rotated, then let the projective terms add tilt.
  const base: Homography = [
    scale * cos,
    -scale * sin,
    cx - scale * (cos * (CARD_WIDTH_MM / 2) - sin * (CARD_HEIGHT_MM / 2)),
    scale * sin,
    scale * cos,
    cy - scale * (sin * (CARD_WIDTH_MM / 2) + cos * (CARD_HEIGHT_MM / 2)),
    tiltX,
    tiltY,
    1,
  ];

  // Re-fit through the four corners so that the tilt does not push the card out
  // of frame: project, then rescale the projected quad back into the usable box.
  const projected = cardCorners.map((p) => applyHomography(base, p));
  const minX = Math.min(...projected.map((p) => p.x));
  const maxX = Math.max(...projected.map((p) => p.x));
  const minY = Math.min(...projected.map((p) => p.y));
  const maxY = Math.max(...projected.map((p) => p.y));

  const fitScale = Math.min(usableWidth / (maxX - minX), usableHeight / (maxY - minY));
  const projectedCx = (minX + maxX) / 2;
  const projectedCy = (minY + maxY) / 2;

  const adjusted = projected.map((p) => ({
    x: cx + (p.x - projectedCx) * fitScale,
    y: cy + (p.y - projectedCy) * fitScale,
  }));

  const refitted = computeHomography(cardCorners, adjusted);
  if (!refitted) throw new Error('makeCardView produced a degenerate view');
  return refitted;
}

/** The card's own reflectance colour at a point, in gamma-encoded sRGB. */
export function cardArtworkAt(
  point: Point,
  options: { sampleHex?: string; cardStockHex?: string } = {},
): Rgb | null {
  if (point.x < 0 || point.y < 0 || point.x > CARD_WIDTH_MM || point.y > CARD_HEIGHT_MM) {
    return null;
  }

  for (const fiducial of FIDUCIALS) {
    if (!rectContains(fiducial.rect, point)) continue;
    if (fiducial.hasOrientationKey) {
      const inner = fiducial.rect.width * ORIENTATION_KEY_INNER_FRACTION;
      const innerRect: RectMm = {
        x: fiducial.rect.x + (fiducial.rect.width - inner) / 2,
        y: fiducial.rect.y + (fiducial.rect.height - inner) / 2,
        width: inner,
        height: inner,
      };
      if (rectContains(innerRect, point)) return hexToRgb('#ffffff');
    }
    // Real printed black is not zero reflectance.
    return hexToRgb('#101010');
  }

  for (const patch of PATCHES) {
    if (rectContains(patch.rect, point)) return hexToRgb(patch.nominalHex);
  }

  if (options.sampleHex && rectContains(SAMPLE_WINDOW_MM, point)) {
    return hexToRgb(options.sampleHex);
  }

  return hexToRgb(options.cardStockHex ?? '#fdfdfb');
}

function applyIllumination(
  linear: LinearRgb,
  illumination: IlluminationModel,
  u: number,
  v: number,
): LinearRgb {
  let falloff = 1;
  const gradient = illumination.gradient;
  if (gradient) {
    let t: number;
    if (gradient.axis === 'x') t = u;
    else if (gradient.axis === 'y') t = v;
    else t = Math.min(1, Math.hypot(u - 0.5, v - 0.5) / Math.SQRT1_2);
    falloff = 1 - gradient.amount * t;
  }
  return {
    r: linear.r * illumination.gain.r * falloff,
    g: linear.g * illumination.gain.g * falloff,
    b: linear.b * illumination.gain.b * falloff,
  };
}

export interface SyntheticCardResult {
  image: RgbaImage;
  /** The exact homography used, so tests can compare against detection output. */
  cardToImage: Homography;
  /** Where the four fiducial centres landed, in pixels. */
  fiducialCentresPx: Point[];
}

export function renderSyntheticCard(options: SyntheticCardOptions = {}): SyntheticCardResult {
  const width = options.width ?? 960;
  const height = options.height ?? 640;
  const illumination = options.illumination ?? NEUTRAL_ILLUMINATION;
  const noiseAmplitude = options.noiseAmplitude ?? 0;
  const random = createRandom(options.seed ?? 12345);

  const cardToImage = options.cardToImage ?? makeCardView(width, height, { tiltX: 0.0008 });
  const imageToCard = invertHomography(cardToImage);
  if (!imageToCard) throw new Error('Supplied cardToImage homography is not invertible');

  const background = srgbToLinear(hexToRgb(options.backgroundHex ?? '#4a4a52'));
  const data = new Uint8ClampedArray(width * height * 4);

  for (let py = 0; py < height; py++) {
    for (let px = 0; px < width; px++) {
      const cardPoint = applyHomography(imageToCard, { x: px + 0.5, y: py + 0.5 });
      const artwork = Number.isFinite(cardPoint.x)
        ? cardArtworkAt(cardPoint, {
            sampleHex: options.sampleHex,
            cardStockHex: options.cardStockHex,
          })
        : null;

      const reflectanceLinear = artwork ? srgbToLinear(artwork) : background;

      const lit = applyIllumination(
        reflectanceLinear,
        illumination,
        px / (width - 1),
        py / (height - 1),
      );

      const q = (py * width + px) * 4;
      data[q] = encode(lit.r, noiseAmplitude, random);
      data[q + 1] = encode(lit.g, noiseAmplitude, random);
      data[q + 2] = encode(lit.b, noiseAmplitude, random);
      data[q + 3] = 255;
    }
  }

  let image: RgbaImage = { width, height, data };
  if (options.blurRadius && options.blurRadius > 0) {
    image = boxBlur(image, Math.round(options.blurRadius));
  }

  return {
    image,
    cardToImage,
    fiducialCentresPx: FIDUCIALS.map((f) => applyHomography(cardToImage, f.centre)),
  };
}

function encode(linearValue: number, noiseAmplitude: number, random: () => number): number {
  let encoded = linearToSrgbChannel(Math.max(0, linearValue));
  if (noiseAmplitude > 0) {
    // Symmetric noise so it does not bias the mean.
    encoded += (random() - 0.5) * 2 * noiseAmplitude;
  }
  return Math.round(Math.min(1, Math.max(0, encoded)) * 255);
}

/**
 * Repeated box blur, which approaches a Gaussian. Used to simulate defocus so the
 * blur-rejection gate can be tested against something realistic.
 */
export function boxBlur(image: RgbaImage, radius: number): RgbaImage {
  if (radius <= 0) return image;
  let current = image;
  for (let pass = 0; pass < 3; pass++) {
    current = singleBoxBlur(current, radius);
  }
  return current;
}

function singleBoxBlur(image: RgbaImage, radius: number): RgbaImage {
  const { width, height, data } = image;
  const horizontal = new Uint8ClampedArray(data.length);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let count = 0;
      for (let dx = -radius; dx <= radius; dx++) {
        const sx = x + dx;
        if (sx < 0 || sx >= width) continue;
        const p = (y * width + sx) * 4;
        r += data[p];
        g += data[p + 1];
        b += data[p + 2];
        count++;
      }
      const q = (y * width + x) * 4;
      horizontal[q] = r / count;
      horizontal[q + 1] = g / count;
      horizontal[q + 2] = b / count;
      horizontal[q + 3] = 255;
    }
  }

  const out = new Uint8ClampedArray(data.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let count = 0;
      for (let dy = -radius; dy <= radius; dy++) {
        const sy = y + dy;
        if (sy < 0 || sy >= height) continue;
        const p = (sy * width + x) * 4;
        r += horizontal[p];
        g += horizontal[p + 1];
        b += horizontal[p + 2];
        count++;
      }
      const q = (y * width + x) * 4;
      out[q] = r / count;
      out[q + 1] = g / count;
      out[q + 2] = b / count;
      out[q + 3] = 255;
    }
  }

  return { width, height, data: out };
}
