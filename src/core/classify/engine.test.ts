import { describe, expect, it } from 'vitest';
import {
  CONFIDENCE_BANDS,
  classifySample,
  panelSeparation,
  rejectedCaptureResult,
  type ClassificationResult,
} from './engine';
import {
  DEFAULT_THRESHOLDS,
  REAGENT_PANELS,
  findPanel,
  panelNeedsVerification,
  panelProvenance,
  type OutcomeReference,
  type ReagentPanel,
} from './panels';
import { hexToRgb, srgbToLab, type Lab } from '../color/space';
import { deltaE2000 } from '../color/deltaE';

const marquis = findPanel('marquis')!;
const cobalt = findPanel('cobalt-thiocyanate')!;

function labOf(hex: string): Lab {
  return srgbToLab(hexToRgb(hex));
}

/** Nudges a Lab value a controlled CIEDE2000 distance away, for boundary tests. */
function shiftLightness(lab: Lab, delta: number): Lab {
  return { ...lab, L: lab.L + delta };
}

describe('reagent panel data', () => {
  it('ships at least one panel', () => {
    expect(REAGENT_PANELS.length).toBeGreaterThan(0);
  });

  it('gives every panel and outcome a unique id', () => {
    const panelIds = REAGENT_PANELS.map((p) => p.id);
    expect(new Set(panelIds).size).toBe(panelIds.length);

    for (const panel of REAGENT_PANELS) {
      const outcomeIds = panel.outcomes.map((o) => o.id);
      expect(new Set(outcomeIds).size, `${panel.id} has duplicate outcome ids`).toBe(
        outcomeIds.length,
      );
    }
  });

  it('gives every panel exactly one negative reference', () => {
    // A panel with no negative could never report a clean negative result; one
    // with several would make "negative" ambiguous.
    for (const panel of REAGENT_PANELS) {
      const negatives = panel.outcomes.filter((o) => o.category === 'negative');
      expect(negatives, `${panel.id} negative count`).toHaveLength(1);
    }
  });

  it('has mutually distinguishable reference colours on every panel', () => {
    // Validates the reference data itself: two outcomes closer than the ambiguity
    // threshold could never be told apart, no matter how good the capture is.
    for (const panel of REAGENT_PANELS) {
      const report = panelSeparation(panel);
      expect(
        report.isSeparable,
        `${panel.id}: ${report.closestPair.join(' vs ')} only ${report.minimumPairwiseDeltaE.toFixed(1)} dE apart`,
      ).toBe(true);
    }
  });

  it('keeps the accept radius smaller than the gap between reference colours', () => {
    // The coherence invariant. If maxMatchDeltaE exceeded the closest pairwise
    // distance, the accept regions around neighbouring references would overlap and
    // visibly different colours would be absorbed into the nearest bucket. This is
    // what previously let a medium blue be reported as an opiate-consistent purple.
    for (const panel of REAGENT_PANELS) {
      const report = panelSeparation(panel);
      expect(
        panel.thresholds.maxMatchDeltaE,
        `${panel.id}: accept radius ${panel.thresholds.maxMatchDeltaE} exceeds closest reference gap ${report.minimumPairwiseDeltaE.toFixed(1)}`,
      ).toBeLessThan(report.minimumPairwiseDeltaE);
    }
  });

  it('rejects a colour that is merely nearest rather than genuinely close', () => {
    // A medium blue is not any Marquis outcome. It is nearer to the opiate purple
    // than to anything else on that panel, but "nearest" is not "matching".
    const result = classifySample(labOf('#1f4fa8'), marquis);
    expect(result.category).toBe('inconclusive');
    expect(result.inconclusiveReason).toBe('no-reference-match');
  });

  it('honestly reports that shipped reference colours are not lab-verified', () => {
    // The shipped values are approximations of colour names. If this test ever
    // starts failing because provenance was upgraded, that upgrade must be backed
    // by real measurements.
    for (const panel of REAGENT_PANELS) {
      expect(panelProvenance(panel)).toBe('placeholder');
      expect(panelNeedsVerification(panel)).toBe(true);
    }
  });

  it('marks provenance on every individual outcome', () => {
    for (const panel of REAGENT_PANELS) {
      for (const outcome of panel.outcomes) {
        expect(outcome.provenance, `${outcome.id} missing provenance`).toBeDefined();
      }
    }
  });
});

