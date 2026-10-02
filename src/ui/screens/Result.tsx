import { useEffect, useMemo, useRef } from 'react';
import { useApp } from '../AppState';
import type { AnalysisResult } from '../../core/pipeline/analyse';
import { uncorrectedSampleLab } from '../../core/pipeline/analyse';
import { deltaE2000, describeDeltaE } from '../../core/color/deltaE';
import { labToSrgb, rgbToHex } from '../../core/color/space';
import {
  MAX_PATCH_NON_UNIFORMITY,
  regionNonUniformity,
  type QualityIssue,
} from '../../core/pipeline/quality';
import { rgbaImageToCanvas } from '../lib/browser';
import { StatusBadge } from '../components/StatusBadge';



/**
 * Shows the measured value behind a quality verdict.
 *
 * Without this the operator sees only "a shadow is falling across the card" and has
 * no way to tell a marginal miss from a gross one, or to judge whether the gate is
 * badly tuned for their card and camera.
 */
function IssueNumbers({ issue }: { issue: QualityIssue }) {
  if (issue.measured === undefined) return null;
  const measured = Number.isFinite(issue.measured) ? issue.measured.toFixed(3) : '∞';
  return (
    <span className="muted small">
      {' '}
      (measured {measured}
      {issue.threshold !== undefined && `, limit ${issue.threshold}`})
    </span>
  );
}

/**
 * Result screen.
 *
 * Shows the verdict, then the evidence behind it. The evidence is not hidden behind
 * a disclosure control: an operator who is going to attach this to a case file
 * should see how close the match was, how well the calibration fitted, and any
 * warnings — because those are the things that determine whether the number
 * deserves to be relied on.
 */
