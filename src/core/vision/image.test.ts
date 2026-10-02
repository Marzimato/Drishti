import { describe, expect, it } from 'vitest';
import { hexToRgb, srgbToLinear } from '../color/space';
import { NEUTRAL_RAMP, PATCHES, SAMPLE_WINDOW_MM, patchSampleRect } from '../card/spec';
import {
  assertValidImage,
  bilinearSampleEncoded,
  downscaleRgba,
  laplacianVariance,
  otsuThreshold,
  regionMeanLuma,
  sampleCardRegion,
  toGrayscale,
  trimmedMean,
  type RgbaImage,
} from './image';
import {
  NEUTRAL_ILLUMINATION,
  makeCardView,
  renderSyntheticCard,
} from './__fixtures__/syntheticCard';

function solidImage(width: number, height: number, r: number, g: number, b: number): RgbaImage {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = r;
    data[i * 4 + 1] = g;
    data[i * 4 + 2] = b;
    data[i * 4 + 3] = 255;
  }
  return { width, height, data };
}

describe('assertValidImage', () => {
  it('accepts a well-formed buffer', () => {
    expect(() => assertValidImage(solidImage(4, 4, 0, 0, 0))).not.toThrow();
  });

  it('rejects a buffer whose length disagrees with its dimensions', () => {
    expect(() => assertValidImage({ width: 4, height: 4, data: new Uint8ClampedArray(10) })).toThrow(
      /does not match/,
    );
  });

  it('rejects zero-sized images', () => {
    expect(() => assertValidImage({ width: 0, height: 4, data: new Uint8ClampedArray(0) })).toThrow();
  });
});

describe('toGrayscale', () => {
  it('maps white to 1 and black to 0', () => {
    expect(toGrayscale(solidImage(2, 2, 255, 255, 255)).data[0]).toBeCloseTo(1, 6);
    expect(toGrayscale(solidImage(2, 2, 0, 0, 0)).data[0]).toBeCloseTo(0, 6);
  });

  it('weights green above red above blue', () => {
    const green = toGrayscale(solidImage(1, 1, 0, 255, 0)).data[0];
    const red = toGrayscale(solidImage(1, 1, 255, 0, 0)).data[0];
    const blue = toGrayscale(solidImage(1, 1, 0, 0, 255)).data[0];
    expect(green).toBeGreaterThan(red);
    expect(red).toBeGreaterThan(blue);
  });
});

describe('downscaleRgba', () => {
  it('leaves small images untouched', () => {
    const image = solidImage(10, 10, 100, 100, 100);
    const result = downscaleRgba(image, 100);
    expect(result.scale).toBe(1);
    expect(result.image).toBe(image);
  });

  it('reduces dimensions and reports the achieved scale', () => {
    const image = solidImage(1000, 500, 128, 64, 32);
    const result = downscaleRgba(image, 250);
    expect(Math.max(result.image.width, result.image.height)).toBeLessThanOrEqual(250);
    expect(result.scale).toBeCloseTo(result.image.width / image.width, 12);
  });

  it('preserves a uniform colour exactly', () => {
    const result = downscaleRgba(solidImage(400, 400, 90, 140, 200), 100);
    expect(result.image.data[0]).toBe(90);
    expect(result.image.data[1]).toBe(140);
    expect(result.image.data[2]).toBe(200);
  });

  it('averages a half-black half-white image toward mid grey', () => {
    const width = 200;
    const height = 200;
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const value = x < width / 2 ? 0 : 255;
        const p = (y * width + x) * 4;
        data[p] = value;
        data[p + 1] = value;
        data[p + 2] = value;
        data[p + 3] = 255;
      }
    }
    const result = downscaleRgba({ width, height, data }, 2);
    // Downscaling to 2x2 means each output pixel covers one solid half.
    expect(result.image.width).toBe(2);
    expect(result.image.data[0]).toBe(0);
    expect(result.image.data[4]).toBe(255);
  });
});

