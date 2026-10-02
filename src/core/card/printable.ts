/**
 * Print-ready reference card artwork.
 *
 * Generated from card/spec.ts rather than drawn by hand, so the printed card and
 * the software that reads it cannot disagree. If you edit the layout, the artwork
 * changes with it automatically.
 *
 * Output is SVG with real millimetre dimensions, so printing at 100% scale (no
 * "fit to page", no "shrink to printable area") produces a physically correct
 * card. Scale errors do not break detection — the homography normalises size —
 * but they do change the sample window's physical size, which matters when the
 * operator is placing a test strip inside it.
 *
 * ON PRINT COLOUR ACCURACY: these patches are specified as sRGB values. A
 * consumer or card printer converting sRGB to CMYK will not reproduce them
 * exactly; expect several Delta-E of deviation, more in the saturated patches.
 * That is precisely why the calibration model tracks provenance and supports
 * measured values (see CardCalibration in spec.ts). Print the card, measure it,
 * load the measurements, and the residual print error cancels out. Until then the
 * app reports its calibration as nominal, not measured.
 */

import {
  CARD_HEIGHT_MM,
  CARD_MARGIN_MM,
  CARD_SPEC_VERSION,
  CARD_WIDTH_MM,
  FIDUCIALS,
  ORIENTATION_KEY_INNER_FRACTION,
  PATCHES,
  SAMPLE_READ_RECT_MM,
  SAMPLE_WINDOW_MM,
  nominalLabFor,
  type PatchSpec,
  type RectMm,
} from './spec';
import { hexToRgb, srgbToLab } from '../color/space';

export interface CardArtworkOptions {
  /** Card serial, printed on the card so a faded or damaged card can be retired. */
  serial?: string;
  /** Bleed in millimetres added around the trim box, with crop marks. */
  bleedMm?: number;
  /** Print small index numbers in each patch corner to aid manual measurement. */
  patchIndices?: boolean;
  /** Card stock colour used for the background fill. */
  stockHex?: string;
}

const INK_BLACK = '#101010';
const HAIRLINE = '#9a9a9a';
const TEXT_GREY = '#3a3a3a';

/**
 * Outline drawn on the boundary of every calibration patch.
 *
 * WHY: on a PVC card the lightest neutral is a 15% tint, and a card printer that
 * is low on dye, mis-profiled, or simply cheap can drop it entirely. Without an
 * outline a dropped patch looks identical to bare card stock, so the operator has
 * no way to tell a faint patch from a missing one and keeps using a card that
 * cannot be calibrated. With an outline, a dropped tint presents as an empty box:
 * an unmistakable, self-evident defect.
 *
 * It also gives every patch a visible registration reference, which is what you
 * need in order to notice that the artwork printed off-centre.
 *
 * WHY THE COLOUR VARIES PER PATCH: a single grey cannot be visible on all twelve
 * fills. The neutrals span code values 50 to 216, so any fixed grey coincides with
 * one of them — a first attempt used #707070, which is *exactly* the level-112
 * patch, leaving that patch with no visible outline at all. Since the operator is
 * being asked to confirm that all twelve boxes are outlined and filled, an
 * instruction that is only true for eleven of them is worse than no instruction.
 * So the keyline is chosen light or dark from the patch's own L*, the same way the
 * index labels are.
 *
 * Note the asymmetry is in the right direction: light patches, the ones that
 * actually drop out, get the DARK keyline, which is what remains visible against
 * bare stock when the fill fails. Dark patches get a light keyline, and a 56-78%
 * tint does not fail to print.
 *
 * WHY IT IS SAFE FOR MEASUREMENT: the stroke is centred on the patch boundary, so
 * it extends 0.125 mm inside it. Sampling trims 25% from every side
 * (PATCH_SAMPLE_INSET_FRACTION), which is 3.18 mm horizontally and 1.88 mm
 * vertically — more than an order of magnitude clear of the stroke. No keyline ink
 * can reach a patch reading.
 *
 * WHY IT IS SAFE FOR DETECTION: the detector only accepts dark blobs whose
 * second-moment aspect is under 1.5 and whose moment solidity is above 0.68. A
 * hollow 1.70-aspect rectangle fails both independently — it is too oblong, and a
 * thin ring's area is a small fraction of the filled rectangle it spans. Keeping
 * the darkest keyline at #5A5A5A rather than black also keeps it clear of the ink
 * population that Otsu separates out, so in practice it is not even a candidate.
 */