export function ResultScreen({
  analysis,
  recordId,
  onNewCapture,
}: {
  analysis: AnalysisResult;
  recordId: string | null;
  onNewCapture: () => void;
}) {
  const app = useApp();
  const cardRef = useRef<HTMLDivElement | null>(null);

  const classification = analysis.classification;

  const correctedHex = useMemo(
    () => (analysis.sampleLab ? rgbToHex(labToSrgb(analysis.sampleLab)) : null),
    [analysis.sampleLab],
  );

  const rawLab = useMemo(() => uncorrectedSampleLab(analysis), [analysis]);
  const rawHex = useMemo(() => (rawLab ? rgbToHex(labToSrgb(rawLab)) : null), [rawLab]);

  useEffect(() => {
    const host = cardRef.current;
    if (!host || !analysis.rectifiedCard) return;
    host.innerHTML = '';
    const canvas = rgbaImageToCanvas(analysis.rectifiedCard);
    canvas.className = 'rectified';
    host.appendChild(canvas);
  }, [analysis.rectifiedCard]);

  const rejections = analysis.quality?.issues.filter((issue) => issue.severity === 'reject') ?? [];
  const warnings = analysis.quality?.issues.filter((issue) => issue.severity === 'warn') ?? [];

  const fmt = (value: number | undefined) =>
    value !== undefined && Number.isFinite(value) ? value.toFixed(2) : '-';

  return (
    <div className="screen result">
      {/*
        The headline is a compact, conventional readout — verdict, confidence, and
        the two numbers that decide the verdict — in the shape of a kit or lab
        result line. The descriptive field guidance that used to lead the screen now
        lives under "Capture quality detail" below, available but no longer the first
        thing an operator reads.

        role="status" announces the verdict when this screen mounts; without it a
        screen reader user gets no notification that the analysis finished.
      */}
      <section
        className={`verdict ${classification.category}`}
        role="status"
        aria-live="polite"
        aria-labelledby="verdict-heading"
      >
        <div className="verdict-head">
          <StatusBadge category={classification.category} />
          <span className="confidence">{classification.confidence} confidence</span>
        </div>
        <h2 id="verdict-heading">{classification.label}</h2>

        <dl className="readout">
          <div>
            <dt>Panel</dt>
            <dd>{classification.panelName}</dd>
          </div>
          <div>
            <dt>Match ΔE</dt>
            <dd>{fmt(classification.matchDeltaE)}</dd>
          </div>
          <div>
            <dt>Separation ΔE</dt>
            <dd>
              {Number.isFinite(classification.separationDeltaE)
                ? fmt(classification.separationDeltaE)
                : '-'}
            </dd>
          </div>
          {analysis.correction && (
            <div>
              <dt>Fit ΔE</dt>
              <dd>{analysis.correction.meanDeltaE.toFixed(2)}</dd>
            </div>
          )}
        </dl>

        {classification.associatedSubstances && (
          <p className="muted small">
            Associated with: {classification.associatedSubstances.join(', ')}. Presumptive
            association only.
          </p>
        )}
      </section>

      <p className="disclaimer strong">
        This is a presumptive field-test result. It does not replace laboratory confirmatory
        testing.
      </p>

      {!analysis.ok && (
        <section className="panel danger">
          <h3>Capture refused</h3>
          <p>{analysis.rejectionMessage}</p>
          <p className="muted">
            The attempt has still been recorded and signed, so the log shows that a test was
            made and could not be read.
          </p>
        </section>
      )}

      {(rejections.length > 0 || warnings.length > 0) && (
        <details className="quality-detail" open={!analysis.ok}>
          <summary>
            Capture quality detail
            {(rejections.length > 0 || warnings.length > 0) && (
              <span className="muted small">
                {' '}
                ({rejections.length} blocking, {warnings.length} advisory)
              </span>
            )}
          </summary>

          {rejections.length > 0 && (
            <div className="panel danger">
              <h3>Problems that blocked a reading</h3>
              <ul>
                {rejections.map((issue) => (
                  <li key={issue.code}>
                    {issue.message}
                    <IssueNumbers issue={issue} />
                  </li>
                ))}
              </ul>
            </div>
          )}

          {warnings.length > 0 && (
            <div className="panel warn">
              <h3>Advisories</h3>
              <ul>
                {warnings.map((issue) => (
                  <li key={issue.code}>
                    {issue.message}
                    <IssueNumbers issue={issue} />
                  </li>
                ))}
              </ul>
            </div>
          )}
        </details>
      )}

      {analysis.patchReadings && analysis.patchReadings.length > 0 && (
        <section className="panel">
          <h3>Per-patch diagnostics</h3>
          <div className="table-scroll">
          <table className="data compact">
            <caption className="sr-only">
              Each reference patch, its printed colour, the colour read back after
              correction, the colour difference, the variation within the patch, and
              the proportion of clipped pixels.
            </caption>
            <thead>
              <tr>
                <th>#</th>
                <th>Print</th>
                <th>Read</th>
                <th>ΔE</th>
                <th>Variation</th>
                <th>Clipped</th>
              </tr>
            </thead>
            <tbody>
              {analysis.patchReadings.map((reading, index) => {
                const readHex = reading.correctedLab
                  ? rgbToHex(labToSrgb(reading.correctedLab))
                  : null;
                const deltaE = reading.correctedLab
                  ? deltaE2000(reading.referenceLab, reading.correctedLab)
                  : null;
                const variation = regionNonUniformity(reading.sample);
                const overVariation = variation > MAX_PATCH_NON_UNIFORMITY;
                return (
                  <tr key={reading.patch.id}>
                    <td>{index + 1}</td>
                    <td>
                      <span
                        className="swatch tiny"
                        style={{ background: reading.patch.nominalHex }}
                        aria-hidden="true"
                      />
                      {/* A bare colour block conveys nothing without sight. */}
                      <span className="sr-only">{reading.patch.nominalHex}</span>
                    </td>
                    <td>
                      {readHex ? (
                        <>
                          <span
                            className="swatch tiny"
                            style={{ background: readHex }}
                            aria-hidden="true"
                          />
                          <span className="sr-only">{readHex}</span>
                        </>
                      ) : (
                        '-'
                      )}
                    </td>
                    <td>{deltaE === null ? '-' : deltaE.toFixed(1)}</td>
                    <td className={overVariation ? 'warn-text' : undefined}>
                      {Number.isFinite(variation) ? variation.toFixed(3) : '∞'}
                      {/* Text, not just colour, marks the breach. */}
                      {overVariation && (
                        <>
                          {' '}
                          <span className="tag">over limit</span>
                        </>
                      )}
                    </td>
                    <td>{(reading.sample.clippedFraction * 100).toFixed(0)}%</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>
          <p className="muted">
            "Variation" is the luminance spread within each patch, relative to its mean. The
            uniformity gate refuses a capture above {MAX_PATCH_NON_UNIFORMITY}; offending values are
            marked "over limit". Print banding, paper texture, camera sharpening and a curled card
            all raise this independently of the lighting.
          </p>
        </section>
      )}

      {correctedHex && (
        <section className="panel">
          <h3>Measured colour</h3>
          <div className="swatch-row">
            <div className="swatch-block">
              <span
                className="swatch"
                style={{ background: correctedHex }}
                aria-hidden="true"
              />
              <span className="swatch-label">
                Calibrated
                <br />
                <code>{correctedHex}</code>
              </span>
            </div>
            {rawHex && (
              <div className="swatch-block">
                <span
                  className="swatch"
                  style={{ background: rawHex }}
                  aria-hidden="true"
                />
                <span className="swatch-label">
                  Raw pixels
                  <br />
                  <code>{rawHex}</code>
                </span>
              </div>
            )}
          </div>
          <p className="muted">
            The calibrated swatch is what the sample would look like under standard daylight.
            The difference between the two is the lighting error the reference card removed.
          </p>
        </section>
      )}

      {classification.ranked.length > 0 && (
        <section className="panel">
          <h3>How the colour compared</h3>
          <table className="data">
            <caption className="sr-only">
              Every possible outcome for this reagent, ordered by how closely it
              matches the measured colour.
            </caption>
            <thead>
              <tr>
                <th scope="col">Reference outcome</th>
                <th scope="col">ΔE2000</th>
                <th scope="col">Interpretation</th>
              </tr>
            </thead>
            <tbody>
              {classification.ranked.map((entry, index) => (
                <tr key={entry.outcomeId} className={index === 0 ? 'best' : undefined}>
                  <td>
                    {entry.label}
                    {/* The highlight row is styled; say so in text as well. */}
                    {index === 0 && <span className="sr-only"> (closest match)</span>}
                  </td>
                  <td>{entry.deltaE.toFixed(2)}</td>
                  <td className="muted">{describeDeltaE(entry.deltaE)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted">
            Closest match {classification.matchDeltaE.toFixed(2)} ΔE, clear of the runner-up by{' '}
            {Number.isFinite(classification.separationDeltaE)
              ? `${classification.separationDeltaE.toFixed(2)} ΔE`
              : 'no competing reference'}
            .
          </p>
        </section>
      )}

      {classification.referenceNeedsVerification && (
        <section className="panel warn">
          <h3>Reference data is not lab-verified</h3>
          <p>
            This panel's reference colours are approximations of published colour descriptions,
            marked <code>{classification.referenceProvenance}</code>. Results are internally
            consistent and comparable between captures, but the absolute colour targets have not
            been verified against known reference reactions for this kit.
          </p>
        </section>
      )}

      {analysis.rectifiedCard && (
        <section className="panel">
          <h3>What the software measured</h3>
          <div ref={cardRef} className="rectified-host" />
          <p className="muted">
            The card flattened to a square-on view. The sample reading is taken from the marked
            area in the middle.
          </p>
        </section>
      )}

      {analysis.correction && (
        <section className="panel">
          <h3>Calibration quality</h3>
          <dl className="metrics">
            <div>
              <dt>Correction model</dt>
              <dd>{analysis.correction.model}</dd>
            </div>
            <div>
              <dt>Patches used</dt>
              <dd>{analysis.correction.patchesUsed} of 12</dd>
            </div>
            <div>
              <dt>Mean fit error</dt>
              <dd>{analysis.correction.meanDeltaE.toFixed(2)} ΔE</dd>
            </div>
            <div>
              <dt>Worst patch</dt>
              <dd>{analysis.correction.maxDeltaE.toFixed(2)} ΔE</dd>
            </div>
            {analysis.quality && (
              <>
                <div>
                  <dt>Sharpness</dt>
                  <dd>{analysis.quality.metrics.focusScore.toFixed(0)}</dd>
                </div>
                <div>
                  <dt>Card coverage</dt>
                  <dd>{(analysis.quality.metrics.cardCoverage * 100).toFixed(1)}%</dd>
                </div>
              </>
            )}
          </dl>
        </section>
      )}

      <div className="actions">
        <button className="primary" onClick={onNewCapture}>
          New capture
        </button>
        {recordId && (
          <button onClick={() => app.selectRecord(recordId)}>View signed record</button>
        )}
        <button onClick={() => app.navigate('log')}>Test log</button>
      </div>
    </div>
  );
}