describe('classifySample', () => {
  it('identifies an exact match to a well-isolated reference with high confidence', () => {
    // Cobalt thiocyanate's pink and blue are far apart, so an exact match to one
    // of them is unambiguous and earns the top band.
    const blue = cobalt.outcomes.find((o) => o.id === 'cobalt-blue')!;
    const result = classifySample(blue.lab, cobalt);

    expect(result.outcomeId).toBe('cobalt-blue');
    expect(result.category).toBe('positive');
    expect(result.matchDeltaE).toBeCloseTo(0, 6);
    expect(result.confidence).toBe('high');
    expect(result.associatedSubstances).toContain('cocaine hydrochloride');
  });

  it('caps confidence at moderate when a neighbouring reference is close by', () => {
    // An exact match to the Marquis opiate purple still only earns 'moderate',
    // because the MDMA-group near-black reference sits close to it. Confidence
    // reflects how *isolated* the match is, not just how near it is: a perfect hit
    // on a reference that has a near neighbour is genuinely less trustworthy,
    // since a small measurement error could have crossed between them.
    const purple = marquis.outcomes.find((o) => o.id === 'marquis-purple')!;
    const dark = marquis.outcomes.find((o) => o.id === 'marquis-dark')!;
    const neighbourDistance = deltaE2000(purple.lab, dark.lab);

    const result = classifySample(purple.lab, marquis);

    expect(result.outcomeId).toBe('marquis-purple');
    expect(result.category).toBe('positive');
    expect(result.matchDeltaE).toBeCloseTo(0, 6);
    expect(result.associatedSubstances).toContain('morphine');

    // Documents why the band is capped: the nearest rival is under the 20 dE
    // isolation requirement for 'high'.
    expect(neighbourDistance).toBeLessThan(CONFIDENCE_BANDS.high.minSeparationDeltaE);
    expect(result.confidence).toBe('moderate');
  });

  it('identifies a clean negative', () => {
    const negative = marquis.outcomes.find((o) => o.id === 'marquis-no-reaction')!;
    const result = classifySample(negative.lab, marquis);
    expect(result.category).toBe('negative');
    expect(result.outcomeId).toBe('marquis-no-reaction');
  });

  it('tolerates a small measurement error and still matches', () => {
    const blue = cobalt.outcomes.find((o) => o.id === 'cobalt-blue')!;
    // A few Delta-E of residual correction error should not change the verdict.
    const result = classifySample(shiftLightness(blue.lab, 3), cobalt);
    expect(result.outcomeId).toBe('cobalt-blue');
    expect(result.category).toBe('positive');
  });

  it('returns inconclusive when the colour matches nothing on the panel', () => {
    // Bright saturated green is not a Marquis outcome at all.
    const result = classifySample(labOf('#00c853'), marquis);
    expect(result.category).toBe('inconclusive');
    expect(result.outcomeId).toBeNull();
    expect(result.inconclusiveReason).toBe('no-reference-match');
    expect(result.confidence).toBe('low');
  });

  it('returns inconclusive rather than picking a marginal winner between two outcomes', () => {
    // This is the central safety property. A colour midway between the opiate
    // purple and the MDMA-group dark must not be reported as either.
    const purple = marquis.outcomes.find((o) => o.id === 'marquis-purple')!;
    const dark = marquis.outcomes.find((o) => o.id === 'marquis-dark')!;
    const midpoint: Lab = {
      L: (purple.lab.L + dark.lab.L) / 2,
      a: (purple.lab.a + dark.lab.a) / 2,
      b: (purple.lab.b + dark.lab.b) / 2,
    };

    const result = classifySample(midpoint, marquis);
    expect(result.category).toBe('inconclusive');
    expect(result.inconclusiveReason).toBe('ambiguous-between-outcomes');
    expect(result.ambiguousBetween).toHaveLength(2);
    expect(result.ambiguousBetween).toContain('marquis-purple');
    expect(result.ambiguousBetween).toContain('marquis-dark');
  });

  it('never reports positive when the two guards disagree', () => {
    // Sweep the line between the negative and a positive reference. Every sample
    // must be exactly one of: negative, the positive, or inconclusive — and the
    // transition must pass through inconclusive rather than flipping directly.
    const negative = marquis.outcomes.find((o) => o.id === 'marquis-no-reaction')!;
    const positive = marquis.outcomes.find((o) => o.id === 'marquis-orange-brown')!;

    const categories: string[] = [];
    for (let step = 0; step <= 20; step++) {
      const t = step / 20;
      const sample: Lab = {
        L: negative.lab.L + t * (positive.lab.L - negative.lab.L),
        a: negative.lab.a + t * (positive.lab.a - negative.lab.a),
        b: negative.lab.b + t * (positive.lab.b - negative.lab.b),
      };
      categories.push(classifySample(sample, marquis).category);
    }

    expect(categories[0]).toBe('negative');
    expect(categories[categories.length - 1]).toBe('positive');
    // There must be at least one inconclusive band separating them.
    expect(categories).toContain('inconclusive');

    // And no direct negative -> positive adjacency.
    for (let i = 1; i < categories.length; i++) {
      const transition = `${categories[i - 1]}->${categories[i]}`;
      expect(transition).not.toBe('negative->positive');
      expect(transition).not.toBe('positive->negative');
    }
  });

  it('ranks every outcome nearest first', () => {
    const result = classifySample(labOf('#5a2a6e'), marquis);
    expect(result.ranked).toHaveLength(marquis.outcomes.length);
    for (let i = 1; i < result.ranked.length; i++) {
      expect(result.ranked[i].deltaE).toBeGreaterThanOrEqual(result.ranked[i - 1].deltaE);
    }
    expect(result.ranked[0].outcomeId).toBe('marquis-purple');
  });

  it('reports the actual Delta-E figures so a reviewer can check the work', () => {
    const purple = marquis.outcomes.find((o) => o.id === 'marquis-purple')!;
    const sample = shiftLightness(purple.lab, 4);
    const result = classifySample(sample, marquis);

    expect(result.matchDeltaE).toBeCloseTo(deltaE2000(purple.lab, sample), 6);
    expect(result.separationDeltaE).toBeGreaterThan(0);
    expect(result.separationDeltaE).toBeCloseTo(
      result.ranked[1].deltaE - result.ranked[0].deltaE,
      6,
    );
  });

  it('always demands laboratory confirmation', () => {
    const samples: ClassificationResult[] = [
      classifySample(labOf('#5a2a6e'), marquis),
      classifySample(labOf('#efe7c8'), marquis),
      classifySample(labOf('#00c853'), marquis),
      rejectedCaptureResult(marquis, 'out of focus'),
    ];
    for (const result of samples) {
      expect(result.requiresLaboratoryConfirmation).toBe(true);
    }
  });

  it('carries reference provenance into every result', () => {
    const result = classifySample(labOf('#5a2a6e'), marquis);
    expect(result.referenceProvenance).toBe('placeholder');
    expect(result.referenceNeedsVerification).toBe(true);
  });

  it('degrades confidence as the match worsens', () => {
    const blue = cobalt.outcomes.find((o) => o.id === 'cobalt-blue')!;
    const exact = classifySample(blue.lab, cobalt).confidence;
    const drifted = classifySample(shiftLightness(blue.lab, 14), cobalt).confidence;
    const order = { high: 3, moderate: 2, low: 1 };
    expect(order[exact]).toBeGreaterThanOrEqual(order[drifted]);
  });

  it('respects overridden thresholds', () => {
    const green = labOf('#00c853');
    // Default thresholds reject this outright.
    expect(classifySample(green, marquis).inconclusiveReason).toBe('no-reference-match');
    // An absurdly permissive threshold forces a match, demonstrating the guard is
    // what produces the refusal rather than an accident of the data.
    const forced = classifySample(green, marquis, {
      thresholds: { maxMatchDeltaE: 500, minSeparationDeltaE: 0 },
    });
    expect(forced.outcomeId).not.toBeNull();
  });

  it('handles a single-outcome panel without dividing by a missing runner-up', () => {
    const singleton: ReagentPanel = {
      id: 'singleton',
      name: 'Singleton',
      description: 'Test panel with one reference.',
      thresholds: DEFAULT_THRESHOLDS,
      outcomes: [
        {
          id: 'only',
          label: 'Only outcome',
          category: 'negative',
          lab: labOf('#808080'),
          provenance: 'placeholder',
        } satisfies OutcomeReference,
      ],
    };

    const result = classifySample(labOf('#828282'), singleton);
    expect(result.outcomeId).toBe('only');
    expect(result.separationDeltaE).toBe(Number.POSITIVE_INFINITY);
    expect(Number.isFinite(result.matchDeltaE)).toBe(true);
  });

  it('throws on a panel with no outcomes rather than returning nonsense', () => {
    const empty: ReagentPanel = {
      id: 'empty',
      name: 'Empty',
      description: '',
      thresholds: DEFAULT_THRESHOLDS,
      outcomes: [],
    };
    expect(() => classifySample(labOf('#808080'), empty)).toThrow(/no reference outcomes/i);
  });
});

