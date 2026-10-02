/**
 * Reagent panel reference data.
 *
 * READ THIS BEFORE TRUSTING ANY NUMBER IN THIS FILE.
 *
 * The *qualitative* colour associations below (Marquis turning purple with
 * opiates, cobalt thiocyanate turning blue with cocaine, and so on) are
 * long-established and widely documented in forensic field-testing literature.
 * The *numeric* Lab values are not. They are this author's approximation of those
 * colour names, chosen so the pipeline can be demonstrated end to end.
 *
 * Every reference colour therefore carries a `provenance` field, and every panel
 * carries the weakest provenance among its outcomes. That value propagates all
 * the way into the signed test record, so anyone auditing a result can see
 * whether it rested on measured data or on a placeholder.
 *
 * To deploy this for real, someone must photograph or spectrophotometrically
 * measure known reference reactions for the specific kit in use, under the card,
 * and replace these values with provenance 'lab-verified'. Until that happens the
 * app reports low confidence in its reference data and says so on screen.
 *
 * Reagent colour associations summarised from standard forensic field-test
 * references, including the UNODC's published guidance on rapid testing of drugs
 * of abuse: https://www.unodc.org/documents/scientific/ST-NAR-13-REV1.pdf
 * Content was rephrased for compliance with licensing restrictions.
 */

import { hexToRgb, srgbToLab, type Lab } from '../color/space';

/**
 * How a reference colour was obtained.
 *
 * - 'placeholder'  : approximated from a colour name. Demonstration only.
 * - 'literature'   : taken from published numeric colorimetry for this reagent.
 * - 'lab-verified' : measured from known reference reactions on this kit.
 */
export type ColourProvenance = 'placeholder' | 'literature' | 'lab-verified';

export const PROVENANCE_RANK: Record<ColourProvenance, number> = {
  placeholder: 0,
  literature: 1,
  'lab-verified': 2,
};

export type OutcomeCategory = 'positive' | 'negative' | 'inconclusive';

export interface OutcomeReference {
  id: string;
  /** Operator-facing description of the colour and what it suggests. */
  label: string;
  category: OutcomeCategory;
  /** Reference colour in Lab, under the D65 working white point. */
  lab: Lab;
  provenance: ColourProvenance;
  /**
   * Substances this colour is associated with. Presumptive association only:
   * many unrelated compounds produce visually similar reactions.
   */
  associatedSubstances?: readonly string[];
  note?: string;
}

export interface ClassificationThresholds {
  /**
   * If the closest reference is further than this in CIEDE2000, nothing on the
   * panel matches and the result is inconclusive. This is what stops an unusual
   * colour from being forced into the nearest category.
   */
  maxMatchDeltaE: number;
  /**
   * The closest reference must beat the runner-up by at least this margin.
   * Without this, a sample sitting halfway between "negative" and "positive"
   * would be reported as whichever was marginally nearer, which is exactly the
   * subjective coin-flip this application exists to remove.
   */
  minSeparationDeltaE: number;
}

/**
 * INVARIANT: maxMatchDeltaE must stay below the smallest pairwise distance between
 * a panel's own reference colours. Otherwise the accept radius around each
 * reference extends past its neighbour, the regions overlap, and colours that are
 * plainly different from anything on the panel get absorbed into the nearest
 * bucket.
 *
 * An earlier value of 25 did exactly that: a medium blue sat 20 dE from the Marquis
 * opiate purple and was reported as "positive, consistent with opiates". The
 * Marquis references are only about 17 dE apart at their closest, so 25 was
 * incoherent. There is a test in engine.test.ts enforcing this relationship for
 * every shipped panel.
 *
 * KNOWN LIMITATION: reagent reactions vary in intensity with concentration,
 * substrate and elapsed time. A faint and a deep version of the same reaction share
 * a hue but differ substantially in lightness and chroma, so a single reference
 * point per outcome plus a tight radius will report some genuine reactions as
 * inconclusive. That is the safe direction to fail, but the real fix is reference
 * data with several measured points along each reaction's intensity range, which
 * requires lab work rather than a threshold change.
 */
export const DEFAULT_THRESHOLDS: ClassificationThresholds = {
  maxMatchDeltaE: 12,
  minSeparationDeltaE: 8,
};

export interface ReagentPanel {
  id: string;
  name: string;
  description: string;
  outcomes: readonly OutcomeReference[];
  thresholds: ClassificationThresholds;
  /** Citation or source note for this panel's colour associations. */
  source?: string;
}

/** Convenience for declaring reference colours legibly. */
function labFromHex(hex: string): Lab {
  return srgbToLab(hexToRgb(hex));
}

/**
 * Marquis reagent.
 *
 * Produces markedly different colours across opiates and amphetamine-type
 * substances, which makes it a good demonstration of multi-outcome
 * classification rather than a simple positive/negative split.
 */