describe('otsuThreshold', () => {
  it('finds a threshold between two well-separated populations', () => {
    const width = 100;
    const height = 100;
    const data = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < width * height; i++) {
      const value = i % 2 === 0 ? 20 : 230;
      data[i * 4] = value;
      data[i * 4 + 1] = value;
      data[i * 4 + 2] = value;
      data[i * 4 + 3] = 255;
    }
    const threshold = otsuThreshold(toGrayscale({ width, height, data }));
    expect(threshold).toBeGreaterThan(20 / 255);
    expect(threshold).toBeLessThan(230 / 255);
    // The threshold should sit in the empty valley, near the midpoint, rather
    // than resting on either population.
    expect(threshold).toBeCloseTo(125 / 255, 2);
  });

  it('adapts to an overall dark exposure', () => {
    // The same bimodal structure, but four times darker: a fixed threshold would
    // classify everything as dark, Otsu should still split the two groups.
    const width = 100;
    const height = 100;
    const data = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < width * height; i++) {
      const value = i % 2 === 0 ? 5 : 60;
      data[i * 4] = value;
      data[i * 4 + 1] = value;
      data[i * 4 + 2] = value;
      data[i * 4 + 3] = 255;
    }
    const threshold = otsuThreshold(toGrayscale({ width, height, data }));
    expect(threshold).toBeGreaterThan(5 / 255);
    expect(threshold).toBeLessThan(60 / 255);
    expect(threshold).toBeCloseTo(32.5 / 255, 2);
  });

  it('leaves a margin on both sides even with unequal population sizes', () => {
    // Mostly white card with a small dark region, which is the real histogram
    // shape for a card photograph. The threshold must still clear the dark pixels.
    const width = 100;
    const height = 100;
    const data = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < width * height; i++) {
      const value = i < width * height * 0.08 ? 16 : 245;
      data[i * 4] = value;
      data[i * 4 + 1] = value;
      data[i * 4 + 2] = value;
      data[i * 4 + 3] = 255;
    }
    const threshold = otsuThreshold(toGrayscale({ width, height, data }));
    expect(threshold).toBeGreaterThan(30 / 255);
    expect(threshold).toBeLessThan(230 / 255);
  });

  it('returns mid grey for a uniform image instead of throwing', () => {
    expect(otsuThreshold(toGrayscale(solidImage(10, 10, 128, 128, 128)))).toBe(0.5);
  });
});

describe('laplacianVariance', () => {
  it('is zero for a flat image', () => {
    expect(laplacianVariance(toGrayscale(solidImage(20, 20, 128, 128, 128)))).toBeCloseTo(0, 12);
  });

  it('drops sharply when an image is blurred', () => {
    const sharp = renderSyntheticCard({ width: 480, height: 320 });
    const blurred = renderSyntheticCard({ width: 480, height: 320, blurRadius: 4 });
    const sharpScore = laplacianVariance(toGrayscale(sharp.image));
    const blurredScore = laplacianVariance(toGrayscale(blurred.image));
    expect(sharpScore).toBeGreaterThan(blurredScore * 5);
  });
});

describe('bilinearSampleEncoded', () => {
  it('returns the exact value at pixel centres of a uniform image', () => {
    const sample = bilinearSampleEncoded(solidImage(10, 10, 51, 102, 153), 4, 4);
    expect(sample).not.toBeNull();
    expect(sample!.r).toBeCloseTo(51 / 255, 6);
    expect(sample!.g).toBeCloseTo(102 / 255, 6);
    expect(sample!.b).toBeCloseTo(153 / 255, 6);
  });

  it('interpolates halfway between two pixels', () => {
    const data = new Uint8ClampedArray(2 * 1 * 4);
    data[0] = 0;
    data[1] = 0;
    data[2] = 0;
    data[3] = 255;
    data[4] = 200;
    data[5] = 200;
    data[6] = 200;
    data[7] = 255;
    const sample = bilinearSampleEncoded({ width: 2, height: 1, data }, 0.5, 0);
    expect(sample!.r).toBeCloseTo(100 / 255, 6);
  });

  it('returns null outside the frame', () => {
    const image = solidImage(10, 10, 0, 0, 0);
    expect(bilinearSampleEncoded(image, -0.5, 5)).toBeNull();
    expect(bilinearSampleEncoded(image, 5, 9.5)).toBeNull();
    expect(bilinearSampleEncoded(image, Number.NaN, 5)).toBeNull();
  });
});