describe('rejectedCaptureResult', () => {
  it('produces a well-formed inconclusive record for a failed capture', () => {
    // A rejected attempt is still an event worth logging, so it must yield a
    // valid result object rather than nothing.
    const result = rejectedCaptureResult(marquis, 'card not detected');
    expect(result.category).toBe('inconclusive');
    expect(result.outcomeId).toBeNull();
    expect(result.inconclusiveReason).toBe('capture-rejected');
    expect(result.label).toMatch(/card not detected/);
    expect(result.ranked).toHaveLength(0);
    expect(result.panelId).toBe(marquis.id);
  });
});

describe('panelSeparation', () => {
  it('identifies the closest pair on a panel', () => {
    const report = panelSeparation(marquis);
    expect(report.panelId).toBe('marquis');
    expect(report.closestPair[0]).not.toBe('');
    expect(report.minimumPairwiseDeltaE).toBeGreaterThan(0);
  });

  it('flags a panel whose references are too close to separate', () => {
    const bad: ReagentPanel = {
      id: 'bad',
      name: 'Bad panel',
      description: '',
      thresholds: DEFAULT_THRESHOLDS,
      outcomes: [
        {
          id: 'a',
          label: 'A',
          category: 'negative',
          lab: labOf('#808080'),
          provenance: 'placeholder',
        },
        {
          id: 'b',
          label: 'B',
          category: 'positive',
          lab: labOf('#828282'),
          provenance: 'placeholder',
        },
      ],
    };
    const report = panelSeparation(bad);
    expect(report.isSeparable).toBe(false);
    expect(report.minimumPairwiseDeltaE).toBeLessThan(DEFAULT_THRESHOLDS.minSeparationDeltaE);
  });
});
