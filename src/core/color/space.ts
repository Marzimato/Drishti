/**
 * Colour space conversions.
 *
 * Everything here is dependency-free and deterministic so it can be unit tested
 * without a camera or a browser. Conventions used throughout the codebase:
 *
 *  - `Rgb`       : sRGB, gamma-encoded, channels in [0, 1]
 *  - `LinearRgb` : sRGB primaries, linear light, channels in [0, 1] (may exceed
 *                  the range after colour correction, callers decide on clamping)
 *  - `Xyz`       : CIE 1931 XYZ, Y normalised so that the reference white is 1.0
 *  - `Lab`       : CIE 1976 L*a*b*, L in [0, 100]
 *
 * All colour correction maths operates in *linear* light. Doing least-squares
 * fitting on gamma-encoded values is a common and serious mistake: the camera
 * response we are trying to invert is linear-ish before the gamma curve, so a
 * matrix fitted on encoded values cannot represent it.
 */

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export type LinearRgb = Rgb;

export interface Xyz {
  x: number;
  y: number;
  z: number;
}

export interface Lab {
  L: number;
  a: number;
  b: number;
}

export interface Lch {
  L: number;
  C: number;
  h: number;
}

/** CIE standard illuminant white points, Y normalised to 1. */
export const WHITE_POINT_D65: Xyz = {
  x: 0.9504559270516716,
  y: 1,
  z: 1.0890577507598784,
};

export const WHITE_POINT_D50: Xyz = {
  x: 0.9642956764295677,
  y: 1,
  z: 0.8251046025104602,
};

/**
 * sRGB is defined against D65, so we keep D65 as the working white point for the
 * whole pipeline. Mixing white points silently (e.g. Lab under D50 compared with
 * references computed under D65) produces errors of several Delta-E units, which
 * is larger than the differences we are trying to resolve.
 */
export const WORKING_WHITE_POINT: Xyz = WHITE_POINT_D65;

// Linear sRGB -> XYZ (D65). Rows sum to the D65 white point above.
const LINEAR_RGB_TO_XYZ = [
  [0.4123907992659595, 0.35758433938387796, 0.1804807884018343],
  [0.21263900587151036, 0.7151686787677559, 0.07219231536073371],
  [0.01933081871559185, 0.11919477979462599, 0.9505321522496606],
] as const;

// XYZ (D65) -> linear sRGB.
const XYZ_TO_LINEAR_RGB = [
  [3.2409699419045213, -1.5373831775700935, -0.4986107602930033],
  [-0.9692436362808798, 1.8759675015077206, 0.04155505740717561],
  [0.05563007969699361, -0.20397695888897657, 1.0569715142428786],
] as const;

// CIE Lab constants in their exact rational form (avoids the 0.008856 / 903.3
// rounded variants, which introduce a small discontinuity at the join).
const LAB_EPSILON = 216 / 24389;
const LAB_KAPPA = 24389 / 27;

/** sRGB electro-optical transfer function: gamma-encoded [0,1] -> linear [0,1]. */
export function srgbToLinearChannel(value: number): number {
  // Signed handling keeps the function monotonic for slightly negative inputs,
  // which can occur transiently after matrix correction.
  const sign = value < 0 ? -1 : 1;
  const v = Math.abs(value);
  const linear = v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  return sign * linear;
}

/** Inverse sRGB transfer function: linear [0,1] -> gamma-encoded [0,1]. */
export function linearToSrgbChannel(value: number): number {
  const sign = value < 0 ? -1 : 1;
  const v = Math.abs(value);
  const encoded = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
  return sign * encoded;
}

export function srgbToLinear(rgb: Rgb): LinearRgb {
  return {
    r: srgbToLinearChannel(rgb.r),
    g: srgbToLinearChannel(rgb.g),
    b: srgbToLinearChannel(rgb.b),
  };
}

export function linearToSrgb(rgb: LinearRgb): Rgb {
  return {
    r: linearToSrgbChannel(rgb.r),
    g: linearToSrgbChannel(rgb.g),
    b: linearToSrgbChannel(rgb.b),
  };
}

export function linearRgbToXyz(rgb: LinearRgb): Xyz {
  const m = LINEAR_RGB_TO_XYZ;
  return {
    x: m[0][0] * rgb.r + m[0][1] * rgb.g + m[0][2] * rgb.b,
    y: m[1][0] * rgb.r + m[1][1] * rgb.g + m[1][2] * rgb.b,
    z: m[2][0] * rgb.r + m[2][1] * rgb.g + m[2][2] * rgb.b,
  };
}

export function xyzToLinearRgb(xyz: Xyz): LinearRgb {
  const m = XYZ_TO_LINEAR_RGB;
  return {
    r: m[0][0] * xyz.x + m[0][1] * xyz.y + m[0][2] * xyz.z,
    g: m[1][0] * xyz.x + m[1][1] * xyz.y + m[1][2] * xyz.z,
    b: m[2][0] * xyz.x + m[2][1] * xyz.y + m[2][2] * xyz.z,
  };
}

function labForwardTransfer(t: number): number {
  return t > LAB_EPSILON ? Math.cbrt(t) : (LAB_KAPPA * t + 16) / 116;
}

function labInverseTransfer(t: number): number {
  const t3 = t * t * t;
  return t3 > LAB_EPSILON ? t3 : (116 * t - 16) / LAB_KAPPA;
}

