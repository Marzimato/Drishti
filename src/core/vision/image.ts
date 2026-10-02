/**
 * Image buffer utilities and card-space region sampling.
 *
 * The critical correctness rule in this file: **all averaging happens in linear
 * light**. Camera frames arrive gamma-encoded, and the mean of gamma-encoded
 * values is not the encoding of the mean. Averaging encoded values biases every
 * patch reading dark, by an amount that varies with the patch, which would then
 * be baked into the correction matrix. This is the single easiest way to get a
 * colour pipeline subtly and consistently wrong.
 */

import {
  clamp01,
  srgbToLinearChannel,
  type LinearRgb,
} from '../color/space';
import { applyHomography, type Homography } from './homography';
import type { RectMm } from '../card/spec';

/** RGBA8 buffer, matching what `CanvasRenderingContext2D.getImageData` returns. */
export interface RgbaImage {
  width: number;
  height: number;
  /** Length must be width * height * 4. */
  data: Uint8ClampedArray | Uint8Array;
}

export interface GrayImage {
  width: number;
  height: number;
  /** Gamma-encoded luma in [0, 1]. */
  data: Float32Array;
}

export function assertValidImage(image: RgbaImage): void {
  const expected = image.width * image.height * 4;
  if (image.width <= 0 || image.height <= 0) {
    throw new Error(`Invalid image dimensions ${image.width}x${image.height}`);
  }
  if (image.data.length !== expected) {
    throw new Error(
      `Image buffer length ${image.data.length} does not match ${image.width}x${image.height}x4 (${expected})`,
    );
  }
}

/**
 * Rec. 709 luma on gamma-encoded values.
 *
 * Intentionally *not* linear-light luminance: thresholding and blur detection
 * operate better on a perceptually-spaced signal, and it is what the standard
 * computer vision literature assumes.
 */
export function toGrayscale(image: RgbaImage): GrayImage {
  assertValidImage(image);
  const { width, height, data } = image;
  const out = new Float32Array(width * height);
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    out[i] = (0.2126 * data[p] + 0.7152 * data[p + 1] + 0.0722 * data[p + 2]) / 255;
  }
  return { width, height, data: out };
}

/**
 * Box-filter downscale by an integer factor.
 *
 * Detection runs on a downscaled copy (fiducial markers are large, so the extra
 * resolution buys nothing but cost), while colour is always sampled from the
 * full-resolution frame so no averaging error is introduced before we want it.
 */
export function downscaleRgba(image: RgbaImage, maxDimension: number): {
  image: RgbaImage;
  scale: number;
} {
  assertValidImage(image);
  const longest = Math.max(image.width, image.height);
  if (longest <= maxDimension) return { image, scale: 1 };

  const factor = Math.ceil(longest / maxDimension);
  const width = Math.max(1, Math.floor(image.width / factor));
  const height = Math.max(1, Math.floor(image.height / factor));
  const out = new Uint8ClampedArray(width * height * 4);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let count = 0;
      const y0 = y * factor;
      const x0 = x * factor;
      for (let dy = 0; dy < factor; dy++) {
        const sy = y0 + dy;
        if (sy >= image.height) break;
        for (let dx = 0; dx < factor; dx++) {
          const sx = x0 + dx;
          if (sx >= image.width) break;
          const p = (sy * image.width + sx) * 4;
          r += image.data[p];
          g += image.data[p + 1];
          b += image.data[p + 2];
          a += image.data[p + 3];
          count++;
        }
      }
      const q = (y * width + x) * 4;
      out[q] = r / count;
      out[q + 1] = g / count;
      out[q + 2] = b / count;
      out[q + 3] = a / count;
    }
  }

  // The effective scale is measured, not assumed, because integer truncation
  // above means it is not exactly 1/factor.
  return { image: { width, height, data: out }, scale: width / image.width };
}

