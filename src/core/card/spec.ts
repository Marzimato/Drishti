/**
 * Reference card specification — the single source of truth for card geometry
 * and reference colours.
 *
 * Both the printable card generator and the runtime detector import this module,
 * so a printed card and the software that reads it cannot drift apart. If you
 * change a dimension here you must reprint the card, and CARD_SPEC_VERSION must
 * be bumped so that records captured against the old card remain interpretable.
 *
 * Coordinate system: millimetres, origin at the top-left corner of the card,
 * x increasing right, y increasing down. This matches the printed artwork and
 * the homography source coordinates.
 */

import { hexToRgb, srgbToLab, type Lab } from '../color/space';

/**
 * Bumped whenever geometry or nominal colours change. Stored in every test
 * record so a record captured today can still be audited after the card is
 * revised.
 */
export const CARD_SPEC_VERSION = 'drishti-card-3';

/* ---------------------------------------------------------------- geometry */

/** 88.9 x 54 mm — 3.5 x 2.13 inches, a size every card printer stocks. */
export const CARD_WIDTH_MM = 88.9;
export const CARD_HEIGHT_MM = 54;

/** White quiet zone around the artwork; also where fiducials are inset from. */
export const CARD_MARGIN_MM = 2.5;

/** Side length of each square fiducial marker. */
export const FIDUCIAL_SIZE_MM = 8;

/**
 * The top-left fiducial carries a white square at its centre, one third of its
 * width. All four markers otherwise being identical would leave a 180-degree
 * ambiguity: a card held upside down would still yield four corners forming the
 * right shape, and every patch would then be sampled from the wrong place,
 * producing a confident but completely wrong classification. The asymmetric
 * marker removes that failure mode entirely rather than relying on the operator
 * to hold the card the right way up.
 */
export const ORIENTATION_KEY_INNER_FRACTION = 1 / 3;