export function xyzToLab(xyz: Xyz, white: Xyz = WORKING_WHITE_POINT): Lab {
  const fx = labForwardTransfer(xyz.x / white.x);
  const fy = labForwardTransfer(xyz.y / white.y);
  const fz = labForwardTransfer(xyz.z / white.z);
  return {
    L: 116 * fy - 16,
    a: 500 * (fx - fy),
    b: 200 * (fy - fz),
  };
}

export function labToXyz(lab: Lab, white: Xyz = WORKING_WHITE_POINT): Xyz {
  const fy = (lab.L + 16) / 116;
  const fx = fy + lab.a / 500;
  const fz = fy - lab.b / 200;
  return {
    x: labInverseTransfer(fx) * white.x,
    y: labInverseTransfer(fy) * white.y,
    z: labInverseTransfer(fz) * white.z,
  };
}

/* Convenience compositions used all over the pipeline. */

export function linearRgbToLab(rgb: LinearRgb, white: Xyz = WORKING_WHITE_POINT): Lab {
  return xyzToLab(linearRgbToXyz(rgb), white);
}

export function labToLinearRgb(lab: Lab, white: Xyz = WORKING_WHITE_POINT): LinearRgb {
  return xyzToLinearRgb(labToXyz(lab, white));
}

export function srgbToLab(rgb: Rgb, white: Xyz = WORKING_WHITE_POINT): Lab {
  return linearRgbToLab(srgbToLinear(rgb), white);
}

export function labToSrgb(lab: Lab, white: Xyz = WORKING_WHITE_POINT): Rgb {
  return linearToSrgb(labToLinearRgb(lab, white));
}

export function labToLch(lab: Lab): Lch {
  const C = Math.hypot(lab.a, lab.b);
  let h = (Math.atan2(lab.b, lab.a) * 180) / Math.PI;
  if (h < 0) h += 360;
  return { L: lab.L, C, h };
}

export function lchToLab(lch: Lch): Lab {
  const hRad = (lch.h * Math.PI) / 180;
  return {
    L: lch.L,
    a: lch.C * Math.cos(hRad),
    b: lch.C * Math.sin(hRad),
  };
}

/* 8-bit helpers. Camera frames arrive as Uint8ClampedArray RGBA. */

export function rgb8ToRgb(r: number, g: number, b: number): Rgb {
  return { r: r / 255, g: g / 255, b: b / 255 };
}

export function rgbToRgb8(rgb: Rgb): { r: number; g: number; b: number } {
  return {
    r: Math.round(clamp01(rgb.r) * 255),
    g: Math.round(clamp01(rgb.g) * 255),
    b: Math.round(clamp01(rgb.b) * 255),
  };
}

export function clamp01(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

export function clampRgb01(rgb: Rgb): Rgb {
  return { r: clamp01(rgb.r), g: clamp01(rgb.g), b: clamp01(rgb.b) };
}

/** `#rrggbb` for display and for the printable card generator. */
export function rgbToHex(rgb: Rgb): string {
  const { r, g, b } = rgbToRgb8(rgb);
  const hex = (v: number) => v.toString(16).padStart(2, '0');
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

export function hexToRgb(hex: string): Rgb {
  const cleaned = hex.trim().replace(/^#/, '');
  const full =
    cleaned.length === 3
      ? cleaned
          .split('')
          .map((c) => c + c)
          .join('')
      : cleaned;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) {
    throw new Error(`Invalid hex colour: ${hex}`);
  }
  return rgb8ToRgb(
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16),
  );
}

/** Relative luminance in linear light. Used by the exposure/glare gates. */
export function relativeLuminance(linear: LinearRgb): number {
  return 0.2126 * linear.r + 0.7152 * linear.g + 0.0722 * linear.b;
}

/**
 * Bradford chromatic adaptation. Not used in the default D65-only path, but
 * needed if a department ever supplies reference values measured under D50
 * (which is what most spectrophotometer software exports by default).
 */
const BRADFORD = [
  [0.8951, 0.2664, -0.1614],
  [-0.7502, 1.7135, 0.0367],
  [0.0389, -0.0685, 1.0296],
] as const;

const BRADFORD_INVERSE = [
  [0.9869929, -0.1470543, 0.1599627],
  [0.4323053, 0.5183603, 0.0492912],
  [-0.0085287, 0.0400428, 0.9684867],
] as const;

function applyMatrix3(m: readonly (readonly number[])[], v: readonly number[]): number[] {
  return [
    m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
    m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
    m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
  ];
}

export function adaptXyz(xyz: Xyz, from: Xyz, to: Xyz): Xyz {
  const srcCone = applyMatrix3(BRADFORD, [from.x, from.y, from.z]);
  const dstCone = applyMatrix3(BRADFORD, [to.x, to.y, to.z]);
  const cone = applyMatrix3(BRADFORD, [xyz.x, xyz.y, xyz.z]);
  const scaled = [
    (cone[0] * dstCone[0]) / srcCone[0],
    (cone[1] * dstCone[1]) / srcCone[1],
    (cone[2] * dstCone[2]) / srcCone[2],
  ];
  const out = applyMatrix3(BRADFORD_INVERSE, scaled);
  return { x: out[0], y: out[1], z: out[2] };
}