const PATCH_KEYLINE_WIDTH_MM = 0.25;
const PATCH_KEYLINE_ON_LIGHT = '#5a5a5a';
const PATCH_KEYLINE_ON_DARK = '#c8c8c8';

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Trims float noise so the SVG stays readable and diffable. */
function n(value: number): string {
  return Number(value.toFixed(4)).toString();
}

function rect(r: RectMm, fill: string, extra = ''): string {
  return `<rect x="${n(r.x)}" y="${n(r.y)}" width="${n(r.width)}" height="${n(r.height)}" fill="${fill}"${extra ? ` ${extra}` : ''} />`;
}

/**
 * Ink that stays legible on a given patch — used for both its keyline and its
 * index label, so the two can never disagree about which is the readable choice.
 *
 * Uses the patch's own L* rather than a luminance guess, so the decision is
 * consistent with how the rest of the pipeline reasons about lightness.
 *
 * Opaque greys rather than semi-transparent black and white. Alpha has to be
 * flattened somewhere between SVG and the card printer, and the two places that
 * can happen — the browser's print pipeline and the printer's own RIP — do not
 * agree. An opaque colour prints as the colour specified.
 */
function contrastingInkFor(patch: PatchSpec): string {
  return nominalLabFor(patch).L > 55 ? PATCH_KEYLINE_ON_LIGHT : PATCH_KEYLINE_ON_DARK;
}

function fiducialMarkup(): string {
  const parts: string[] = [];
  for (const fiducial of FIDUCIALS) {
    parts.push(rect(fiducial.rect, INK_BLACK));
    if (fiducial.hasOrientationKey) {
      const inner = fiducial.rect.width * ORIENTATION_KEY_INNER_FRACTION;
      parts.push(
        rect(
          {
            x: fiducial.rect.x + (fiducial.rect.width - inner) / 2,
            y: fiducial.rect.y + (fiducial.rect.height - inner) / 2,
            width: inner,
            height: inner,
          },
          '#ffffff',
        ),
      );
    }
  }
  return parts.join('\n    ');
}

function patchMarkup(options: CardArtworkOptions): string {
  const parts: string[] = [];
  PATCHES.forEach((patch, index) => {
    parts.push(
      rect(
        patch.rect,
        patch.nominalHex,
        `stroke="${contrastingInkFor(patch)}" stroke-width="${n(PATCH_KEYLINE_WIDTH_MM)}"`,
      ),
    );
    if (options.patchIndices !== false) {
      // Placed in the top-left corner, well outside the central 50% that gets
      // sampled, so the ink cannot contaminate a patch reading.
      parts.push(
        `<text x="${n(patch.rect.x + 0.7)}" y="${n(patch.rect.y + 2)}" font-size="1.5" font-family="Helvetica, Arial, sans-serif" fill="${contrastingInkFor(patch)}">${index + 1}</text>`,
      );
    }
  });
  return parts.join('\n    ');
}

function sampleWindowMarkup(): string {
  const w = SAMPLE_WINDOW_MM;
  const read = SAMPLE_READ_RECT_MM;
  const tick = 1.6;

  /**
   * Gap between the read rectangle and the corner brackets.
   *
   * The brackets point *outward* and start clear of the boundary. Pointing them
   * inward, or drawing them on the boundary, puts stroke ink inside the area the
   * app measures — a small amount, but there is no reason to accept any ink in a
   * region whose whole purpose is to be a clean neutral background.
   */
  const gap = 0.35;

  // Outward direction for each corner: top-left goes up and left, and so on.
  const corners = [
    [read.x, read.y, -1, -1],
    [read.x + read.width, read.y, 1, -1],
    [read.x + read.width, read.y + read.height, 1, 1],
    [read.x, read.y + read.height, -1, 1],
  ];
  const ticks = corners
    .map(([x, y, dx, dy]) => {
      const cornerX = x + dx * gap;
      const cornerY = y + dy * gap;
      return `<path d="M ${n(cornerX + dx * tick)} ${n(cornerY)} L ${n(cornerX)} ${n(cornerY)} L ${n(cornerX)} ${n(cornerY + dy * tick)}" fill="none" stroke="${HAIRLINE}" stroke-width="0.2" />`;
    })
    .join('\n    ');

  return `<rect x="${n(w.x)}" y="${n(w.y)}" width="${n(w.width)}" height="${n(w.height)}" fill="none" stroke="${HAIRLINE}" stroke-width="0.25" stroke-dasharray="1.2 0.8" />
    ${ticks}`;
}