describe('trimmedMean', () => {
  it('matches the plain mean for clean data', () => {
    expect(trimmedMean([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.1)).toBeCloseTo(5.5, 10);
  });

  it('rejects extreme outliers that would drag a plain mean', () => {
    // One glare speck reading 100x too bright.
    const values = [0.5, 0.51, 0.49, 0.5, 0.52, 0.48, 0.5, 0.51, 0.49, 50];
    const plain = values.reduce((a, b) => a + b, 0) / values.length;
    const trimmed = trimmedMean(values, 0.1);
    expect(plain).toBeGreaterThan(5);
    expect(trimmed).toBeCloseTo(0.5, 2);
  });

  it('degrades to the plain mean when trimming would remove everything', () => {
    expect(trimmedMean([3, 5], 0.5)).toBeCloseTo(4, 10);
  });

  it('handles an empty input', () => {
    expect(trimmedMean([], 0.1)).toBe(0);
  });
});

describe('sampleCardRegion', () => {
  it('recovers each patch colour under neutral light with a known homography', () => {
    // The strongest single check on the sampling path: render the card, then read
    // the patches back and confirm we get the printed values in linear light.
    const rendered = renderSyntheticCard({
      width: 1200,
      height: 800,
      illumination: NEUTRAL_ILLUMINATION,
    });

    for (const patch of PATCHES) {
      const sample = sampleCardRegion(rendered.image, rendered.cardToImage, patchSampleRect(patch));
      const expected = srgbToLinear(hexToRgb(patch.nominalHex));

      expect(sample.sampleCount).toBeGreaterThan(100);
      expect(sample.outOfFrameFraction).toBe(0);
      // 8-bit quantisation plus bilinear interpolation is the only error source
      // here, so agreement should be tight.
      expect(sample.linear.r).toBeCloseTo(expected.r, 3);
      expect(sample.linear.g).toBeCloseTo(expected.g, 3);
      expect(sample.linear.b).toBeCloseTo(expected.b, 3);
    }
  });

  it('still recovers patch colours through a pronounced perspective tilt', () => {
    const rendered = renderSyntheticCard({
      width: 1200,
      height: 800,
      cardToImage: makeCardView(1200, 800, { tiltX: 0.0035, tiltY: 0.0018, rotationDeg: 7 }),
    });

    for (const patch of PATCHES) {
      const sample = sampleCardRegion(rendered.image, rendered.cardToImage, patchSampleRect(patch));
      const expected = srgbToLinear(hexToRgb(patch.nominalHex));
      expect(sample.linear.r).toBeCloseTo(expected.r, 2);
      expect(sample.linear.g).toBeCloseTo(expected.g, 2);
      expect(sample.linear.b).toBeCloseTo(expected.b, 2);
    }
  });

  it('reports a low standard deviation on a uniform patch', () => {
    const rendered = renderSyntheticCard({ width: 1200, height: 800 });
    const sample = sampleCardRegion(
      rendered.image,
      rendered.cardToImage,
      patchSampleRect(PATCHES[7]),
    );
    expect(sample.stdLinear.r).toBeLessThan(0.01);
    expect(sample.stdLinear.g).toBeLessThan(0.01);
    expect(sample.stdLinear.b).toBeLessThan(0.01);
  });

  it('reports clipping when the exposure blows out', () => {
    /**
     * Samples the *lightest neutral* by role rather than PATCHES[0] by index.
     *
     * The index version silently depended on whichever patch happened to sit in
     * slot 0. When the neutral ramp was re-spaced for card v3 that slot went from
     * level 132 (linear 0.223) to level 112 (linear 0.162), and at 6x gain the
     * result landed at 0.97 — just short of clipping. The test then failed for a
     * reason that had nothing to do with clipping detection.
     */
    const rendered = renderSyntheticCard({
      width: 600,
      height: 400,
      illumination: { gain: { r: 6, g: 6, b: 6 } },
    });
    const sample = sampleCardRegion(
      rendered.image,
      rendered.cardToImage,
      patchSampleRect(NEUTRAL_RAMP[0]),
    );
    expect(sample.clippedFraction).toBeGreaterThan(0.9);
  });

  it('reports out-of-frame sampling rather than inventing values', () => {
    const rendered = renderSyntheticCard({ width: 400, height: 300 });
    // A region far outside the card, and therefore outside the frame.
    const sample = sampleCardRegion(rendered.image, rendered.cardToImage, {
      x: 5000,
      y: 5000,
      width: 10,
      height: 10,
    });
    expect(sample.outOfFrameFraction).toBe(1);
    expect(sample.sampleCount).toBe(0);
  });

  it('averages in linear light, not in gamma-encoded values', () => {
    // Half the region black, half white. The correct linear mean is 0.5.
    // Averaging encoded values then decoding would give ~0.216, a 2x error.
    const width = 200;
    const height = 200;
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const value = x < width / 2 ? 0 : 255;
        const p = (y * width + x) * 4;
        data[p] = value;
        data[p + 1] = value;
        data[p + 2] = value;
        data[p + 3] = 255;
      }
    }
    // Identity homography over a 200x200 card-space region.
    const identity = [1, 0, 0, 0, 1, 0, 0, 0, 1] as const;
    const sample = sampleCardRegion({ width, height, data }, identity, {
      x: 0,
      y: 0,
      width: 199,
      height: 199,
    });
    expect(sample.rawMeanLinear.r).toBeCloseTo(0.5, 2);
  });
});

