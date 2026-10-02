import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useApp } from '../AppState';
import { REAGENT_PANELS, panelProvenance } from '../../core/classify/panels';
import {
  CARD_SPEC_VERSION,
  NOMINAL_CALIBRATION,
  PATCHES,
  describeProvenance,
  nominalLabFor,
} from '../../core/card/spec';
import {
  DEFAULT_MIN_CALIBRATION_FRAMES,
  buildSelfCalibration,
  type CalibrationFrame,
} from '../../core/card/selfCalibrate';
import { readCalibrationFrame } from '../../app/calibrationCapture';
import { panelSeparation } from '../../core/classify/engine';
import { renderCalibrationWorksheetCsv } from '../../core/card/printable';
import {
  cameraSupported,
  downloadText,
  grabFrame,
  isSecureContextOk,
  loadImageFile,
  startCamera,
  type CameraHandle,
} from '../lib/browser';

/** Settings: operator identity, device key, card calibration, diagnostics. */
export function SettingsScreen() {
  const app = useApp();
  const ids = {
    operatorId: useId(),
    displayName: useId(),
    agency: useId(),
    cardSerial: useId(),
    serialHint: useId(),
  };
  const [operatorId, setOperatorId] = useState(app.operator?.id ?? '');
  const [displayName, setDisplayName] = useState(app.operator?.displayName ?? '');
  const [agency, setAgency] = useState(app.operator?.agency ?? '');
  const [cardSerial, setCardSerial] = useState(app.calibration.cardSerial ?? '');
  const [saved, setSaved] = useState<string | null>(null);
  const [recordCount, setRecordCount] = useState(0);

  useEffect(() => {
    void app.log.count().then(setRecordCount);
  }, [app.log, app.logRevision]);

  const saveOperator = useCallback(async () => {
    await app.saveOperator({
      id: operatorId.trim(),
      displayName: displayName.trim() || undefined,
      agency: agency.trim() || undefined,
    });
    setSaved('Operator details saved.');
  }, [agency, app, displayName, operatorId]);

  const saveCard = useCallback(async () => {
    await app.saveCalibration({ ...app.calibration, cardSerial: cardSerial.trim() || undefined });
    setSaved('Card details saved.');
  }, [app, cardSerial]);

  /* ------------------------------------------------- self-measured calibration */

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const cameraRef = useRef<CameraHandle | null>(null);
  const [calibrating, setCalibrating] = useState(false);
  const [frames, setFrames] = useState<CalibrationFrame[]>([]);
  const [calibError, setCalibError] = useState<string | null>(null);
  const [calibBusy, setCalibBusy] = useState(false);

  const stopCamera = useCallback(() => {
    cameraRef.current?.stop();
    cameraRef.current = null;
    setCalibrating(false);
  }, []);

  useEffect(() => stopCamera, [stopCamera]);

  const beginCalibration = useCallback(async () => {
    setCalibError(null);
    setFrames([]);
    if (!isSecureContextOk() || !cameraSupported()) {
      setCalibError(
        'Camera calibration needs a secure connection and camera access. You can still add frames from image files below.',
      );
      setCalibrating(true);
      return;
    }
    try {
      const handle = await startCamera();
      cameraRef.current = handle;
      setCalibrating(true);
      if (videoRef.current) {
        videoRef.current.srcObject = handle.stream;
        await videoRef.current.play().catch(() => undefined);
      }
    } catch (error) {
      setCalibError(error instanceof Error ? error.message : 'Camera unavailable.');
      setCalibrating(true);
    }
  }, []);

  const addFrame = useCallback((image: Parameters<typeof readCalibrationFrame>[0]) => {
    const outcome = readCalibrationFrame(image);
    if (!outcome.ok) {
      setCalibError(outcome.message);
      return;
    }
    setCalibError(null);
    setFrames((current) => [...current, outcome.frame]);
  }, []);

  const captureFrame = useCallback(() => {
    if (!videoRef.current) return;
    setCalibBusy(true);
    try {
      addFrame(grabFrame(videoRef.current).image);
    } catch (error) {
      setCalibError(error instanceof Error ? error.message : 'Could not read that frame.');
    } finally {
      setCalibBusy(false);
    }
  }, [addFrame]);

  const addFrameFromFile = useCallback(
    async (file: File | undefined) => {
      if (!file) return;
      setCalibBusy(true);
      try {
        const loaded = await loadImageFile(file);
        addFrame(loaded.image);
      } catch (error) {
        setCalibError(error instanceof Error ? error.message : 'Could not read that image.');
      } finally {
        setCalibBusy(false);
      }
    },
    [addFrame],
  );

  const saveSelfCalibration = useCallback(async () => {
    const result = buildSelfCalibration(frames, { cardSerial: cardSerial.trim() || undefined });
    if (!result.ok) {
      setCalibError(result.message);
      return;
    }
    await app.saveCalibration(result.calibration);
    stopCamera();
    setFrames([]);
    setSaved(
      `Self-measured calibration saved from ${result.report.frameCount} frames (worst agreement ${result.report.worstAgreementDeltaE.toFixed(1)} ΔE).`,
    );
  }, [app, cardSerial, frames, stopCamera]);

  const revertToNominal = useCallback(async () => {
    await app.saveCalibration({
      ...NOMINAL_CALIBRATION,
      cardSerial: cardSerial.trim() || undefined,
    });
    setSaved('Reverted to nominal calibration.');
  }, [app, cardSerial]);

  const enoughFrames = frames.length >= DEFAULT_MIN_CALIBRATION_FRAMES;

  return (
    <div className="screen settings">
      <h1>Settings</h1>

      <section className="panel" aria-labelledby="operator-heading">
        <h3 id="operator-heading">Operator</h3>
        <div className="field">
          <label htmlFor={ids.operatorId}>Service identifier</label>
          <input
            id={ids.operatorId}
            value={operatorId}
            onChange={(event) => setOperatorId(event.target.value)}
            autoComplete="username"
          />
        </div>
        <div className="field">
          <label htmlFor={ids.displayName}>Name</label>
          <input
            id={ids.displayName}
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            autoComplete="name"
          />
        </div>
        <div className="field">
          <label htmlFor={ids.agency}>Agency</label>
          <input
            id={ids.agency}
            value={agency}
            onChange={(event) => setAgency(event.target.value)}
            autoComplete="organization"
          />
        </div>
        <button className="primary" onClick={saveOperator} disabled={!operatorId.trim()}>
          Save operator
        </button>
      </section>

      <section className="panel" aria-labelledby="card-heading">
        <h3 id="card-heading">Reference card</h3>
        <div className="field">
          <label htmlFor={ids.cardSerial}>Card serial</label>
          <span className="field-hint" id={ids.serialHint}>
            Printed on the card. Stored with each record so the card used is traceable.
          </span>
          <input
            id={ids.cardSerial}
            value={cardSerial}
            onChange={(event) => setCardSerial(event.target.value)}
            placeholder="DR-0001"
            aria-describedby={ids.serialHint}
          />
        </div>
        <button onClick={saveCard}>Save card details</button>

        <p>
          Calibration mode: <strong>{describeProvenance(app.calibration.provenance)}</strong>
          {app.calibration.frameCount ? ` · ${app.calibration.frameCount} frames` : ''}
        </p>
        <p className="muted">
          Nominal means the reference values are the colours sent to the printer, not the colours
          the printed card actually has. Readings stay consistent between captures either way, but
          absolute accuracy needs the printed card measured.
        </p>
        <div className="actions">
          <button onClick={() => app.navigate('card')}>Print the reference card</button>
          <button
            onClick={() =>
              downloadText(
                'calibration-worksheet.csv',
                renderCalibrationWorksheetCsv(),
                'text/csv',
              )
            }
          >
            Measurement worksheet
          </button>
          {app.calibration.provenance !== 'nominal' && (
            <button onClick={revertToNominal}>Revert to nominal</button>
          )}
        </div>
      </section>

      <section className="panel" aria-labelledby="selfcal-heading">
        <h3 id="selfcal-heading">Self-measure this card</h3>
        <p className="muted">
          Photograph the printed card several times under even light. Each frame is read and the
          patches are averaged, which cancels paper texture and the odd shadow that a single photo
          cannot. The result describes <em>this</em> physical card, so it removes the printer error
          that nominal values carry. It is recorded as <strong>self-measured</strong>: camera
          derived, honestly distinct from an instrument measurement.
        </p>

        {!calibrating ? (
          <button className="primary" onClick={beginCalibration}>
            Start calibration capture
          </button>
        ) : (
          <>
            <div className="viewfinder calib">
              <video
                ref={videoRef}
                playsInline
                muted
                autoPlay
                className="preview"
                aria-label="Calibration camera preview"
              />
            </div>

            <div className="actions">
              <button className="primary" onClick={captureFrame} disabled={calibBusy}>
                Capture frame ({frames.length})
              </button>
              <label className="file-button" htmlFor="calib-file">
                Add from file
                <input
                  id="calib-file"
                  type="file"
                  accept="image/*"
                  onChange={(event) => void addFrameFromFile(event.target.files?.[0])}
                  disabled={calibBusy}
                />
              </label>
              <button onClick={() => setFrames([])} disabled={frames.length === 0}>
                Clear frames
              </button>
              <button onClick={stopCamera}>Cancel</button>
            </div>

            <p className="muted small" role="status" aria-live="polite">
              {frames.length} frame(s) captured.{' '}
              {enoughFrames
                ? 'Enough to average. Capture a couple more for a steadier result, then save.'
                : `Capture at least ${DEFAULT_MIN_CALIBRATION_FRAMES} under the same even light.`}
            </p>

            <button
              className="primary"
              onClick={saveSelfCalibration}
              disabled={!enoughFrames || calibBusy}
            >
              Average and save ({frames.length} frames)
            </button>
          </>
        )}

        {calibError && (
          <div role="alert">
            <p className="field-error">{calibError}</p>
          </div>
        )}
      </section>

      <section className="panel">
        <h3>Device signing key</h3>
        <p>
          Fingerprint: <code>{app.fingerprint || '-'}</code>
        </p>
        <p className="muted">
          Generated on this device and stored non-extractably, so the private key cannot be read
          out of the browser. Every record is signed with it. This proves a record came from this
          device; it does not by itself prove the recorded location or time are genuine.
        </p>
        <p className="muted">
          Storage: {app.usingPersistentStorage ? 'persistent (IndexedDB)' : 'in memory only'}
          {!app.usingPersistentStorage && '. Records will be lost when this page closes.'}
        </p>
        <p className="muted">{recordCount} record(s) held on this device.</p>
      </section>

      <section className="panel">
        <h3>Reagent reference data</h3>
        <div className="table-scroll">
        <table className="data">
          <thead>
            <tr>
              <th scope="col">Panel</th>
              <th scope="col">Outcomes</th>
              <th scope="col">Closest pair</th>
              <th scope="col">Provenance</th>
            </tr>
          </thead>
          <tbody>
            {REAGENT_PANELS.map((panel) => {
              const separation = panelSeparation(panel);
              return (
                <tr key={panel.id}>
                  <td>{panel.name}</td>
                  <td>{panel.outcomes.length}</td>
                  <td>{separation.minimumPairwiseDeltaE.toFixed(1)} ΔE</td>
                  <td>{panelProvenance(panel)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        </div>
        <p className="muted">
          All shipped panels use placeholder reference colours derived from published colour
          descriptions. They demonstrate the pipeline; they are not a validated colour standard.
        </p>
      </section>

      <section className="panel">
        <h3>Card patch reference values</h3>
        <div className="table-scroll">
        <table className="data compact">
          <thead>
            <tr>
              <th scope="col">#</th>
              <th scope="col">Patch</th>
              <th scope="col">Print colour</th>
              <th scope="col">Nominal L*a*b*</th>
            </tr>
          </thead>
          <tbody>
            {PATCHES.map((patch, index) => {
              const lab = nominalLabFor(patch);
              return (
                <tr key={patch.id}>
                  <td>{index + 1}</td>
                  <td>{patch.id}</td>
                  <td>
                    <span
                      className="swatch tiny"
                      style={{ background: patch.nominalHex }}
                      aria-hidden="true"
                    />{' '}
                    <code>{patch.nominalHex}</code>
                  </td>
                  <td>
                    {lab.L.toFixed(1)}, {lab.a.toFixed(1)}, {lab.b.toFixed(1)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        </div>
      </section>

      <section className="panel" aria-labelledby="about-heading">
        <h3 id="about-heading">About</h3>
        <p>
          <strong>DRISHTI</strong>: Drug Sample Imaging, Standardization &amp; Testing
          Information System.
        </p>
        <p className="muted">
          Reference card specification <code>{CARD_SPEC_VERSION}</code>. Every record stores the
          card version it was captured against, so a record taken with an earlier card stays
          interpretable after the card is revised.
        </p>
        <p className="muted small">
          Prototype. Presumptive field screening only; every result requires laboratory
          confirmation. Interface aligned with UX4G and GIGW conventions; aligned, not
          certified, since conformance needs an audit with assistive technology. The interface is
          currently English-only, where GIGW expects bilingual delivery.
        </p>
      </section>

      <section className="panel">
        <h3>Session</h3>
        <button onClick={app.lock}>Lock app</button>
      </section>

      {/* Confirmation must be announced, not only shown. */}
      <div role="status" aria-live="polite">
        {saved && <p className="muted">{saved}</p>}
      </div>
    </div>
  );
}
