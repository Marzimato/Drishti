import { describe, expect, it } from 'vitest';
import { CARD_HEIGHT_MM, CARD_WIDTH_MM, FIDUCIAL_CENTRES_MM, PATCHES, patchSampleRect } from '../card/spec';
import { hexToRgb, srgbToLinear } from '../color/space';
import { detectCard } from './detectCard';
import { applyHomography } from './homography';
import { sampleCardRegion, type RgbaImage } from './image';
import {
  SHADE_ILLUMINATION,
  TUNGSTEN_ILLUMINATION,
  makeCardView,
  renderSyntheticCard,
} from './__fixtures__/syntheticCard';

function expectMarkersNear(
  actual: readonly { x: number; y: number }[],
  expected: readonly { x: number; y: number }[],
  tolerancePx: number,
) {
  expect(actual).toHaveLength(expected.length);
  for (let i = 0; i < expected.length; i++) {
    expect(Math.hypot(actual[i].x - expected[i].x, actual[i].y - expected[i].y)).toBeLessThan(
      tolerancePx,
    );
  }
}

describe('detectCard', () => {
  it('finds the card in a straightforward capture', () => {
    const rendered = renderSyntheticCard({ width: 960, height: 640 });
    const result = detectCard(rendered.image);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expectMarkersNear(result.markersPx, rendered.fiducialCentresPx, 3);
    expect(result.orientationContrast).toBeGreaterThan(0.3);
    expect(result.cardCoverage).toBeGreaterThan(0.3);
  });

  it('recovers a homography accurate enough to sample patches correctly', () => {
    // The real acceptance criterion: does the *detected* homography (not the
    // ground-truth one) let us read the patch colours back?
    const rendered = renderSyntheticCard({ width: 1280, height: 860 });
    const result = detectCard(rendered.image);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    for (const patch of PATCHES) {
      const sample = sampleCardRegion(rendered.image, result.cardToImage, patchSampleRect(patch));
      const expected = srgbToLinear(hexToRgb(patch.nominalHex));
      expect(sample.linear.r).toBeCloseTo(expected.r, 2);
      expect(sample.linear.g).toBeCloseTo(expected.g, 2);
      expect(sample.linear.b).toBeCloseTo(expected.b, 2);
    }
  });

  it('handles in-plane rotation', () => {
    for (const rotationDeg of [-25, -12, 9, 20]) {
      const rendered = renderSyntheticCard({
        width: 1000,
        height: 1000,
        cardToImage: makeCardView(1000, 1000, { rotationDeg, marginFraction: 0.12 }),
      });
      const result = detectCard(rendered.image);
      expect(result.ok, `rotation ${rotationDeg} failed`).toBe(true);
      if (!result.ok) continue;
      expectMarkersNear(result.markersPx, rendered.fiducialCentresPx, 4);
    }
  });

  it('handles perspective tilt', () => {
    const rendered = renderSyntheticCard({
      width: 1100,
      height: 780,
      cardToImage: makeCardView(1100, 780, { tiltX: 0.0032, tiltY: 0.0016 }),
    });
    const result = detectCard(rendered.image);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expectMarkersNear(result.markersPx, rendered.fiducialCentresPx, 4);
  });

  it('resolves a 180-degree rotation using the orientation key', () => {
    // This is the failure mode the key square exists to prevent. Without it, an
    // upside-down card yields a geometrically perfect but semantically inverted
    // homography, and every patch is read from the wrong location.
    const rendered = renderSyntheticCard({
      width: 1100,
      height: 780,
      cardToImage: makeCardView(1100, 780, { rotationDeg: 180 }),
    });
    const result = detectCard(rendered.image);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // The detected top-left marker must correspond to card coordinate (6.5, 6.5),
    // which after a 180-degree rotation is at the bottom-right of the image.
    const expectedTopLeft = applyHomography(rendered.cardToImage, FIDUCIAL_CENTRES_MM[0]);
    expect(
      Math.hypot(result.markersPx[0].x - expectedTopLeft.x, result.markersPx[0].y - expectedTopLeft.y),
    ).toBeLessThan(4);

    // And patches must still read correctly, which is the point.
    for (const patch of PATCHES) {
      const sample = sampleCardRegion(rendered.image, result.cardToImage, patchSampleRect(patch));
      const expected = srgbToLinear(hexToRgb(patch.nominalHex));
      expect(sample.linear.g).toBeCloseTo(expected.g, 2);
    }
  });

  it('works under a strong tungsten cast', () => {
    const rendered = renderSyntheticCard({
      width: 1000,
      height: 700,
      illumination: TUNGSTEN_ILLUMINATION,
    });
    const result = detectCard(rendered.image);
    expect(result.ok).toBe(true);
  });

  it('works in dim shade', () => {
    const rendered = renderSyntheticCard({
      width: 1000,
      height: 700,
      illumination: SHADE_ILLUMINATION,
    });
    const result = detectCard(rendered.image);
    expect(result.ok).toBe(true);
  });

  it('works with a lighting gradient across the card', () => {
    const rendered = renderSyntheticCard({
      width: 1000,
      height: 700,
      illumination: { gain: { r: 1, g: 1, b: 1 }, gradient: { axis: 'x', amount: 0.45 } },
    });
    const result = detectCard(rendered.image);
    expect(result.ok).toBe(true);
  });

  it('tolerates sensor noise', () => {
    const rendered = renderSyntheticCard({
      width: 1000,
      height: 700,
      noiseAmplitude: 0.03,
      seed: 999,
    });
    const result = detectCard(rendered.image);
    expect(result.ok).toBe(true);
  });

  it('still detects when the card sits on a dark surface', () => {
    // A dark desk creates a large dark component that must be rejected by the
    // area and shape filters rather than mistaken for a marker.
    const rendered = renderSyntheticCard({
      width: 1000,
      height: 700,
      backgroundHex: '#0d0d10',
    });
    const result = detectCard(rendered.image);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expectMarkersNear(result.markersPx, rendered.fiducialCentresPx, 4);
  });

  it('still detects when the card sits on a light surface', () => {
    const rendered = renderSyntheticCard({
      width: 1000,
      height: 700,
      backgroundHex: '#f2f2ee',
    });
    const result = detectCard(rendered.image);
    expect(result.ok).toBe(true);
  });

  it('reports a specific failure when no card is present', () => {
    const width = 600;
    const height = 400;
    const data = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < width * height; i++) {
      data[i * 4] = 120;
      data[i * 4 + 1] = 118;
      data[i * 4 + 2] = 115;
      data[i * 4 + 3] = 255;
    }
    const result = detectCard({ width, height, data });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('too-few-marker-candidates');
    expect(result.message).toMatch(/reference card/i);
  });

  it('reports a failure when the card is partly out of frame', () => {
    // Crop away the right-hand markers.
    const rendered = renderSyntheticCard({ width: 1000, height: 700 });
    const cropWidth = 520;
    const cropped = new Uint8ClampedArray(cropWidth * 700 * 4);
    for (let y = 0; y < 700; y++) {
      for (let x = 0; x < cropWidth; x++) {
        const src = (y * 1000 + x) * 4;
        const dst = (y * cropWidth + x) * 4;
        cropped[dst] = rendered.image.data[src];
        cropped[dst + 1] = rendered.image.data[src + 1];
        cropped[dst + 2] = rendered.image.data[src + 2];
        cropped[dst + 3] = 255;
      }
    }
    const result = detectCard({ width: cropWidth, height: 700, data: cropped });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('too-few-marker-candidates');
  });

  it('rejects an image that is too small to analyse', () => {
    const result = detectCard({ width: 40, height: 40, data: new Uint8ClampedArray(40 * 40 * 4) });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('image-too-small');
  });

  it('rejects four dark squares that are not a reference card', () => {
    // Four solid black squares with no orientation key: the geometry is right but
    // the card identity check must still fail, so a hand-drawn imitation cannot
    // be passed off as a calibrated card.
    const width = 900;
    const height = 600;
    const data = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < width * height; i++) {
      data[i * 4] = 250;
      data[i * 4 + 1] = 250;
      data[i * 4 + 2] = 248;
      data[i * 4 + 3] = 255;
    }
    const squares = [
      [150, 150],
      [700, 150],
      [700, 450],
      [150, 450],
    ];
    for (const [cx, cy] of squares) {
      for (let y = cy - 28; y <= cy + 28; y++) {
        for (let x = cx - 28; x <= cx + 28; x++) {
          const p = (y * width + x) * 4;
          data[p] = 12;
          data[p + 1] = 12;
          data[p + 2] = 12;
        }
      }
    }
    const result = detectCard({ width, height, data });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('orientation-key-not-found');
  });

  it('produces a homography consistent with the card outline', () => {
    const rendered = renderSyntheticCard({ width: 1000, height: 700 });
    const result = detectCard(rendered.image);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Project the physical card corners and compare with the ground truth.
    const corners = [
      { x: 0, y: 0 },
      { x: CARD_WIDTH_MM, y: 0 },
      { x: CARD_WIDTH_MM, y: CARD_HEIGHT_MM },
      { x: 0, y: CARD_HEIGHT_MM },
    ];
    for (const corner of corners) {
      const expected = applyHomography(rendered.cardToImage, corner);
      const actual = applyHomography(result.cardToImage, corner);
      expect(Math.hypot(actual.x - expected.x, actual.y - expected.y)).toBeLessThan(6);
    }
  });

  it('round-trips points through the reported inverse homography', () => {
    const rendered = renderSyntheticCard({ width: 1000, height: 700 });
    const result = detectCard(rendered.image);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const probe = { x: 44.45, y: 27 };
    const toImage = applyHomography(result.cardToImage, probe);
    const back = applyHomography(result.imageToCard, toImage);
    expect(back.x).toBeCloseTo(probe.x, 4);
    expect(back.y).toBeCloseTo(probe.y, 4);
  });

  it('reports a plausible quad aspect ratio', () => {
    const rendered = renderSyntheticCard({ width: 1000, height: 700 });
    const result = detectCard(rendered.image);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // True marker-rectangle aspect is 75.9/41 = 1.851.
    expect(result.quadAspect).toBeGreaterThan(1.6);
    expect(result.quadAspect).toBeLessThan(2.1);
  });

  it('is not fooled by extra dark clutter in the background', () => {
    const rendered = renderSyntheticCard({ width: 1200, height: 800 });
    const data = new Uint8ClampedArray(rendered.image.data);
    const image: RgbaImage = { width: 1200, height: 800, data };

    // Scatter dark rectangles of marker-like size around the edges.
    const clutter = [
      [40, 40, 26, 26],
      [1140, 60, 30, 22],
      [60, 740, 24, 30],
      [1130, 730, 28, 28],
      [600, 30, 22, 22],
    ];
    for (const [x0, y0, w, h] of clutter) {
      for (let y = y0; y < Math.min(800, y0 + h); y++) {
        for (let x = x0; x < Math.min(1200, x0 + w); x++) {
          const p = (y * 1200 + x) * 4;
          data[p] = 10;
          data[p + 1] = 10;
          data[p + 2] = 14;
        }
      }
    }

    const result = detectCard(image);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expectMarkersNear(result.markersPx, rendered.fiducialCentresPx, 5);
  });
});