describe('regionMeanLuma', () => {
  it('reads the orientation key as bright and plain black as dark', () => {
    const rendered = renderSyntheticCard({ width: 1200, height: 800 });
    // Centre of the top-left fiducial contains the white orientation key.
    const keyLuma = regionMeanLuma(rendered.image, rendered.cardToImage, {
      x: 5.7,
      y: 5.7,
      width: 1.6,
      height: 1.6,
    });
    // Centre of the top-right fiducial is solid black.
    const plainLuma = regionMeanLuma(rendered.image, rendered.cardToImage, {
      x: 81.6,
      y: 5.7,
      width: 1.6,
      height: 1.6,
    });
    expect(keyLuma).not.toBeNull();
    expect(plainLuma).not.toBeNull();
    expect(keyLuma!).toBeGreaterThan(0.5);
    expect(plainLuma!).toBeLessThan(0.15);
  });

  it('returns null when the region is entirely outside the frame', () => {
    const rendered = renderSyntheticCard({ width: 300, height: 200 });
    expect(
      regionMeanLuma(rendered.image, rendered.cardToImage, {
        x: -9000,
        y: -9000,
        width: 1,
        height: 1,
      }),
    ).toBeNull();
  });
});

describe('synthetic sample window', () => {
  it('renders a requested result colour into the sample window', () => {
    const rendered = renderSyntheticCard({ width: 1000, height: 700, sampleHex: '#6b2f8a' });
    const sample = sampleCardRegion(rendered.image, rendered.cardToImage, {
      x: SAMPLE_WINDOW_MM.x + 10,
      y: SAMPLE_WINDOW_MM.y + 3,
      width: 20,
      height: 6,
    });
    const expected = srgbToLinear(hexToRgb('#6b2f8a'));
    expect(sample.linear.r).toBeCloseTo(expected.r, 3);
    expect(sample.linear.g).toBeCloseTo(expected.g, 3);
    expect(sample.linear.b).toBeCloseTo(expected.b, 3);
  });
});