function textMarkup(options: CardArtworkOptions): string {
  const serial = options.serial ?? 'UNSERIALISED';
  const headerY = CARD_MARGIN_MM + 3.4;
  const headerX = CARD_MARGIN_MM + 8 + 2;
  const footerY = CARD_HEIGHT_MM - CARD_MARGIN_MM - 4.6;
  const captionY = SAMPLE_WINDOW_MM.y - 0.6;

  return `<text x="${n(headerX)}" y="${n(headerY)}" font-size="2.3" font-family="Helvetica, Arial, sans-serif" font-weight="bold" fill="${TEXT_GREY}" letter-spacing="0.15">DRISHTI COLOUR REFERENCE</text>
    <text x="${n(headerX)}" y="${n(headerY + 3.1)}" font-size="1.7" font-family="Helvetica, Arial, sans-serif" fill="${TEXT_GREY}">${escapeXml(CARD_SPEC_VERSION)} &#183; SERIAL ${escapeXml(serial)}</text>
    <text x="${n(CARD_WIDTH_MM / 2)}" y="${n(captionY)}" font-size="1.5" font-family="Helvetica, Arial, sans-serif" fill="${TEXT_GREY}" text-anchor="middle">PLACE TEST RESULT WITHIN THE MARKED AREA</text>
    <text x="${n(headerX)}" y="${n(footerY)}" font-size="1.5" font-family="Helvetica, Arial, sans-serif" fill="${TEXT_GREY}">Presumptive field screening aid. Does not replace laboratory confirmatory testing.</text>
    <text x="${n(headerX)}" y="${n(footerY + 2.4)}" font-size="1.4" font-family="Helvetica, Arial, sans-serif" fill="${TEXT_GREY}">Keep clean and unfaded. Replace if scratched, stained or discoloured.</text>`;
}

function cropMarkMarkup(bleed: number): string {
  if (bleed <= 0) return '';
  const length = Math.min(bleed, 3);
  const marks: string[] = [];
  const xs = [0, CARD_WIDTH_MM];
  const ys = [0, CARD_HEIGHT_MM];

  for (const x of xs) {
    for (const y of ys) {
      const dx = x === 0 ? -1 : 1;
      const dy = y === 0 ? -1 : 1;
      marks.push(
        `<path d="M ${n(x)} ${n(y + dy * 0.6)} L ${n(x)} ${n(y + dy * (0.6 + length))}" stroke="${INK_BLACK}" stroke-width="0.15" />`,
        `<path d="M ${n(x + dx * 0.6)} ${n(y)} L ${n(x + dx * (0.6 + length))} ${n(y)}" stroke="${INK_BLACK}" stroke-width="0.15" />`,
      );
    }
  }
  return marks.join('\n    ');
}

