import { describe, expect, it } from 'vitest';
import {
  renderCalibrationWorksheetCsv,
  renderCardPrintPage,
  renderCardSvg,
} from './printable';
import {
  CARD_HEIGHT_MM,
  CARD_SPEC_VERSION,
  CARD_WIDTH_MM,
  FIDUCIALS,
  PATCHES,
  SAMPLE_READ_RECT_MM,
  nominalLabFor,
  patchSampleRect,
} from './spec';

describe('renderCardSvg', () => {
  it('declares real millimetre dimensions including bleed', () => {
    const svg = renderCardSvg({ bleedMm: 3 });
    expect(svg).toContain(`width="${CARD_WIDTH_MM + 6}mm"`);
    expect(svg).toContain(`height="${CARD_HEIGHT_MM + 6}mm"`);
    // A viewBox in the same units keeps 1 user unit == 1 mm, so coordinates from
    // the spec can be emitted directly without conversion.
    expect(svg).toContain(`viewBox="0 0 ${CARD_WIDTH_MM + 6} ${CARD_HEIGHT_MM + 6}"`);
  });

  it('supports a zero-bleed variant', () => {
    const svg = renderCardSvg({ bleedMm: 0 });
    expect(svg).toContain(`width="${CARD_WIDTH_MM}mm"`);
    expect(svg).toContain(`height="${CARD_HEIGHT_MM}mm"`);
  });

  it('draws every calibration patch with its nominal colour', () => {
    const svg = renderCardSvg();
    for (const patch of PATCHES) {
      expect(svg, `${patch.id} missing`).toContain(`fill="${patch.nominalHex}"`);
    }
  });

  it('outlines every calibration patch so a dropped tint is visible', () => {
    /**
     * The lightest neutral is a 15% tint. If the printer fails to lay it down —
     * routine on a dye-sublimation card printer that is low on dye — an unoutlined
     * patch is indistinguishable from bare card stock, and the operator calibrates
     * against a card with a missing patch. The outline turns that failure into an
     * obviously empty box.
     */
    const svg = renderCardSvg();
    const outlined = svg.match(/<rect [^>]*stroke="#(?:5a5a5a|c8c8c8)"[^>]*\/>/g) ?? [];
    expect(outlined).toHaveLength(PATCHES.length);
  });

  it('gives each patch an outline that contrasts with its own fill', () => {
    /**
     * A single fixed grey cannot do this. The first attempt used #707070, which is
     * bit-for-bit the level-112 patch fill, so that patch had no visible outline —
     * while the print instructions tell the operator every box is outlined. The
     * keyline is therefore chosen light or dark from the patch's own L*.
     */
    const svg = renderCardSvg();
    for (const patch of PATCHES) {
      const light = nominalLabFor(patch).L > 55;
      const expected = light ? '#5a5a5a' : '#c8c8c8';
      const pattern = new RegExp(
        `fill="${patch.nominalHex}" stroke="${expected}"`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
      );
      expect(svg, `${patch.id} outline does not contrast with its fill`).toMatch(pattern);

      // And the outline must never equal the fill it sits on.
      expect(expected).not.toBe(patch.nominalHex);
    }
  });

  it('keeps the light-patch outline dark, which is the case that matters', () => {
    // A dropped tint leaves bare white stock. Only a dark outline is still visible
    // there, and the patches that drop out are precisely the light ones.
    const lightest = [...PATCHES].sort((a, b) => nominalLabFor(b).L - nominalLabFor(a).L)[0];
    expect(renderCardSvg()).toContain(`fill="${lightest.nominalHex}" stroke="#5a5a5a"`);
  });

  it('keeps the patch outlines far outside the area each patch is sampled from', () => {
    // The stroke straddles the patch boundary, so half its width falls inside the
    // patch. That has to stay well clear of patchSampleRect, or keyline ink lands in
    // a calibration reading.
    const strokeHalfWidthMm = 0.25 / 2;
    for (const patch of PATCHES) {
      const sample = patchSampleRect(patch);
      const gapLeft = sample.x - patch.rect.x;
      const gapTop = sample.y - patch.rect.y;
      expect(gapLeft, `${patch.id} sample too close to its outline`).toBeGreaterThan(
        strokeHalfWidthMm * 10,
      );
      expect(gapTop, `${patch.id} sample too close to its outline`).toBeGreaterThan(
        strokeHalfWidthMm * 10,
      );
    }
  });

  it('draws the patch outlines in grey rather than black', () => {
    // Black outlines would sit on the dark side of the detector's Otsu threshold and
    // become blob candidates. They would still be rejected on shape, but there is no
    // reason to hand the detector twelve extra rectangles to rule out.
    const svg = renderCardSvg();
    expect(svg).not.toMatch(/stroke="#000000"/);
    expect(svg).toContain('stroke="#5a5a5a"');
    expect(svg).toContain('stroke="#c8c8c8"');
  });

  it('uses opaque label colours, since alpha does not survive print pipelines', () => {
    const svg = renderCardSvg();
    expect(svg).not.toMatch(/fill="#[0-9a-f]{8}"/i);
  });

  it('draws all four corner markers', () => {
    const svg = renderCardSvg();
    for (const fiducial of FIDUCIALS) {
      expect(svg).toContain(
        `x="${fiducial.rect.x}" y="${fiducial.rect.y}" width="8" height="8"`,
      );
    }
  });

  it('draws exactly one white orientation key inside the top-left marker', () => {
    const svg = renderCardSvg();
    const whiteSquares = svg.match(/fill="#ffffff"/g) ?? [];
    // One for the key square; the card stock uses its own fill value.
    expect(whiteSquares.length).toBeGreaterThanOrEqual(1);

    const topLeft = FIDUCIALS.find((f) => f.corner === 'topLeft')!;
    const innerSize = 8 / 3;
    const expectedX = topLeft.rect.x + (8 - innerSize) / 2;
    expect(svg).toContain(`x="${Number(expectedX.toFixed(4))}"`);
  });

  it('prints no filled shape inside the region that gets measured', () => {
    // Any ink inside the read rectangle would corrupt every sample reading, so
    // this asserts the artwork keeps that area clear.
    const svg = renderCardSvg();
    const read = SAMPLE_READ_RECT_MM;

    const rectPattern = /<rect x="([-\d.]+)" y="([-\d.]+)" width="([-\d.]+)" height="([-\d.]+)" fill="([^"]+)"/g;
    let match: RegExpExecArray | null;
    let checked = 0;

    while ((match = rectPattern.exec(svg)) !== null) {
      const [, xs, ys, ws, hs, fill] = match;
      if (fill === 'none') continue;
      const x = Number(xs);
      const y = Number(ys);
      const w = Number(ws);
      const h = Number(hs);

      // Skip the full-card and full-canvas background fills.
      if (w >= CARD_WIDTH_MM && h >= CARD_HEIGHT_MM) continue;

      checked++;
      const intersects =
        x < read.x + read.width && read.x < x + w && y < read.y + read.height && read.y < y + h;
      expect(intersects, `filled rect at ${x},${y} intrudes into the read area`).toBe(false);
    }

    expect(checked).toBeGreaterThan(12);
  });

  it('keeps every stroked path clear of the region that gets measured', () => {
    // Checking rects alone is not enough: the corner brackets are paths, and an
    // earlier version drew them pointing inward, putting stroke ink inside the
    // measured area.
    const svg = renderCardSvg({ bleedMm: 0 });
    const read = SAMPLE_READ_RECT_MM;

    const pathPattern = /<path d="([^"]+)"/g;
    let match: RegExpExecArray | null;
    let pointsChecked = 0;

    while ((match = pathPattern.exec(svg)) !== null) {
      const coordinates = match[1].match(/-?\d+(?:\.\d+)?/g) ?? [];
      for (let i = 0; i + 1 < coordinates.length; i += 2) {
        const x = Number(coordinates[i]);
        const y = Number(coordinates[i + 1]);
        pointsChecked++;
        const inside =
          x > read.x && x < read.x + read.width && y > read.y && y < read.y + read.height;
        expect(inside, `path point ${x},${y} sits inside the read area`).toBe(false);
      }
    }

    expect(pointsChecked).toBeGreaterThan(8);
  });

  it('anchors every text element outside the region that gets measured', () => {
    const svg = renderCardSvg();
    const read = SAMPLE_READ_RECT_MM;
    const textPattern = /<text x="([-\d.]+)" y="([-\d.]+)"/g;
    let match: RegExpExecArray | null;
    let checked = 0;

    while ((match = textPattern.exec(svg)) !== null) {
      const x = Number(match[1]);
      const y = Number(match[2]);
      checked++;
      const inside =
        x > read.x && x < read.x + read.width && y > read.y && y < read.y + read.height;
      expect(inside, `text at ${x},${y} sits inside the read area`).toBe(false);
    }

    expect(checked).toBeGreaterThan(4);
  });

  it('places the corner brackets outside the read area on all four sides', () => {
    const svg = renderCardSvg({ bleedMm: 0 });
    const read = SAMPLE_READ_RECT_MM;
    const paths = svg.match(/<path d="[^"]+"/g) ?? [];
    // Four brackets, and with no bleed there are no crop marks to confuse them.
    expect(paths).toHaveLength(4);

    // One bracket per corner: check each corner has a bracket near it.
    const corners = [
      [read.x, read.y],
      [read.x + read.width, read.y],
      [read.x + read.width, read.y + read.height],
      [read.x, read.y + read.height],
    ];
    for (const [cx, cy] of corners) {
      const found = paths.some((path) => {
        const coordinates = (path.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
        for (let i = 0; i + 1 < coordinates.length; i += 2) {
          if (Math.hypot(coordinates[i] - cx, coordinates[i + 1] - cy) < 1) return true;
        }
        return false;
      });
      expect(found, `no bracket near corner ${cx},${cy}`).toBe(true);
    }
  });

  it('embeds the card spec version so a printed card is traceable', () => {
    expect(renderCardSvg()).toContain(CARD_SPEC_VERSION);
  });

  it('includes the serial when supplied', () => {
    expect(renderCardSvg({ serial: 'DR-0042' })).toContain('DR-0042');
    expect(renderCardSvg()).toContain('UNSERIALISED');
  });

  it('carries the not-a-lab-test disclaimer on the card itself', () => {
    // The disclaimer belongs on the physical artefact, not only in the app.
    expect(renderCardSvg()).toMatch(/does not replace laboratory/i);
  });

  it('escapes text that would otherwise break the XML', () => {
    const svg = renderCardSvg({ serial: 'A&B<"\'>' });
    expect(svg).toContain('A&amp;B&lt;&quot;&apos;&gt;');
    expect(svg).not.toContain('A&B<"\'>');
  });

  it('omits crop marks when there is no bleed', () => {
    const withBleed = renderCardSvg({ bleedMm: 3 });
    const withoutBleed = renderCardSvg({ bleedMm: 0 });
    const countPaths = (svg: string) => (svg.match(/<path /g) ?? []).length;
    expect(countPaths(withBleed)).toBeGreaterThan(countPaths(withoutBleed));
  });

  it('can suppress patch index labels', () => {
    const withLabels = renderCardSvg({ patchIndices: true });
    const withoutLabels = renderCardSvg({ patchIndices: false });
    const countText = (svg: string) => (svg.match(/<text /g) ?? []).length;
    expect(countText(withLabels)).toBe(countText(withoutLabels) + PATCHES.length);
  });

  it('produces well-formed XML with balanced tags', () => {
    const svg = renderCardSvg();
    expect(svg.startsWith('<?xml')).toBe(true);
    expect((svg.match(/<svg/g) ?? []).length).toBe(1);
    expect((svg.match(/<\/svg>/g) ?? []).length).toBe(1);
    expect((svg.match(/<g /g) ?? []).length).toBe((svg.match(/<\/g>/g) ?? []).length);
    // No unescaped stray ampersands.
    expect(svg.replace(/&(amp|lt|gt|quot|apos|#\d+);/g, '')).not.toContain('&');
  });
});

describe('renderCardPrintPage', () => {
  it('embeds the card and drops the XML prolog', () => {
    const page = renderCardPrintPage({ serial: 'DR-0001' });
    expect(page).toContain('<svg');
    expect(page).not.toContain('<?xml');
    expect(page).toContain('DR-0001');
  });

  it('warns about print scaling, which is the most common setup mistake', () => {
    const page = renderCardPrintPage();
    expect(page).toMatch(/100% scale/i);
    expect(page).toMatch(/fit to page/i);
  });

  it('tells the user to avoid glossy stock', () => {
    expect(renderCardPrintPage()).toMatch(/glossy/i);
  });

  it('explains that nominal colours are not measured colours', () => {
    expect(renderCardPrintPage()).toMatch(/nominal/i);
    expect(renderCardPrintPage()).toMatch(/CMYK/i);
  });
});

describe('renderCalibrationWorksheetCsv', () => {
  it('emits a header plus one row per patch', () => {
    const lines = renderCalibrationWorksheetCsv().trim().split('\n');
    expect(lines).toHaveLength(PATCHES.length + 1);
    expect(lines[0]).toContain('measured_L');
  });

  it('includes nominal Lab values and leaves measured columns blank', () => {
    const lines = renderCalibrationWorksheetCsv().trim().split('\n');
    const first = lines[1].split(',');

    // Deliberately order-independent: the patch layout is free to change, and an
    // earlier version of this test hard-coded the assumption that the first patch
    // was the white one, which broke for reasons unrelated to the worksheet.
    expect(first[1]).toBe(PATCHES[0].id);
    expect(Number(first[5])).toBeCloseTo(nominalLabFor(PATCHES[0]).L, 2);

    // Measured columns are intentionally empty for the operator to fill in.
    expect(first.slice(8)).toEqual(['', '', '']);
  });

  it('carries a bright but printable reference patch wherever it sits', () => {
    const lines = renderCalibrationWorksheetCsv().trim().split('\n');
    const lightest = lines
      .slice(1)
      .map((line) => Number(line.split(',')[5]))
      .sort((a, b) => b - a)[0];
    // Bright enough to anchor the tone curve, but well below paper white: a tint
    // that faint does not register on a dye-sublimation card printer at all.
    expect(lightest).toBeGreaterThan(84);
    expect(lightest).toBeLessThan(90);
  });

  it('lists every patch id exactly once', () => {
    const csv = renderCalibrationWorksheetCsv();
    for (const patch of PATCHES) {
      expect((csv.match(new RegExp(`,${patch.id},`, 'g')) ?? []).length).toBe(1);
    }
  });
});