/**
 * Otsu's method: the split maximising between-class variance.
 *
 * Chosen over a fixed threshold because field lighting varies by orders of
 * magnitude between a shaded car interior and direct sunlight, and over adaptive
 * local thresholding because the fiducials are large solid blocks against white
 * card, which is exactly the bimodal case Otsu handles best.
 *
 * We return the **midpoint of the two class means** rather than the winning bin
 * index. For a cleanly bimodal histogram every bin between the two populations
 * yields an identical between-class variance, so the raw argmax is whichever one
 * the loop happens to visit first — which is the bin sitting directly on top of
 * the darker population. A threshold placed exactly at the dark population's own
 * value misclassifies half of it as soon as sensor noise is present. The midpoint
 * of the class means sits in the middle of the empty valley instead, which is
 * where a threshold belongs.
 */
export function otsuThreshold(gray: GrayImage): number {
  const bins = 256;
  const histogram = new Float64Array(bins);
  for (let i = 0; i < gray.data.length; i++) {
    const bin = Math.min(bins - 1, Math.max(0, Math.round(gray.data[i] * (bins - 1))));
    histogram[bin]++;
  }

  const total = gray.data.length;
  let sumAll = 0;
  for (let i = 0; i < bins; i++) sumAll += i * histogram[i];

  let weightBackground = 0;
  let sumBackground = 0;
  let bestVariance = -1;
  let bestMeanBackground = 0;
  let bestMeanForeground = bins - 1;
  let found = false;

  for (let t = 0; t < bins; t++) {
    weightBackground += histogram[t];
    if (weightBackground === 0) continue;
    const weightForeground = total - weightBackground;
    if (weightForeground === 0) break;

    sumBackground += t * histogram[t];
    const meanBackground = sumBackground / weightBackground;
    const meanForeground = (sumAll - sumBackground) / weightForeground;
    const delta = meanBackground - meanForeground;
    const variance = weightBackground * weightForeground * delta * delta;

    if (variance > bestVariance) {
      bestVariance = variance;
      bestMeanBackground = meanBackground;
      bestMeanForeground = meanForeground;
      found = true;
    }
  }

  // A completely uniform image has no valid split; mid-grey is the only sensible
  // answer and callers detect the degenerate case via component counts anyway.
  if (!found) return 0.5;

  return (bestMeanBackground + bestMeanForeground) / 2 / (bins - 1);
}

/**
 * Variance of the Laplacian, the standard cheap focus measure.
 *
 * A blurred capture is the most common cause of a wrong colour reading in
 * practice, because blur mixes a patch with its white surround and pulls every
 * measurement toward the background. Rejecting blur up front is more valuable
 * than any amount of downstream cleverness.
 */
export function laplacianVariance(gray: GrayImage): number {
  const { width, height, data } = gray;
  if (width < 3 || height < 3) return 0;

  const values: number[] = [];
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const laplacian =
        4 * data[i] - data[i - 1] - data[i + 1] - data[i - width] - data[i + width];
      values.push(laplacian);
    }
  }

  let mean = 0;
  for (const v of values) mean += v;
  mean /= values.length;

  let variance = 0;
  for (const v of values) variance += (v - mean) * (v - mean);
  return variance / values.length;
}

/** Bilinear RGB fetch in gamma-encoded [0,1]; null when outside the frame. */
export function bilinearSampleEncoded(
  image: RgbaImage,
  x: number,
  y: number,
): { r: number; g: number; b: number } | null {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  if (x < 0 || y < 0 || x > image.width - 1 || y > image.height - 1) return null;

  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(x0 + 1, image.width - 1);
  const y1 = Math.min(y0 + 1, image.height - 1);
  const fx = x - x0;
  const fy = y - y0;

  const idx = (px: number, py: number) => (py * image.width + px) * 4;
  const i00 = idx(x0, y0);
  const i10 = idx(x1, y0);
  const i01 = idx(x0, y1);
  const i11 = idx(x1, y1);

  const w00 = (1 - fx) * (1 - fy);
  const w10 = fx * (1 - fy);
  const w01 = (1 - fx) * fy;
  const w11 = fx * fy;

  const channel = (offset: number) =>
    (image.data[i00 + offset] * w00 +
      image.data[i10 + offset] * w10 +
      image.data[i01 + offset] * w01 +
      image.data[i11 + offset] * w11) /
    255;

  return { r: channel(0), g: channel(1), b: channel(2) };
}

