/**
 * Perceptual colour difference metrics.
 *
 * CIEDE2000 is the one the classifier uses. Plain Euclidean distance in Lab
 * (CIE76) badly misjudges differences in the blue and near-neutral regions,
 * which matters here because several reagent reactions land in exactly those
 * regions (Marquis on some substrates goes deep blue-purple; a blank reagent
 * sits near neutral). Using CIE76 would make "faint colour vs no colour" and
 * "blue vs purple" decisions unreliable.
 */

import type { Lab } from './space';

const DEG_TO_RAD = Math.PI / 180;
const POW25_7 = 6103515625; // 25^7

/** CIE76: straight Euclidean distance in Lab. Kept for diagnostics only. */
export function deltaE76(a: Lab, b: Lab): number {
  return Math.hypot(a.L - b.L, a.a - b.a, a.b - b.b);
}

/**
 * CIE94 (graphic arts weighting). Occasionally useful as a cross-check because
 * it is much simpler than CIEDE2000 and has no hue-rotation term.
 */
export function deltaE94(reference: Lab, sample: Lab): number {
  const kL = 1;
  const k1 = 0.045;
  const k2 = 0.015;

  const dL = reference.L - sample.L;
  const c1 = Math.hypot(reference.a, reference.b);
  const c2 = Math.hypot(sample.a, sample.b);
  const dC = c1 - c2;

  const da = reference.a - sample.a;
  const db = reference.b - sample.b;
  // Guarded against tiny negative values from floating point cancellation.
  const dHSquared = Math.max(0, da * da + db * db - dC * dC);

  const sL = 1;
  const sC = 1 + k1 * c1;
  const sH = 1 + k2 * c1;

  const termL = dL / (kL * sL);
  const termC = dC / sC;
  const termH = Math.sqrt(dHSquared) / sH;

  return Math.hypot(termL, termC, termH);
}

export interface Ciede2000Weights {
  /** Lightness weighting. Raise above 1 to tolerate exposure error. */
  kL?: number;
  /** Chroma weighting. */
  kC?: number;
  /** Hue weighting. */
  kH?: number;
}

/**
 * CIEDE2000, following the Sharma/Wu/Dalal formulation.
 *
 * Verified against the standard 34-pair test dataset in deltaE.test.ts.
 */
export function deltaE2000(reference: Lab, sample: Lab, weights: Ciede2000Weights = {}): number {
  const kL = weights.kL ?? 1;
  const kC = weights.kC ?? 1;
  const kH = weights.kH ?? 1;

  const { L: L1, a: a1, b: b1 } = reference;
  const { L: L2, a: a2, b: b2 } = sample;

  const c1 = Math.hypot(a1, b1);
  const c2 = Math.hypot(a2, b2);
  const cBar = (c1 + c2) / 2;

  const cBar7 = Math.pow(cBar, 7);
  const g = 0.5 * (1 - Math.sqrt(cBar7 / (cBar7 + POW25_7)));

  const a1Prime = (1 + g) * a1;
  const a2Prime = (1 + g) * a2;

  const c1Prime = Math.hypot(a1Prime, b1);
  const c2Prime = Math.hypot(a2Prime, b2);

  const h1Prime = hueAngleDegrees(a1Prime, b1);
  const h2Prime = hueAngleDegrees(a2Prime, b2);

  const deltaLPrime = L2 - L1;
  const deltaCPrime = c2Prime - c1Prime;

  const chromaProduct = c1Prime * c2Prime;

  let deltahPrime: number;
  if (chromaProduct === 0) {
    // Hue is undefined when either sample is neutral; the standard sets the
    // hue difference to zero so the term drops out entirely.
    deltahPrime = 0;
  } else {
    const raw = h2Prime - h1Prime;
    if (Math.abs(raw) <= 180) deltahPrime = raw;
    else if (raw > 180) deltahPrime = raw - 360;
    else deltahPrime = raw + 360;
  }

  const deltaHPrime = 2 * Math.sqrt(chromaProduct) * Math.sin((deltahPrime / 2) * DEG_TO_RAD);

  const lBarPrime = (L1 + L2) / 2;
  const cBarPrime = (c1Prime + c2Prime) / 2;

  let hBarPrime: number;
  if (chromaProduct === 0) {
    hBarPrime = h1Prime + h2Prime;
  } else {
    const sum = h1Prime + h2Prime;
    if (Math.abs(h1Prime - h2Prime) <= 180) hBarPrime = sum / 2;
    else if (sum < 360) hBarPrime = (sum + 360) / 2;
    else hBarPrime = (sum - 360) / 2;
  }

  const t =
    1 -
    0.17 * Math.cos((hBarPrime - 30) * DEG_TO_RAD) +
    0.24 * Math.cos(2 * hBarPrime * DEG_TO_RAD) +
    0.32 * Math.cos((3 * hBarPrime + 6) * DEG_TO_RAD) -
    0.2 * Math.cos((4 * hBarPrime - 63) * DEG_TO_RAD);

  const deltaTheta = 30 * Math.exp(-Math.pow((hBarPrime - 275) / 25, 2));

  const cBarPrime7 = Math.pow(cBarPrime, 7);
  const rC = 2 * Math.sqrt(cBarPrime7 / (cBarPrime7 + POW25_7));

  const lOffset = lBarPrime - 50;
  const sL = 1 + (0.015 * lOffset * lOffset) / Math.sqrt(20 + lOffset * lOffset);
  const sC = 1 + 0.045 * cBarPrime;
  const sH = 1 + 0.015 * cBarPrime * t;

  const rT = -Math.sin(2 * deltaTheta * DEG_TO_RAD) * rC;

  const termL = deltaLPrime / (kL * sL);
  const termC = deltaCPrime / (kC * sC);
  const termH = deltaHPrime / (kH * sH);

  return Math.sqrt(termL * termL + termC * termC + termH * termH + rT * termC * termH);
}

function hueAngleDegrees(a: number, b: number): number {
  if (a === 0 && b === 0) return 0;
  let deg = Math.atan2(b, a) / DEG_TO_RAD;
  if (deg < 0) deg += 360;
  return deg;
}

/**
 * Rough interpretation guide for CIEDE2000 magnitudes, used in the UI so the
 * operator sees plain language rather than a bare number.
 */
export function describeDeltaE(deltaE: number): string {
  if (deltaE < 1) return 'indistinguishable to the eye';
  if (deltaE < 2) return 'only visible on close comparison';
  if (deltaE < 5) return 'noticeable difference';
  if (deltaE < 10) return 'clearly different';
  return 'very different';
}
