import { useCallback, useEffect, useState } from 'react';
import { useApp } from '../AppState';
import type { StoredRecord } from '../../data/recordLog';
import type { VerificationResult } from '../../core/record/record';
import { canonicalise, pruneUndefined, type JsonValue } from '../../core/record/canonical';
import { downloadText } from '../lib/browser';
import { StatusBadge } from '../components/StatusBadge';

const FAILURE_EXPLANATIONS: Record<string, string> = {
  'unsupported-algorithm': 'The record claims a signature algorithm this app does not accept.',
  'malformed-public-key': 'The embedded public key could not be read.',
  'core-hash-mismatch': 'The stored content hash does not match the content. The record was edited.',
  'bad-signature': 'The signature does not match the content. The record was altered after signing.',
  'image-hash-mismatch': 'The stored image is not the image that was signed.',
  'chain-broken': 'This record does not link to the record before it. An entry was changed or removed.',
  'chain-index-mismatch': 'This record claims the wrong position in the log.',
};

/** Signed record detail, with live verification. */
export function DetailScreen() {
  const app = useApp();
  const [entry, setEntry] = useState<StoredRecord | null>(null);
  const [verification, setVerification] = useState<VerificationResult | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [showJson, setShowJson] = useState(false);

  const recordId = app.selectedRecordId;

  useEffect(() => {
    let revoked: string | null = null;
    let cancelled = false;

    (async () => {
      if (!recordId) return;
      const stored = await app.log.get(recordId);
      if (cancelled) return;
      setEntry(stored ?? null);

      if (stored?.image) {
        const url = URL.createObjectURL(stored.image);
        revoked = url;
        setImageUrl(url);
      }

      // Verification is performed on every view rather than cached, so what is
      // displayed reflects the record as it exists right now.
      const result = await app.log.verifyOne(recordId);
      if (!cancelled) setVerification(result ?? null);
    })();

    return () => {
      cancelled = true;
      if (revoked) URL.revokeObjectURL(revoked);
    };
  }, [app.log, recordId]);

  const exportOne = useCallback(() => {
    if (!entry) return;
    downloadText(
      `drishti-record-${entry.chainIndex}.json`,
      JSON.stringify(entry.record, null, 2),
      'application/json',
    );
  }, [entry]);

  if (!recordId) {
    return (
      <div className="screen">
        <p className="muted">No record selected.</p>
        <button onClick={() => app.navigate('log')}>Back to log</button>
      </div>
    );
  }

  if (!entry) {
    return (
      <div className="screen">
        <p className="muted">Loading record…</p>
      </div>
    );
  }

  const record = entry.record;

  return (
    <div className="screen detail">
      <div className="actions">
        <button onClick={() => app.navigate('log')}>← Back to log</button>
        <button onClick={exportOne}>Export this record</button>
      </div>

      <h1>Record #{record.chain.index}</h1>

      {/*
        Verification outcome is announced, and the panel carries an explicit
        "Verified" / "Verification failed" word rather than relying on the
        green/red styling alone.
      */}
      <section
        className={`panel ${verification?.valid ? 'ok' : verification ? 'danger' : ''}`}
        role="status"
        aria-live="polite"
      >
        <h3>Integrity</h3>
        {!verification && <p className="muted">Verifying…</p>}
        {verification?.valid && (
          <>
            <p>
              <strong>Verified.</strong> The signature matches the content, the stored image
              matches its hash, and the record links correctly to its predecessor.
            </p>
            <p className="muted">
              Signed by device key <code>{verification.signedByFingerprint}</code>
            </p>
          </>
        )}
        {verification && !verification.valid && (
          <>
            <p>
              <strong>Verification failed.</strong> This record cannot be relied on.
            </p>
            <ul>
              {verification.failures.map((failure) => (
                <li key={failure}>{FAILURE_EXPLANATIONS[failure] ?? failure}</li>
              ))}
            </ul>
          </>
        )}
      </section>

      <section className="panel">
        <h3>Result</h3>
        <dl className="metrics">
          <div>
            <dt>Outcome</dt>
            <dd>
              <StatusBadge category={record.result.category} />
            </dd>
          </div>
          <div>
            <dt>Interpretation</dt>
            <dd>{record.result.label}</dd>
          </div>
          <div>
            <dt>Reagent</dt>
            <dd>{record.panelName}</dd>
          </div>
          <div>
            <dt>Confidence</dt>
            <dd>{record.result.confidence}</dd>
          </div>
          <div>
            <dt>Closest match</dt>
            <dd>{record.result.matchDeltaE?.toFixed(2) ?? '-'} ΔE</dd>
          </div>
          <div>
            <dt>Capture accepted</dt>
            <dd>{record.captureAccepted ? 'yes' : 'no'}</dd>
          </div>
        </dl>
        {record.rejectionReason && <p className="warn-text">{record.rejectionReason}</p>}
        <p className="disclaimer">
          Presumptive result. Laboratory confirmation is required in every case.
        </p>
      </section>

      <section className="panel">
        <h3>Provenance</h3>
        <dl className="metrics">
          <div>
            <dt>Captured</dt>
            <dd>{new Date(record.capturedAt).toLocaleString()}</dd>
          </div>
          <div>
            <dt>UTC</dt>
            <dd>
              <code>{record.capturedAt}</code>
            </dd>
          </div>
          <div>
            <dt>Operator</dt>
            <dd>
              {record.operator.displayName
                ? `${record.operator.displayName} (${record.operator.id})`
                : record.operator.id}
            </dd>
          </div>
          <div>
            <dt>Case</dt>
            <dd>{record.caseReference ?? '-'}</dd>
          </div>
          <div>
            <dt>Kit lot</dt>
            <dd>{record.kitLotNumber ?? '-'}</dd>
          </div>
          <div>
            <dt>Location</dt>
            <dd>
              {record.location
                ? `${record.location.latitude.toFixed(6)}, ${record.location.longitude.toFixed(6)} ±${record.location.accuracyMetres.toFixed(0)} m`
                : (record.locationUnavailableReason ?? 'not recorded')}
            </dd>
          </div>
          <div>
            <dt>Device key</dt>
            <dd>
              <code>{record.device.publicKeyFingerprint}</code>
            </dd>
          </div>
          <div>
            <dt>Card</dt>
            <dd>
              {record.cardSpecVersion}
              {record.cardSerial ? ` · ${record.cardSerial}` : ''} · {record.calibrationProvenance}
            </dd>
          </div>
        </dl>
        {record.operatorNotes && <p>Notes: {record.operatorNotes}</p>}
      </section>

      <section className="panel">
        <h3>Chain</h3>
        <dl className="metrics">
          <div>
            <dt>Position</dt>
            <dd>{record.chain.index}</dd>
          </div>
          <div>
            <dt>Previous record hash</dt>
            <dd>
              <code className="hash">{record.chain.previousRecordHash}</code>
            </dd>
          </div>
          <div>
            <dt>Signed content hash</dt>
            <dd>
              <code className="hash">{record.signature.coreHash}</code>
            </dd>
          </div>
          <div>
            <dt>Image SHA-256</dt>
            <dd>
              <code className="hash">{record.image.sha256}</code>
            </dd>
          </div>
        </dl>
      </section>

      {imageUrl && (
        <section className="panel">
          <h3>Captured image</h3>
          <img src={imageUrl} alt="Captured test result with reference card" className="capture-image" />
          <p className="muted">
            This is the exact image whose SHA-256 is recorded above, so the digest can be
            recomputed from it at any time.
          </p>
        </section>
      )}

      <section className="panel">
        <h3>Signed payload</h3>
        <button onClick={() => setShowJson((value) => !value)}>
          {showJson ? 'Hide' : 'Show'} canonical JSON
        </button>
        {showJson && (
          <pre className="json">
            {canonicalise(pruneUndefined(record as unknown as JsonValue))}
          </pre>
        )}
        <p className="muted">
          These exact bytes are what the signature covers. Any change to them, anywhere,
          invalidates it.
        </p>
      </section>
    </div>
  );
}