export interface RegionSampleOptions {
  /** Samples taken across the region's width. */
  gridWidth?: number;
  /** Samples taken across the region's height. */
  gridHeight?: number;
  /**
   * Fraction discarded from each tail of each channel before averaging.
   * Defends against dust specks, print defects and small glare spots.
   */
  trimFraction?: number;
}

export interface RegionSample {
  /** Trimmed mean in linear light — the value the rest of the pipeline uses. */
  linear: LinearRgb;
  /** Untrimmed linear mean, for diagnostics. */
  rawMeanLinear: LinearRgb;
  /** Per-channel standard deviation in linear light, before trimming. */
  stdLinear: LinearRgb;
  /** Fraction of samples with any channel at or beyond the 8-bit rails. */
  clippedFraction: number;
  /** Fraction of the requested grid that fell outside the frame. */
  outOfFrameFraction: number;
  sampleCount: number;
}

const EMPTY_SAMPLE: RegionSample = {
  linear: { r: 0, g: 0, b: 0 },
  rawMeanLinear: { r: 0, g: 0, b: 0 },
  stdLinear: { r: 0, g: 0, b: 0 },
  clippedFraction: 1,
  outOfFrameFraction: 1,
  sampleCount: 0,
};

/**
 * Samples a rectangular region defined in card millimetres, using the homography
 * to find the corresponding pixels.
 *
 * Sampling on a grid in *card space* rather than iterating over pixels in image
 * space means the number of samples is independent of how large the card appears
 * in frame, so a close-up and a distant capture are weighted identically.
 */
export function sampleCardRegion(
  image: RgbaImage,
  cardToImage: Homography,
  rect: RectMm,
  options: RegionSampleOptions = {},
): RegionSample {
  const gridWidth = options.gridWidth ?? 24;
  const gridHeight = options.gridHeight ?? 16;
  const trimFraction = options.trimFraction ?? 0.1;

  const requested = gridWidth * gridHeight;
  if (requested === 0) return EMPTY_SAMPLE;

  const rs: number[] = [];
  const gs: number[] = [];
  const bs: number[] = [];
  let clipped = 0;
  let outOfFrame = 0;

  for (let iy = 0; iy < gridHeight; iy++) {
    // Sample at cell centres so the region's edges are never touched.
    const v = (iy + 0.5) / gridHeight;
    for (let ix = 0; ix < gridWidth; ix++) {
      const u = (ix + 0.5) / gridWidth;
      const cardPoint = { x: rect.x + u * rect.width, y: rect.y + v * rect.height };
      const imagePoint = applyHomography(cardToImage, cardPoint);
      const encoded = bilinearSampleEncoded(image, imagePoint.x, imagePoint.y);
      if (!encoded) {
        outOfFrame++;
        continue;
      }

      // A channel pinned at either rail carries no information about the true
      // scene value, so it is counted and reported rather than silently used.
      if (
        encoded.r <= 0.5 / 255 ||
        encoded.g <= 0.5 / 255 ||
        encoded.b <= 0.5 / 255 ||
        encoded.r >= 254.5 / 255 ||
        encoded.g >= 254.5 / 255 ||
        encoded.b >= 254.5 / 255
      ) {
        clipped++;
      }

      rs.push(srgbToLinearChannel(encoded.r));
      gs.push(srgbToLinearChannel(encoded.g));
      bs.push(srgbToLinearChannel(encoded.b));
    }
  }

  if (rs.length === 0) {
    return { ...EMPTY_SAMPLE, outOfFrameFraction: 1 };
  }

  const rawMeanLinear = { r: mean(rs), g: mean(gs), b: mean(bs) };

  return {
    linear: {
      r: trimmedMean(rs, trimFraction),
      g: trimmedMean(gs, trimFraction),
      b: trimmedMean(bs, trimFraction),
    },
    rawMeanLinear,
    stdLinear: {
      r: standardDeviation(rs, rawMeanLinear.r),
      g: standardDeviation(gs, rawMeanLinear.g),
      b: standardDeviation(bs, rawMeanLinear.b),
    },
    clippedFraction: clipped / rs.length,
    outOfFrameFraction: outOfFrame / requested,
    sampleCount: rs.length,
  };
}