/** Renders the complete card as a standalone SVG document. */
export function renderCardSvg(options: CardArtworkOptions = {}): string {
  const bleed = options.bleedMm ?? 3;
  const stock = options.stockHex ?? '#ffffff';
  const totalWidth = CARD_WIDTH_MM + 2 * bleed;
  const totalHeight = CARD_HEIGHT_MM + 2 * bleed;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" version="1.1"
  width="${n(totalWidth)}mm" height="${n(totalHeight)}mm"
  viewBox="0 0 ${n(totalWidth)} ${n(totalHeight)}">
  <title>DRISHTI colour reference card (${escapeXml(CARD_SPEC_VERSION)})</title>
  <desc>Print at exactly 100% scale. Do not use "fit to page" or "shrink to printable area".</desc>
  <rect x="0" y="0" width="${n(totalWidth)}" height="${n(totalHeight)}" fill="${stock}" />
  <g transform="translate(${n(bleed)} ${n(bleed)})">
    <rect x="0" y="0" width="${n(CARD_WIDTH_MM)}" height="${n(CARD_HEIGHT_MM)}" fill="${stock}" />
    ${fiducialMarkup()}
    ${patchMarkup(options)}
    ${sampleWindowMarkup()}
    ${textMarkup(options)}
    ${cropMarkMarkup(bleed)}
  </g>
</svg>
`;
}

/**
 * A printable HTML page wrapping the card, with instructions.
 *
 * Provided because "open this and press print" is a far more reliable path for a
 * team under time pressure than explaining print-scaling settings verbally.
 */
export function renderCardPrintPage(options: CardArtworkOptions = {}): string {
  const svg = renderCardSvg(options).replace(/^<\?xml[^>]*\?>\s*/, '');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>DRISHTI reference card — print sheet</title>
<style>
  @page { margin: 12mm; }
  body { font-family: Helvetica, Arial, sans-serif; color: #222; margin: 0; padding: 16mm; }
  h1 { font-size: 16pt; margin: 0 0 4mm; }
  ol { font-size: 10pt; line-height: 1.5; padding-left: 6mm; }
  .card { margin: 8mm 0; }
  .warn { border-left: 3px solid #b5473c; padding: 3mm 4mm; background: #faf0ef; font-size: 10pt; }
  @media print { .noprint { display: none; } body { padding: 0; } }
</style>
</head>
<body>
  <h1>DRISHTI colour reference card</h1>
  <div class="noprint warn">
    <strong>Print at 100% scale.</strong> Turn off "fit to page" and "shrink to printable area".
    After printing, measure the card against a ruler: it must be
    ${n(CARD_WIDTH_MM)} mm &times; ${n(CARD_HEIGHT_MM)} mm at the trim marks.
  </div>
  <div class="card">${svg}</div>
  <ol class="noprint">
    <li>Print on matte white stock — PVC card blanks or heavy matte paper. Avoid glossy and
        laminated-gloss finishes: they produce specular glare that the app will reject.</li>
    <li>Trim on the crop marks.</li>
    <li><strong>Check all twelve patches before using the card.</strong> Every patch is printed
        with a grey outline, so each of the twelve boxes must contain a visible tint. An outlined
        box that looks empty means the printer failed to lay down that tint — most often the
        lightest neutral on a dye-sublimation card printer. Reject the card and reprint; do not
        calibrate against it.</li>
    <li>Optionally laminate with a <em>matte</em> laminate for durability.</li>
    <li>The colour patches will not match their nominal values exactly, because the printer converts sRGB to CMYK.
        Measure the printed patches and load the measurements into the app to remove that error. Until you do,
        the app will correctly report its calibration as <em>nominal</em> rather than <em>measured</em>.</li>
  </ol>
</body>
</html>
`;
}

/**
 * Worksheet for recording measured patch values.
 *
 * Emitting the nominal values alongside blank measured columns makes the
 * calibration step concrete: measure each patch with a spectrophotometer (or a
 * lab-verified reference), fill in the three columns, and load the result.
 */
export function renderCalibrationWorksheetCsv(): string {
  const rows = [
    'index,patch_id,role,row,nominal_hex,nominal_L,nominal_a,nominal_b,measured_L,measured_a,measured_b',
  ];
  PATCHES.forEach((patch, index) => {
    const lab = srgbToLab(hexToRgb(patch.nominalHex));
    rows.push(
      [
        index + 1,
        patch.id,
        patch.role,
        patch.row,
        patch.nominalHex,
        lab.L.toFixed(3),
        lab.a.toFixed(3),
        lab.b.toFixed(3),
        '',
        '',
        '',
      ].join(','),
    );
  });
  return `${rows.join('\n')}\n`;
}
