/**
 * DRISHTI brand mark, as vector artwork.
 *
 * "Drishti" (दृष्टि) means sight, so the mark is an eye — and its iris is a
 * six-blade camera aperture, because the whole system is about what a camera sees.
 * The framing brackets are the reference-card corner guides from the capture
 * screen, tying the identity to what the app actually does.
 *
 * Authored as vector rather than shipped as a raster because the mark appears at
 * everything from a 24 px header monogram to a 512 px PWA icon, and one source that
 * scales cleanly beats a folder of resized PNGs that can drift apart. The PNG export
 * (scripts/renderLogo.ts) is generated FROM this, so the raster and the vector can
 * never disagree.
 *
 * Colours are the institutional primary (#1c4e9c) so the mark sits inside the same
 * palette as the rest of the interface rather than introducing a new accent.
 */

export interface LogoOptions {
  /** Viewport edge in px. The art is authored on a 512 grid and scales to fit. */
  size?: number;
  /**
   * Eye-white and sclera treatment.
   * - 'light'   white sclera, for placement on dark or coloured surfaces
   * - 'mono'    single-colour, inherits `currentColor`, for the small header mark
   */
  variant?: 'light' | 'mono';
  /** Draw the reference-card framing brackets around the eye. */
  brackets?: boolean;
  /** Title text for the accessible name of the SVG. */
  title?: string;
}

const IRIS = '#1c4e9c';
const IRIS_DARK = '#12356b';
const OUTLINE = '#0e0e0e';
const SCLERA = '#e9ebee';
const BRACKET = '#c4ccd6';

/** Trims float noise so the markup stays readable and diffable. */
function n(value: number): string {
  return Number(value.toFixed(3)).toString();
}

/**
 * One aperture blade as a filled path.
 *
 * The iris is six blades rotated in 60-degree steps. Each blade is a straight
 * chord across the iris circle with a curved outer edge following the circle, which
 * is what gives a real aperture its pinwheel of overlapping leaves. Alternating fill
 * shades give the leaves depth without a gradient (gradients raster unevenly at
 * small sizes).
 */
function apertureBlades(cx: number, cy: number, radius: number): string {
  const blades: string[] = [];
  const leaves = 6;
  const twist = 0.62; // radians; how far each chord is rotated from purely radial

  for (let i = 0; i < leaves; i++) {
    const a0 = (i / leaves) * Math.PI * 2;
    const a1 = ((i + 1) / leaves) * Math.PI * 2;

    // Chord start on the rim, its far end swung inward by the twist.
    const sx = cx + radius * Math.cos(a0);
    const sy = cy + radius * Math.sin(a0);
    const ex = cx + radius * Math.cos(a1);
    const ey = cy + radius * Math.sin(a1);
    const ix = cx + radius * 0.16 * Math.cos(a0 + Math.PI / 2 + twist);
    const iy = cy + radius * 0.16 * Math.sin(a0 + Math.PI / 2 + twist);

    const fill = i % 2 === 0 ? IRIS : IRIS_DARK;
    blades.push(
      `<path d="M ${n(sx)} ${n(sy)} A ${n(radius)} ${n(radius)} 0 0 1 ${n(ex)} ${n(ey)} L ${n(ix)} ${n(iy)} Z" fill="${fill}" />`,
    );
  }
  return blades.join('\n    ');
}

/** The almond eye outline as two symmetric arcs meeting at the corners. */
function eyeAlmond(cx: number, cy: number, halfWidth: number, halfHeight: number): string {
  const left = cx - halfWidth;
  const right = cx + halfWidth;
  const curve = halfHeight / 0.5522; // control offset for a near-circular arc feel
  return (
    `M ${n(left)} ${n(cy)} ` +
    `C ${n(left + halfWidth * 0.55)} ${n(cy - curve)} ${n(right - halfWidth * 0.55)} ${n(cy - curve)} ${n(right)} ${n(cy)} ` +
    `C ${n(right - halfWidth * 0.55)} ${n(cy + curve)} ${n(left + halfWidth * 0.55)} ${n(cy + curve)} ${n(left)} ${n(cy)} Z`
  );
}

function framingBrackets(cx: number, cy: number, halfW: number, halfH: number): string {
  const arm = 26;
  const w = 6;
  const corners = [
    [cx - halfW, cy - halfH, 1, 1],
    [cx + halfW, cy - halfH, -1, 1],
    [cx + halfW, cy + halfH, -1, -1],
    [cx - halfW, cy + halfH, 1, -1],
  ];
  return corners
    .map(
      ([x, y, dx, dy]) =>
        `<path d="M ${n(x + dx * arm)} ${n(y)} L ${n(x)} ${n(y)} L ${n(x)} ${n(y + dy * arm)}" ` +
        `fill="none" stroke="${BRACKET}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round" />`,
    )
    .join('\n    ');
}

/** Renders the mark as a standalone SVG document with a transparent background. */
export function renderLogoSvg(options: LogoOptions = {}): string {
  const size = options.size ?? 512;
  const variant = options.variant ?? 'light';
  const withBrackets = options.brackets ?? true;
  const title = options.title ?? 'DRISHTI';

  const cx = 256;
  const cy = 256;
  const eyeHalfW = 190;
  const eyeHalfH = 96;
  const irisR = 92;

  const mono = variant === 'mono';
  const scleraFill = mono ? 'currentColor' : SCLERA;
  const outline = mono ? 'currentColor' : OUTLINE;

  const iris = mono
    ? // Single-colour aperture: concentric ring plus blade seams, all in currentColor.
      `<circle cx="${cx}" cy="${cy}" r="${irisR}" fill="none" stroke="currentColor" stroke-width="14" />
    ${apertureSeams(cx, cy, irisR)}`
    : `${apertureBlades(cx, cy, irisR)}
    <circle cx="${cx}" cy="${cy}" r="${irisR}" fill="none" stroke="${OUTLINE}" stroke-width="10" />
    <circle cx="${cx}" cy="${cy}" r="${n(irisR * 0.28)}" fill="${IRIS_DARK}" />`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="${size}" height="${size}" role="img" aria-label="${title}">
  <title>${title}</title>
  ${withBrackets ? framingBrackets(cx, cy, 232, 150) : ''}
  <path d="${eyeAlmond(cx, cy, eyeHalfW, eyeHalfH)}" fill="${scleraFill}" stroke="${outline}" stroke-width="12" stroke-linejoin="round" />
  <clipPath id="eyeclip"><path d="${eyeAlmond(cx, cy, eyeHalfW, eyeHalfH)}" /></clipPath>
  <g clip-path="url(#eyeclip)">
    ${iris}
  </g>
</svg>
`;
}

/** Blade seam lines for the mono variant: six spokes from the centre outward. */
function apertureSeams(cx: number, cy: number, radius: number): string {
  const seams: string[] = [];
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + 0.62;
    const x = cx + radius * Math.cos(a);
    const y = cy + radius * Math.sin(a);
    seams.push(
      `<line x1="${cx}" y1="${cy}" x2="${n(x)}" y2="${n(y)}" stroke="currentColor" stroke-width="10" stroke-linecap="round" />`,
    );
  }
  return seams.join('\n    ');
}