export interface RectMm {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PointMm {
  x: number;
  y: number;
}

export type FiducialCorner = 'topLeft' | 'topRight' | 'bottomRight' | 'bottomLeft';

export interface FiducialSpec {
  corner: FiducialCorner;
  rect: RectMm;
  centre: PointMm;
  /** True only for the top-left marker, which carries the white centre square. */
  hasOrientationKey: boolean;
}

function makeFiducial(corner: FiducialCorner): FiducialSpec {
  const isRight = corner === 'topRight' || corner === 'bottomRight';
  const isBottom = corner === 'bottomRight' || corner === 'bottomLeft';
  const x = isRight ? CARD_WIDTH_MM - CARD_MARGIN_MM - FIDUCIAL_SIZE_MM : CARD_MARGIN_MM;
  const y = isBottom ? CARD_HEIGHT_MM - CARD_MARGIN_MM - FIDUCIAL_SIZE_MM : CARD_MARGIN_MM;
  return {
    corner,
    rect: { x, y, width: FIDUCIAL_SIZE_MM, height: FIDUCIAL_SIZE_MM },
    centre: { x: x + FIDUCIAL_SIZE_MM / 2, y: y + FIDUCIAL_SIZE_MM / 2 },
    hasOrientationKey: corner === 'topLeft',
  };
}

/**
 * Fiducials in a fixed clockwise order starting top-left. Detection code relies
 * on this ordering when pairing detected corners with card coordinates, so it
 * must not be reordered.
 */
export const FIDUCIALS: readonly FiducialSpec[] = [
  makeFiducial('topLeft'),
  makeFiducial('topRight'),
  makeFiducial('bottomRight'),
  makeFiducial('bottomLeft'),
] as const;

/** Homography source points, same order as FIDUCIALS. */
export const FIDUCIAL_CENTRES_MM: readonly PointMm[] = FIDUCIALS.map((f) => f.centre);

/**
 * Aspect ratio of the rectangle formed by the four fiducial centres.
 * Used to sanity-check a detection before trusting it.
 */
export const FIDUCIAL_RECT_WIDTH_MM =
  CARD_WIDTH_MM - 2 * CARD_MARGIN_MM - FIDUCIAL_SIZE_MM;
export const FIDUCIAL_RECT_HEIGHT_MM =
  CARD_HEIGHT_MM - 2 * CARD_MARGIN_MM - FIDUCIAL_SIZE_MM;
export const FIDUCIAL_RECT_ASPECT = FIDUCIAL_RECT_WIDTH_MM / FIDUCIAL_RECT_HEIGHT_MM;

/* ------------------------------------------------------------ patch layout */

const PATCH_COUNT_PER_ROW = 6;
const PATCH_ROW_GAP_MM = 1.5;
const PATCH_HEIGHT_MM = 7.5;

/**
 * Two patch rows, one above and one below the sample window.
 *
 * The vertical arrangement is deliberate and matters for accuracy:
 *
 * 1. **Illumination can be modelled, not guessed.** Estimating how brightness
 *    varies across the card requires calibration samples at more than one height.
 *    With every patch on a single row, the spatial fit is rank-deficient — a plane
 *    cannot be determined from a line — and uneven side lighting cannot be
 *    corrected at all.
 *
 * 2. **The sample is interpolated, not extrapolated.** The sample window sits
 *    between the two rows, so its local illumination is bracketed by real
 *    measurements above and below it. Extrapolating past the edge of the
 *    calibration data would amplify any error in the fit.
 *
 * The bottom row is inset horizontally to clear the two bottom corner markers,
 * so it is slightly narrower than the top row.
 */
const ROW_A_Y_MM = 11.5;

/**
 * The bottom row sits *above* the bottom corner markers rather than between them.
 *
 * Placing it between them would force it to be inset horizontally, making each
 * patch about 9.6 x 7.5 mm — an aspect ratio of 1.28, close enough to square that
 * the detector's shape filter would accept the patches as candidate corner
 * markers. Keeping both rows at full width gives every patch the same 1.70 aspect,
 * comfortably oblong and never confusable with an 8 mm square marker.
 */
const ROW_B_Y_MM = 34;

const ROW_A_X_START_MM = CARD_MARGIN_MM;
const ROW_A_X_END_MM = CARD_WIDTH_MM - CARD_MARGIN_MM;
const ROW_B_X_START_MM = CARD_MARGIN_MM;
const ROW_B_X_END_MM = CARD_WIDTH_MM - CARD_MARGIN_MM;

function rowPatchWidth(startX: number, endX: number): number {
  return (endX - startX - (PATCH_COUNT_PER_ROW - 1) * PATCH_ROW_GAP_MM) / PATCH_COUNT_PER_ROW;
}

export const ROW_A_PATCH_WIDTH_MM = rowPatchWidth(ROW_A_X_START_MM, ROW_A_X_END_MM);
export const ROW_B_PATCH_WIDTH_MM = rowPatchWidth(ROW_B_X_START_MM, ROW_B_X_END_MM);

type PatchRow = 'A' | 'B';

function patchRect(row: PatchRow, indexInRow: number): RectMm {
  const startX = row === 'A' ? ROW_A_X_START_MM : ROW_B_X_START_MM;
  const width = row === 'A' ? ROW_A_PATCH_WIDTH_MM : ROW_B_PATCH_WIDTH_MM;
  return {
    x: startX + indexInRow * (width + PATCH_ROW_GAP_MM),
    y: row === 'A' ? ROW_A_Y_MM : ROW_B_Y_MM,
    width,
    height: PATCH_HEIGHT_MM,
  };
}

/**
 * The region where the operator places the test strip, spot plate, or reacted
 * sample. Kept clear of every calibration patch so that a spill or a shadow cast
 * by the sample cannot contaminate the calibration.
 */
export const SAMPLE_WINDOW_MM: RectMm = {
  x: 14,
  y: 21,
  width: 60.9,
  height: 11,
};

export type PatchRole = 'neutral' | 'chromatic';

export interface PatchSpec {
  id: string;
  label: string;
  role: PatchRole;
  row: PatchRow;
  rect: RectMm;
  /**
   * The colour sent to the printer. Note this is the *nominal* value: what the
   * printed card actually reflects will differ, which is why calibration
   * provenance is tracked separately (see CardCalibration below).
   */
  nominalHex: string;
}

/**
 * Six neutral steps from a light tint down to a dark grey. Six rather than four
 * because these patches carry the tone-response and white-balance information:
 * with only four, a single misread patch (a fingerprint, a glare spot) distorts
 * the whole fit noticeably.
 */
/**
 * Neutral step levels, lightest first.
 *
 * TWO PROPERTIES ARE DELIBERATE HERE, and both were learned from printed cards.
 *
 * 1. THE LIGHTEST STEP IS 216, NOT 255 AND NOT 240.
 *
 *    Pure white is unprintable on white stock: it renders as bare card, so the patch
 *    is invisible and cannot be checked for damage or misregistration. Worse, its
 *    nominal target of L*=100 / a*=0 / b*=0 describes a perfect diffuse reflector.
 *    Real stock sits nearer L*95 and is often slightly blue from optical brighteners,
 *    so asserting L*=100 puts a systematic error on the one patch anchoring the bright
 *    end of the tone curve, where the other five cannot average it out.
 *
 *    The previous revision used 240, reasoning that a 6% tint would print as "faint
 *    but genuine". On a PVC card it did not print at all. Dye-sublimation and
 *    retransfer card printers have a thermal threshold in the highlights: below
 *    roughly 8-10% coverage the head does not transfer enough dye to register, so the
 *    patch is simply absent. 216 is a 15% tint, comfortably above that threshold on
 *    every card printer we could test, and it still lands at L*86 — bright enough to
 *    anchor the top of the ramp.
 *
 *    216 alone is not the whole fix. See the keyline notes in card/printable.ts: every
 *    patch is now outlined, so a dropped tint shows up as an empty box rather than as
 *    blank stock. An absent patch that looks absent is a card you know to reject; an
 *    absent patch that looks like margin is a card you keep using.
 *
 * 2. THE STEPS ARE EVENLY SPACED IN L*, NOT IN 8-BIT CODE VALUE.
 *
 *    Even code-value spacing bunches the steps perceptually, because sRGB encoding is
 *    non-linear: the old [240, 214, 173, 132, 91, 50] ladder put 5.6 L* between the
 *    first two steps and 17.6 L* between the last two. The tone-response fit weights
 *    every patch equally, so clustered steps waste observations where the curve is
 *    already well determined and leave the ends under-constrained.
 *
 *    These six levels land on L* 86.3, 73.3, 60.2, 47.2, 34.4, 20.8 — steps of
 *    13.0, 13.1, 13.0, 12.8, 13.6. Spanning 65 L* over six evenly spaced samples
 *    constrains the tone curve better than the old 74 L* span did unevenly.
 *
 * The darkest step stops at 50 rather than 0 because a solid black patch gives an
 * unreliable reflectance reading — it is dominated by surface gloss rather than ink
 * colour, and PVC is glossier than paper. The corner fiducials are the only true
 * blacks, and they are used for geometry, not colour.
 */
const NEUTRAL_LEVELS_8BIT = [216, 180, 145, 112, 81, 50] as const;

function neutralHex(level: number): string {
  const component = level.toString(16).padStart(2, '0');
  return `#${component}${component}${component}`;
}

function neutralId(level: number): string {
  return `neutral-${level}`;
}

/**
 * Six chromatic patches, deliberately mid-saturation.
 *
 * Fully saturated primaries sit outside the CMYK gamut of a card printer, so the
 * printed patch would not match its nominal value and would drag the correction
 * fit off. These are chosen to be comfortably printable while bracketing the hue
 * range that the reagents of interest actually produce: Marquis runs
 * orange-brown to purple, Mecke and Scott's run blue to blue-green,
 * Duquenois-Levine and Fast Blue B run red-purple.
 */
const CHROMATIC_COLOURS = {
  red: { label: 'Red', hex: '#b5473c' },
  orange: { label: 'Orange', hex: '#cf8b3f' },
  green: { label: 'Green', hex: '#4f8f52' },
  cyan: { label: 'Cyan', hex: '#3f8f9e' },
  blue: { label: 'Blue', hex: '#3f5f9e' },
  purple: { label: 'Purple', hex: '#7b4f8f' },
} as const;

type ChromaticKey = keyof typeof CHROMATIC_COLOURS;

type SlotDefinition =
  | { kind: 'neutral'; level: (typeof NEUTRAL_LEVELS_8BIT)[number] }
  | { kind: 'chromatic'; key: ChromaticKey };

/**
 * Slot assignment for the two rows.
 *
 * Neutrals and chromatics are interleaved rather than grouped by row, and the
 * neutrals are spread across both rows and across several horizontal positions.
 * That spread is what makes the illumination plane fit well conditioned: the
 * neutrals must vary in both x and y, since they are the samples used to separate
 * spatial brightness variation from spectral response.
 *
 * CRITICALLY, the neutral *lightness* order must not follow the horizontal order.
 * The first revision placed them in descending lightness from left to right, giving a
 * perfect negative correlation between level and x position. That made the printer's
 * tone response mathematically indistinguishable from a left-to-right brightness
 * gradient: on a real card the fit attributed tone error to space and reported a 126%
 * illumination gradient that did not exist, and the colour matrix then compensated in
 * the opposite direction, reading bare stock 25 L* too dark.
 *
 * The order below scatters lightness against position, reducing the level/position
 * covariance to about 1.5% of that worst case, and keeps the two rows close in mean
 * lightness (136 vs 125) so the vertical axis is not confounded either. If you
 * reorder these slots, or change the levels, preserve both properties — there are
 * tests enforcing them.
 */
const ROW_A_SLOTS: readonly SlotDefinition[] = [
  { kind: 'neutral', level: 112 },
  { kind: 'chromatic', key: 'red' },
  { kind: 'neutral', level: 216 },
  { kind: 'chromatic', key: 'green' },
  { kind: 'neutral', level: 81 },
  { kind: 'chromatic', key: 'blue' },
];

const ROW_B_SLOTS: readonly SlotDefinition[] = [
  { kind: 'chromatic', key: 'orange' },
  { kind: 'neutral', level: 145 },
  { kind: 'chromatic', key: 'cyan' },
  { kind: 'neutral', level: 50 },
  { kind: 'chromatic', key: 'purple' },
  { kind: 'neutral', level: 180 },
];

function buildRow(row: PatchRow, slots: readonly SlotDefinition[]): PatchSpec[] {
  return slots.map((slot, index) => {
    const rect = patchRect(row, index);
    if (slot.kind === 'neutral') {
      return {
        id: neutralId(slot.level),
        label: `${slot.level}`,
        role: 'neutral' as const,
        row,
        rect,
        nominalHex: neutralHex(slot.level),
      };
    }
    const colour = CHROMATIC_COLOURS[slot.key];
    return {
      id: `chroma-${slot.key}`,
      label: colour.label,
      role: 'chromatic' as const,
      row,
      rect,
      nominalHex: colour.hex,
    };
  });
}

export const PATCHES: readonly PatchSpec[] = [
  ...buildRow('A', ROW_A_SLOTS),
  ...buildRow('B', ROW_B_SLOTS),
];

export const NEUTRAL_PATCHES = PATCHES.filter((p) => p.role === 'neutral');
export const CHROMATIC_PATCH_SPECS = PATCHES.filter((p) => p.role === 'chromatic');

/**
 * Neutral patches ordered lightest to darkest, which is the order the tone
 * response is checked in. Note this is *not* their physical left-to-right order,
 * because they are deliberately scattered across the card.
 */
export const NEUTRAL_RAMP: readonly PatchSpec[] = NEUTRAL_LEVELS_8BIT.map((level) => {
  const patch = PATCHES.find((p) => p.id === neutralId(level));
  if (!patch) throw new Error(`Neutral patch for level ${level} is missing from the layout`);
  return patch;
});

/** Normalised card position of a rectangle's centre, both components in [0, 1]. */
export function normalisedCentre(rect: RectMm): { u: number; v: number } {
  return {
    u: (rect.x + rect.width / 2) / CARD_WIDTH_MM,
    v: (rect.y + rect.height / 2) / CARD_HEIGHT_MM,
  };
}

/**
 * Fraction of a patch trimmed away on each side before sampling.
 *
 * Print registration error, ink bleed at the patch boundary, and homography
 * error all concentrate at the edges. Sampling only the middle half of each
 * patch costs us nothing in signal (there are still thousands of pixels) and
 * removes the dominant source of systematic error.
 */
export const PATCH_SAMPLE_INSET_FRACTION = 0.25;

export function insetRect(rect: RectMm, fraction: number): RectMm {
  const dx = rect.width * fraction;
  const dy = rect.height * fraction;
  return {
    x: rect.x + dx,
    y: rect.y + dy,
    width: rect.width - 2 * dx,
    height: rect.height - 2 * dy,
  };
}

export function patchSampleRect(patch: PatchSpec): RectMm {
  return insetRect(patch.rect, PATCH_SAMPLE_INSET_FRACTION);
}

/** Fraction trimmed from the sample window before reading the result colour. */
export const SAMPLE_READ_INSET_FRACTION = 0.2;

/**
 * The sub-region of the sample window that is actually read.
 *
 * The printed window outline sits on the boundary of SAMPLE_WINDOW_MM, and this
 * inset region is what gets measured, so the printed line itself is never
 * included in the reading. Nothing may be printed inside this rectangle: it must
 * be bare card stock so the operator's sample sits against a neutral background.
 */
export const SAMPLE_READ_RECT_MM: RectMm = insetRect(
  SAMPLE_WINDOW_MM,
  SAMPLE_READ_INSET_FRACTION,
);

/** Normalised card position used when correcting the sample reading. */
export const SAMPLE_READ_POSITION = {
  u: (SAMPLE_READ_RECT_MM.x + SAMPLE_READ_RECT_MM.width / 2) / CARD_WIDTH_MM,
  v: (SAMPLE_READ_RECT_MM.y + SAMPLE_READ_RECT_MM.height / 2) / CARD_HEIGHT_MM,
};

/* ------------------------------------------------------- calibration values */

/**
 * Where a card's reference Lab values come from, in ascending order of trust.
 *
 * 'nominal'       — computed from the sRGB values sent to the printer. Assumes the
 *                   printer reproduced them exactly, which no printer does.
 * 'self-measured' — derived from photographing the card itself with the device
 *                   camera, several times under even light, and averaging. Removes
 *                   the printer error that nominal cannot, but it is only as good as
 *                   the camera and the lighting, and inherits the camera's own
 *                   colour rendering. Honest middle ground when no instrument exists.
 * 'measured'      — measured with a colour instrument (spectrophotometer or
 *                   colorimeter) under a known illuminant. The deployment target.
 *
 * The distinction between the two measured kinds is not cosmetic: both earn the
 * strict quality thresholds, because in both cases the references describe the real
 * card rather than an assumption. But a reviewer must be able to tell camera-derived
 * references from instrument-derived ones, so they are separate provenance values
 * carried verbatim into every signed record.
 */
export type CalibrationProvenance = 'nominal' | 'self-measured' | 'measured';

export interface MeasuredPatch {
  patchId: string;
  lab: Lab;
  /**
   * Agreement spread across the frames this value was averaged from, as a mean
   * CIEDE2000 of each frame's reading to the final averaged value. Present only for
   * self-measured calibration. High values mean the frames disagreed, i.e. the
   * lighting was not actually consistent, and the calibration should be distrusted.
   */
  agreementDeltaE?: number;
}

export interface CardCalibration {
  cardSpecVersion: string;
  /**
   * 'nominal'  — reference Lab values are computed from the sRGB values sent to
   *              the printer. Convenient, and good enough to demonstrate that
   *              correction works, but it assumes the printer reproduced those
   *              values exactly, which no printer does.
   * 'measured' — reference Lab values come from measuring the actual printed
   *              card. This is what a deployment must use.
   *
   * This flag is copied into every test record. A reviewer can therefore tell
   * whether a given result rests on measured or assumed calibration data, rather
   * than having to take the number on trust.
   */
  provenance: CalibrationProvenance;
  /** Free text, e.g. the instrument and illuminant used. */
  measuredWith?: string;
  measuredAt?: string;
  /** Card serial, so a damaged or faded card can be traced and retired. */
  cardSerial?: string;
  patches?: readonly MeasuredPatch[];
  /** Number of frames averaged, for self-measured calibration. */
  frameCount?: number;
}

/** Lab value implied by a patch's nominal print colour. */
export function nominalLabFor(patch: PatchSpec): Lab {
  return srgbToLab(hexToRgb(patch.nominalHex));
}

/**
 * The default calibration: nominal values, explicitly flagged as such.
 *
 * Shipping this rather than inventing plausible "measured" numbers is a
 * deliberate choice. Fabricated measurement data would make the prototype look
 * more finished while making its output impossible to audit.
 */
export const NOMINAL_CALIBRATION: CardCalibration = {
  cardSpecVersion: CARD_SPEC_VERSION,
  provenance: 'nominal',
};

/** Reference Lab for a patch, preferring measured data when present. */
export function referenceLabFor(patch: PatchSpec, calibration: CardCalibration): Lab {
  const measured = calibration.patches?.find((p) => p.patchId === patch.id);
  return measured ? measured.lab : nominalLabFor(patch);
}

/** True when a per-patch Lab is present for every patch, whatever its provenance. */
function hasCompletePatchSet(calibration: CardCalibration): boolean {
  const ids = new Set(calibration.patches?.map((p) => p.patchId) ?? []);
  return PATCHES.every((patch) => ids.has(patch.id));
}

/**
 * True when the calibration supplies an instrument-measured Lab for every patch.
 *
 * Deliberately strict about provenance: self-measured calibration is NOT fully
 * measured in this sense, because it is camera-derived. Callers that specifically
 * mean "instrument-grade reference data" use this. A partially measured calibration
 * silently mixing measured and nominal values would be worse than either, so this
 * is all-or-nothing.
 */
export function isFullyMeasured(calibration: CardCalibration): boolean {
  if (calibration.provenance !== 'measured') return false;
  return hasCompletePatchSet(calibration);
}

/**
 * True when the calibration has a complete set of real per-patch references, by
 * either measurement route.
 *
 * This is what the quality thresholds key off, because both measured and
 * self-measured describe the physical card — so a large correction residual against
 * either genuinely means a bad capture, and the strict limits are correct. Nominal
 * cannot use the strict limits because its residual is partly expected print error.
 */
export function hasPerPatchReferences(calibration: CardCalibration): boolean {
  if (calibration.provenance === 'nominal') return false;
  return hasCompletePatchSet(calibration);
}

/** Human-readable provenance label for display. */
export function describeProvenance(provenance: CalibrationProvenance): string {
  switch (provenance) {
    case 'measured':
      return 'Instrument-measured';
    case 'self-measured':
      return 'Self-measured (camera)';
    case 'nominal':
      return 'Nominal (print targets)';
  }
}
