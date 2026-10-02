/**
 * Colorimetric classification.
 *
 * Takes a colour-corrected Lab reading from the sample window and matches it
 * against a reagent panel's reference colours using CIEDE2000.
 *
 * The design priority is *refusing to guess*. Two independent guards must both
 * pass before any definite category is returned:
 *
 *   1. The nearest reference must be close enough in absolute terms. Otherwise
 *      the observed colour is not on the panel at all, and forcing it into the
 *      nearest bucket would invent a result.
 *   2. The nearest reference must beat the runner-up by a clear margin. A sample
 *      sitting between two references is genuinely ambiguous, and reporting
 *      whichever happened to be marginally closer would reintroduce exactly the
 *      arbitrary judgement this application exists to eliminate.
 *
 * Failing either guard yields 'inconclusive' with a machine-readable reason, not
 * a low-confidence positive. In this domain a false positive carries real
 * consequences for a person, so the asymmetry is deliberate.
 */

import { deltaE2000 } from '../color/deltaE';
import type { Lab } from '../color/space';
import {
  panelNeedsVerification,
  panelProvenance,
  type ClassificationThresholds,
  type ColourProvenance,
  type OutcomeCategory,
  type ReagentPanel,
} from './panels';

export type ConfidenceBand = 'high' | 'moderate' | 'low';

export type InconclusiveReason =
  | 'no-reference-match'
  | 'ambiguous-between-outcomes'
  | 'capture-rejected';

export interface RankedOutcome {
  outcomeId: string;
  label: string;
  category: OutcomeCategory;
  deltaE: number;
}

export interface ClassificationResult {
  panelId: string;
  panelName: string;
  /** Null when the result is inconclusive. */
  outcomeId: string | null;
  category: OutcomeCategory;
  label: string;
  confidence: ConfidenceBand;
  /** CIEDE2000 to the closest reference colour. */
  matchDeltaE: number;
  /** How much closer the best match is than the runner-up. */
  separationDeltaE: number;
  inconclusiveReason?: InconclusiveReason;
  /** Populated when two outcomes were too close to separate. */
  ambiguousBetween?: readonly string[];
  /** Every outcome scored, nearest first, for display and audit. */
  ranked: readonly RankedOutcome[];
  /** Substances associated with the matched colour, if any. Presumptive only. */
  associatedSubstances?: readonly string[];
  /** Weakest provenance among the panel's reference colours. */
  referenceProvenance: ColourProvenance;
  /** True while the panel's reference colours are not lab-verified. */
  referenceNeedsVerification: boolean;
  /**
   * Always true. A presumptive field screen never substitutes for laboratory
   * confirmation, so this is a literal rather than a computed value: there is no
   * code path that can set it to false.
   */
  readonly requiresLaboratoryConfirmation: true;
}

/**
 * Confidence bands.
 *
 * These describe how cleanly the measurement landed on a reference colour. They
 * are deliberately qualitative: presenting a percentage would imply a calibrated
 * probability that this method does not provide, and that a reviewer could
 * reasonably mistake for a statistical error rate.
 */
export const CONFIDENCE_BANDS = {
  /** Very close to a reference and far from every other one. */
  high: { maxMatchDeltaE: 8, minSeparationDeltaE: 20 },
  /** Reasonably close with a comfortable margin. */
  moderate: { maxMatchDeltaE: 16, minSeparationDeltaE: 12 },
} as const;

function confidenceFor(matchDeltaE: number, separationDeltaE: number): ConfidenceBand {
  if (
    matchDeltaE <= CONFIDENCE_BANDS.high.maxMatchDeltaE &&
    separationDeltaE >= CONFIDENCE_BANDS.high.minSeparationDeltaE
  ) {
    return 'high';
  }
  if (
    matchDeltaE <= CONFIDENCE_BANDS.moderate.maxMatchDeltaE &&
    separationDeltaE >= CONFIDENCE_BANDS.moderate.minSeparationDeltaE
  ) {
    return 'moderate';
  }
  return 'low';
}

export interface ClassifyOptions {
  /** Overrides the panel's own thresholds. Used by tests and tuning tools. */
  thresholds?: ClassificationThresholds;
}