const MARQUIS: ReagentPanel = {
  id: 'marquis',
  name: 'Marquis',
  description:
    'Formaldehyde in sulphuric acid. Widely used as a first-pass screen for opiates and amphetamine-type substances.',
  source: 'Colour associations per standard field-test guidance; numeric values are placeholders.',
  thresholds: DEFAULT_THRESHOLDS,
  outcomes: [
    {
      id: 'marquis-no-reaction',
      label: 'No colour change, negative',
      category: 'negative',
      lab: labFromHex('#efe7c8'),
      provenance: 'placeholder',
      note: 'Unreacted reagent remains pale straw-coloured.',
    },
    {
      id: 'marquis-orange-brown',
      label: 'Orange to brown, consistent with amphetamine-type substances',
      category: 'positive',
      lab: labFromHex('#b06a24'),
      provenance: 'placeholder',
      associatedSubstances: ['amphetamine', 'methamphetamine'],
    },
    {
      id: 'marquis-purple',
      label: 'Purple to violet, consistent with opiates',
      category: 'positive',
      lab: labFromHex('#5a2a6e'),
      provenance: 'placeholder',
      associatedSubstances: ['morphine', 'heroin', 'codeine'],
    },
    {
      id: 'marquis-dark',
      label: 'Very dark purple to black, consistent with MDMA/MDA group',
      category: 'positive',
      lab: labFromHex('#241428'),
      provenance: 'placeholder',
      associatedSubstances: ['MDMA', 'MDA'],
    },
  ],
};

/**
 * Cobalt thiocyanate (Scott's test) for cocaine.
 *
 * Note the negative reference is the reagent's own pink, not "colourless": a
 * genuine negative here is a positive match to a known colour, which is why the
 * engine treats "no match to anything" as inconclusive rather than negative.
 */
const COBALT_THIOCYANATE: ReagentPanel = {
  id: 'cobalt-thiocyanate',
  name: 'Cobalt thiocyanate (Scott)',
  description: 'Screen for cocaine and related salts. The reagent itself is pink; a positive turns blue.',
  source: 'Colour associations per standard field-test guidance; numeric values are placeholders.',
  thresholds: DEFAULT_THRESHOLDS,
  outcomes: [
    {
      id: 'cobalt-pink',
      label: 'Pink, unchanged, negative',
      category: 'negative',
      lab: labFromHex('#d96b8a'),
      provenance: 'placeholder',
    },
    {
      id: 'cobalt-blue',
      label: 'Blue, consistent with cocaine',
      category: 'positive',
      lab: labFromHex('#1f4fa8'),
      provenance: 'placeholder',
      associatedSubstances: ['cocaine hydrochloride', 'cocaine base'],
    },
  ],
};

/** Duquenois-Levine, used as a cannabis screen. */
const DUQUENOIS_LEVINE: ReagentPanel = {
  id: 'duquenois-levine',
  name: 'Duquenois-Levine',
  description: 'Screen for cannabis material. A positive develops a purple colour.',
  source: 'Colour associations per standard field-test guidance; numeric values are placeholders.',
  thresholds: DEFAULT_THRESHOLDS,
  outcomes: [
    {
      id: 'dl-no-reaction',
      label: 'No significant colour, negative',
      category: 'negative',
      lab: labFromHex('#ece4d6'),
      provenance: 'placeholder',
    },
    {
      id: 'dl-purple',
      label: 'Purple to violet, consistent with cannabis',
      category: 'positive',
      lab: labFromHex('#6b2f7a'),
      provenance: 'placeholder',
      associatedSubstances: ['cannabis'],
      note: 'Known to respond to some unrelated plant material; confirmatory testing is essential.',
    },
  ],
};

/** Simon's reagent, used to distinguish secondary from primary amines. */
const SIMONS: ReagentPanel = {
  id: 'simons',
  name: "Simon's",
  description:
    'Distinguishes secondary amines such as MDMA from primary amines such as amphetamine. Used alongside Marquis rather than alone.',
  source: 'Colour associations per standard field-test guidance; numeric values are placeholders.',
  thresholds: DEFAULT_THRESHOLDS,
  outcomes: [
    {
      id: 'simons-no-reaction',
      label: 'No blue colour, negative for secondary amines',
      category: 'negative',
      lab: labFromHex('#f0e8c8'),
      provenance: 'placeholder',
    },
    {
      id: 'simons-blue',
      label: 'Deep blue, consistent with a secondary amine such as MDMA',
      category: 'positive',
      lab: labFromHex('#1c3f80'),
      provenance: 'placeholder',
      associatedSubstances: ['MDMA', 'methamphetamine'],
    },
  ],
};

export const REAGENT_PANELS: readonly ReagentPanel[] = [
  MARQUIS,
  COBALT_THIOCYANATE,
  DUQUENOIS_LEVINE,
  SIMONS,
];

export function findPanel(panelId: string): ReagentPanel | undefined {
  return REAGENT_PANELS.find((panel) => panel.id === panelId);
}

/** The weakest provenance among a panel's outcomes, which is what it can claim. */
export function panelProvenance(panel: ReagentPanel): ColourProvenance {
  return panel.outcomes.reduce<ColourProvenance>((weakest, outcome) => {
    return PROVENANCE_RANK[outcome.provenance] < PROVENANCE_RANK[weakest]
      ? outcome.provenance
      : weakest;
  }, 'lab-verified');
}

/**
 * True when a panel's reference colours are not yet good enough to rely on
 * operationally. Surfaced in the UI and stored in the record.
 */
export function panelNeedsVerification(panel: ReagentPanel): boolean {
  return PROVENANCE_RANK[panelProvenance(panel)] < PROVENANCE_RANK['lab-verified'];
}