function mean(values: readonly number[]): number {
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

function standardDeviation(values: readonly number[], average: number): number {
  if (values.length < 2) return 0;
  let sum = 0;
  for (const v of values) {
    const d = v - average;
    sum += d * d;
  }
  return Math.sqrt(sum / values.length);
}

/**
 * Mean of the values remaining after discarding `fraction` from each tail.
 * Falls back to the plain mean when the sample is too small to trim.
 */
export function trimmedMean(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0;
  if (fraction <= 0) return mean(values);

  const sorted = [...values].sort((a, b) => a - b);
  const drop = Math.floor(sorted.length * fraction);
  if (drop * 2 >= sorted.length) return mean(sorted);

  const kept = sorted.slice(drop, sorted.length - drop);
  return mean(kept);
}

/**
 * Flattens the card to a fixed-size, front-on image.
 *
 * Two uses. First, it makes the focus measure comparable across devices and
 * framings: Laplacian variance on the raw frame depends on sensor resolution and
 * on whatever background clutter happens to be in shot, whereas measured on a
 * rectified card of fixed pixel size it depends only on how sharp the card is.
 * Second, it gives the UI and the stored record a clean, human-checkable view of
 * exactly what the software measured.
 *
 * Pixels that fall outside the source frame are left fully transparent so callers
 * can tell real card content from padding.
 */
export function rectifyCard(
  image: RgbaImage,
  cardToImage: Homography,
  cardWidthMm: number,
  cardHeightMm: number,
  outputWidth = 445,
): RgbaImage {
  assertValidImage(image);
  const outputHeight = Math.max(1, Math.round((outputWidth * cardHeightMm) / cardWidthMm));
  const data = new Uint8ClampedArray(outputWidth * outputHeight * 4);

  for (let y = 0; y < outputHeight; y++) {
    const cardY = ((y + 0.5) / outputHeight) * cardHeightMm;
    for (let x = 0; x < outputWidth; x++) {
      const cardX = ((x + 0.5) / outputWidth) * cardWidthMm;
      const point = applyHomography(cardToImage, { x: cardX, y: cardY });
      const sample = bilinearSampleEncoded(image, point.x, point.y);
      const p = (y * outputWidth + x) * 4;
      if (!sample) continue;
      data[p] = Math.round(sample.r * 255);
      data[p + 1] = Math.round(sample.g * 255);
      data[p + 2] = Math.round(sample.b * 255);
      data[p + 3] = 255;
    }
  }

  return { width: outputWidth, height: outputHeight, data };
}

/** Mean encoded luma over a card-space region; used for the orientation key. */
export function regionMeanLuma(
  image: RgbaImage,
  cardToImage: Homography,
  rect: RectMm,
  gridSize = 9,
): number | null {
  let sum = 0;
  let count = 0;
  for (let iy = 0; iy < gridSize; iy++) {
    const v = (iy + 0.5) / gridSize;
    for (let ix = 0; ix < gridSize; ix++) {
      const u = (ix + 0.5) / gridSize;
      const point = applyHomography(cardToImage, {
        x: rect.x + u * rect.width,
        y: rect.y + v * rect.height,
      });
      const encoded = bilinearSampleEncoded(image, point.x, point.y);
      if (!encoded) continue;
      sum += 0.2126 * encoded.r + 0.7152 * encoded.g + 0.0722 * encoded.b;
      count++;
    }
  }
  return count === 0 ? null : clamp01(sum / count);
}