/** Classifies a corrected sample colour against a reagent panel. */
export function classifySample(
  sampleLab: Lab,
  panel: ReagentPanel,
  options: ClassifyOptions = {},
): ClassificationResult {
  if (panel.outcomes.length === 0) {
    throw new Error(`Reagent panel ${panel.id} has no reference outcomes`);
  }

  const thresholds = options.thresholds ?? panel.thresholds;

  const ranked: RankedOutcome[] = panel.outcomes
    .map((outcome) => ({
      outcomeId: outcome.id,
      label: outcome.label,
      category: outcome.category,
      deltaE: deltaE2000(outcome.lab, sampleLab),
    }))
    .sort((a, b) => a.deltaE - b.deltaE);

  const best = ranked[0];
  const runnerUp = ranked[1];
  // With a single-outcome panel there is nothing to separate from, so the margin
  // is unbounded rather than zero.
  const separationDeltaE = runnerUp ? runnerUp.deltaE - best.deltaE : Number.POSITIVE_INFINITY;

  const base = {
    panelId: panel.id,
    panelName: panel.name,
    matchDeltaE: best.deltaE,
    separationDeltaE,
    ranked,
    referenceProvenance: panelProvenance(panel),
    referenceNeedsVerification: panelNeedsVerification(panel),
    requiresLaboratoryConfirmation: true as const,
  };

  if (best.deltaE > thresholds.maxMatchDeltaE) {
    return {
      ...base,
      outcomeId: null,
      category: 'inconclusive',
      label: 'Inconclusive: colour does not match any reference for this reagent',
      confidence: 'low',
      inconclusiveReason: 'no-reference-match',
    };
  }

  if (separationDeltaE < thresholds.minSeparationDeltaE) {
    return {
      ...base,
      outcomeId: null,
      category: 'inconclusive',
      label: 'Inconclusive: colour falls between two reference outcomes',
      confidence: 'low',
      inconclusiveReason: 'ambiguous-between-outcomes',
      ambiguousBetween: [best.outcomeId, runnerUp.outcomeId],
    };
  }

  const matched = panel.outcomes.find((outcome) => outcome.id === best.outcomeId)!;

  return {
    ...base,
    outcomeId: matched.id,
    category: matched.category,
    label: matched.label,
    confidence: confidenceFor(best.deltaE, separationDeltaE),
    ...(matched.associatedSubstances
      ? { associatedSubstances: matched.associatedSubstances }
      : {}),
  };
}

/**
 * Builds an inconclusive result for a capture that failed its quality gates.
 *
 * Used so that a rejected capture still produces a well-formed, recordable
 * result rather than nothing: the fact that a test was attempted and rejected is
 * itself worth logging.
 */
export function rejectedCaptureResult(panel: ReagentPanel, reason: string): ClassificationResult {
  return {
    panelId: panel.id,
    panelName: panel.name,
    outcomeId: null,
    category: 'inconclusive',
    label: `Inconclusive, capture rejected: ${reason}`,
    confidence: 'low',
    matchDeltaE: Number.NaN,
    separationDeltaE: Number.NaN,
    inconclusiveReason: 'capture-rejected',
    ranked: [],
    referenceProvenance: panelProvenance(panel),
    referenceNeedsVerification: panelNeedsVerification(panel),
    requiresLaboratoryConfirmation: true,
  };
}

export interface PanelSeparationReport {
  panelId: string;
  /** Smallest CIEDE2000 between any two reference colours on the panel. */
  minimumPairwiseDeltaE: number;
  closestPair: readonly [string, string];
  /**
   * True when the panel's own references are further apart than the ambiguity
   * threshold, so a clean measurement can actually distinguish them. A panel that
   * fails this is not usable regardless of how good the capture is.
   */
  isSeparable: boolean;
}

/**
 * Checks that a panel's reference colours are mutually distinguishable.
 *
 * This validates the *reference data* rather than any measurement. If two
 * outcomes on a panel are closer to each other than the ambiguity threshold, then
 * no capture can ever separate them and every reading between them will be
 * reported inconclusive. Catching that in the data is much better than
 * discovering it in the field.
 */
export function panelSeparation(panel: ReagentPanel): PanelSeparationReport {
  let minimum = Number.POSITIVE_INFINITY;
  let closestPair: [string, string] = ['', ''];

  for (let i = 0; i < panel.outcomes.length; i++) {
    for (let j = i + 1; j < panel.outcomes.length; j++) {
      const distance = deltaE2000(panel.outcomes[i].lab, panel.outcomes[j].lab);
      if (distance < minimum) {
        minimum = distance;
        closestPair = [panel.outcomes[i].id, panel.outcomes[j].id];
      }
    }
  }

  return {
    panelId: panel.id,
    minimumPairwiseDeltaE: minimum,
    closestPair,
    isSeparable: minimum > panel.thresholds.minSeparationDeltaE,
  };
}
