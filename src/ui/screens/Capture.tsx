import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useApp } from '../AppState';
import {
  cameraSupported,
  encodeCanvas,
  getLocation,
  grabFrame,
  isSecureContextOk,
  loadImageFile,
  platformLabel,
  rgbaImageToCanvas,
  startCamera,
  type CameraHandle,
  type CapturedFrame,
} from '../lib/browser';
import { analyseCapture, type AnalysisResult } from '../../core/pipeline/analyse';
import { REAGENT_PANELS, findPanel } from '../../core/classify/panels';
import { commitCapture, type CaptureArtefacts } from '../../app/captureService';
import { isFullyMeasured } from '../../core/card/spec';

export interface CaptureCompletion {
  analysis: AnalysisResult;
  recordId: string;
}

/**
 * Capture screen.
 *
 * The live preview intentionally does not run detection every frame. Continuous
 * analysis on a mid-range phone competes with the camera pipeline for CPU and makes
 * the preview stutter, which makes framing harder rather than easier. Instead the
 * operator gets a static alignment guide and immediate, specific feedback after the
 * shutter — and because a refused capture is recorded rather than discarded, a
 * retry costs nothing but time.
 */
export function CaptureScreen({ onComplete }: { onComplete: (result: CaptureCompletion) => void }) {
  const app = useApp();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const cameraRef = useRef<CameraHandle | null>(null);

  const ids = {
    panel: useId(),
    caseRef: useId(),
    kitLot: useId(),
    notes: useId(),
    notesHint: useId(),
    file: useId(),
  };

  const [panelId, setPanelId] = useState(REAGENT_PANELS[0].id);
  const [caseReference, setCaseReference] = useState('');
  const [kitLotNumber, setKitLotNumber] = useState('');
  const [notes, setNotes] = useState('');
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [lastRejection, setLastRejection] = useState<string | null>(null);

  /*
   * Evidentiary metadata is surfaced on the capture screen rather than being
   * discoverable only afterwards in the record. The operator should be able to see
   * what is about to be committed — which card, which device, what position — before
   * committing it, and the image digest immediately after.
   */
  const [liveLocation, setLiveLocation] = useState<string | null>(null);
  const [locationNote, setLocationNote] = useState<string | null>('Acquiring…');
  const [lastHash, setLastHash] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // Acquire a position on mount so the operator sees it before capturing, and so
  // the first capture is not delayed waiting for a fix.
  useEffect(() => {
    let cancelled = false;
    void getLocation().then((outcome) => {
      if (cancelled) return;
      if (outcome.fix) {
        setLiveLocation(
          `${outcome.fix.latitude.toFixed(4)}°, ${outcome.fix.longitude.toFixed(4)}°`,
        );
        setLocationNote(`±${outcome.fix.accuracyMetres.toFixed(0)} m`);
      } else {
        setLiveLocation(null);
        setLocationNote(outcome.unavailableReason ?? 'Unavailable');
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const copyHash = useCallback(async () => {
    if (!lastHash) return;
    try {
      await navigator.clipboard.writeText(lastHash);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access can be refused; the full digest is selectable on screen.
      setCopied(false);
    }
  }, [lastHash]);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      if (!isSecureContextOk()) {
        setCameraError(
          'The camera needs a secure connection. Open this page over HTTPS, or on localhost. For phone testing on your network, run: npm run dev:https',
        );
        return;
      }
      if (!cameraSupported()) {
        setCameraError('This browser does not support camera access.');
        return;
      }
      try {
        const handle = await startCamera();
        if (cancelled) {
          handle.stop();
          return;
        }
        cameraRef.current = handle;
        if (videoRef.current) {
          videoRef.current.srcObject = handle.stream;
          await videoRef.current.play().catch(() => undefined);
        }
      } catch (error) {
        if (cancelled) return;
        setCameraError(
          error instanceof Error
            ? `Camera unavailable: ${error.message}`
            : 'Camera unavailable.',
        );
      }
    })();

    return () => {
      cancelled = true;
      cameraRef.current?.stop();
      cameraRef.current = null;
    };
  }, []);

  const process = useCallback(
    async (frame: CapturedFrame) => {
      const panel = findPanel(panelId);
      if (!panel) throw new Error(`Unknown reagent panel ${panelId}`);
      if (!app.deviceKeys || !app.operator) {
        throw new Error('The device signing key or operator identity is not ready yet.');
      }

      setStatus('Analysing the reference card…');
      const analysis = analyseCapture(frame.image, {
        panel,
        calibration: app.calibration,
      });

      setStatus('Recording location…');
      const location = await getLocation();

      setStatus('Encoding and hashing the image…');
      const encoded = await encodeCanvas(frame.canvas, 'image/jpeg', 0.92);

      const artefacts: CaptureArtefacts = {
        imageBytes: encoded.bytes,
        imageMimeType: encoded.mimeType,
        imageWidth: encoded.width,
        imageHeight: encoded.height,
        imageBlob: encoded.blob,
      };

      if (analysis.rectifiedCard) {
        const rectifiedCanvas = rgbaImageToCanvas(analysis.rectifiedCard);
        const rectified = await encodeCanvas(rectifiedCanvas, 'image/png');
        artefacts.rectifiedBytes = rectified.bytes;
        artefacts.rectifiedMimeType = rectified.mimeType;
        artefacts.rectifiedWidth = rectified.width;
        artefacts.rectifiedHeight = rectified.height;
        artefacts.rectifiedBlob = rectified.blob;
      }

      setStatus('Signing the record…');
      const { entry } = await commitCapture(
        app.log,
        analysis,
        {
          operator: app.operator,
          device: { id: app.deviceId, platform: platformLabel() },
          deviceKeys: app.deviceKeys,
          publicKeyFingerprint: app.fingerprint,
          calibration: app.calibration,
          location: location.fix,
          locationUnavailableReason: location.unavailableReason,
          caseReference: caseReference.trim() || undefined,
          kitLotNumber: kitLotNumber.trim() || undefined,
          operatorNotes: notes.trim() || undefined,
        },
        artefacts,
      );

      app.noteLogChanged();
      setLastHash(entry.record.image.sha256);
      setLastRejection(analysis.ok ? null : (analysis.rejectionMessage ?? 'Capture refused.'));
      onComplete({ analysis, recordId: entry.recordId });
    },
    [app, caseReference, kitLotNumber, notes, onComplete, panelId],
  );

  const onShutter = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setStatus('Capturing…');
    try {
      if (!videoRef.current) throw new Error('The camera preview is not ready.');
      const frame = grabFrame(videoRef.current);
      await process(frame);
    } catch (error) {
      setStatus(null);
      setCameraError(error instanceof Error ? error.message : 'Capture failed.');
    } finally {
      setBusy(false);
      setStatus(null);
    }
  }, [busy, process]);

  const onFilePicked = useCallback(
    async (file: File | undefined) => {
      if (!file || busy) return;
      setBusy(true);
      try {
        const frame = await loadImageFile(file);
        await process(frame);
      } catch (error) {
        setCameraError(error instanceof Error ? error.message : 'Could not read that image.');
      } finally {
        setBusy(false);
        setStatus(null);
      }
    },
    [busy, process],
  );

  const calibrationMeasured = isFullyMeasured(app.calibration);

  return (
    <div className="screen capture">
      <h1 className="screen-title">Evidence Capture</h1>

      <div className="viewfinder">
        {cameraError ? (
          <div className="camera-fallback" role="alert">
            <p className="warn-text">{cameraError}</p>
            <p className="muted">
              You can still analyse a photograph of the card from this device instead.
            </p>
          </div>
        ) : (
          <video
            ref={videoRef}
            playsInline
            muted
            autoPlay
            className="preview"
            aria-label="Live camera preview"
          />
        )}

        {/* Static alignment guide: matches the card's 88.9 x 54 aspect ratio. */}
        <div className="guide" aria-hidden="true">
          <div className="guide-box">
            <span className="corner tl" />
            <span className="corner tr" />
            <span className="corner br" />
            <span className="corner bl" />
            <span className="guide-hint">Fill this frame with the whole card</span>
          </div>
        </div>
      </div>

      {/* Primary actions sit directly under the viewport, within thumb reach. */}
      <div className="capture-actions">
        <button
          className="primary capture-btn"
          onClick={onShutter}
          disabled={busy || !!cameraError}
        >
          {busy ? 'Working…' : 'Capture'}
        </button>
        <label className="file-button" htmlFor={ids.file}>
          Upload
          <input
            id={ids.file}
            type="file"
            accept="image/*"
            onChange={(event) => onFilePicked(event.target.files?.[0])}
            disabled={busy}
          />
        </label>
      </div>

      {/* Two live regions: progress politely, refusals assertively. */}
      <div role="status" aria-live="polite" className="status-line">
        {status && <p className="muted">{status}</p>}
      </div>
      <div role="alert" aria-live="assertive">
        {lastRejection && (
          <p className="warn-text">Last capture refused: {lastRejection}</p>
        )}
      </div>

      {/* What is about to be recorded, visible before committing to it. */}
      <section className="data-block" aria-labelledby="capture-meta-heading">
        <h2 id="capture-meta-heading" className="data-block-title">
          Record metadata
        </h2>
        <dl className="data-rows">
          <div className="data-row">
            <dt>Colour calibration</dt>
            <dd>
              <span
                className={`state-chip ${calibrationMeasured ? 'state-ok' : 'state-warn'}`}
              >
                <span className="state-dot" aria-hidden="true" />
                {calibrationMeasured ? 'Measured' : 'Nominal'}
              </span>
            </dd>
          </div>
          <div className="data-row">
            <dt>Reference card</dt>
            <dd>
              <code>{app.calibration.cardSerial ?? 'Unserialised'}</code>
            </dd>
          </div>
          <div className="data-row">
            <dt>Device</dt>
            <dd>
              <code>{app.deviceId || '-'}</code>
            </dd>
          </div>
          <div className="data-row">
            <dt>Signing key</dt>
            <dd>
              <code className="hash">{app.fingerprint.slice(0, 16) || '-'}</code>
            </dd>
          </div>
          <div className="data-row">
            <dt>GPS</dt>
            <dd>
              {liveLocation ? (
                <>
                  <code>{liveLocation}</code>{' '}
                  <span className="muted small">{locationNote}</span>
                </>
              ) : (
                <span className="muted">{locationNote}</span>
              )}
            </dd>
          </div>
        </dl>
      </section>

      {/* Image digest. Present only once there is a capture to describe. */}
      <section className="data-block" aria-labelledby="hash-heading">
        <h2 id="hash-heading" className="data-block-title">
          SHA-256 of captured image
        </h2>
        {lastHash ? (
          <div className="hash-block">
            <code className="hash-value">{lastHash}</code>
            <div className="hash-actions">
              <button onClick={copyHash} className="small">
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
            <p className="muted small">
              This digest is inside the signed record, so the photograph cannot be
              substituted afterwards.
            </p>
          </div>
        ) : (
          <p className="muted small">Computed when you capture.</p>
        )}
      </section>

      <div className="capture-form">
        <h2 className="data-block-title">Case details</h2>
        <div className="field">
          <label htmlFor={ids.panel}>Reagent panel</label>
          <select
            id={ids.panel}
            value={panelId}
            onChange={(event) => setPanelId(event.target.value)}
          >
            {REAGENT_PANELS.map((panel) => (
              <option key={panel.id} value={panel.id}>
                {panel.name}
              </option>
            ))}
          </select>
        </div>

        <div className="field-row">
          <div className="field">
            <label htmlFor={ids.caseRef}>Case reference</label>
            <input
              id={ids.caseRef}
              value={caseReference}
              onChange={(event) => setCaseReference(event.target.value)}
              placeholder="FIR-000/2026"
              inputMode="text"
            />
          </div>
          <div className="field">
            <label htmlFor={ids.kitLot}>Kit lot</label>
            <input
              id={ids.kitLot}
              value={kitLotNumber}
              onChange={(event) => setKitLotNumber(event.target.value)}
              placeholder="LOT-0000"
            />
          </div>
        </div>

        <div className="field">
          <label htmlFor={ids.notes}>Notes</label>
          <span className="field-hint" id={ids.notesHint}>
            Optional. Stored in the signed record.
          </span>
          <input
            id={ids.notes}
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            aria-describedby={ids.notesHint}
          />
        </div>

        <p className="disclaimer strong">
          Presumptive field screening only. Every result requires laboratory confirmation.
        </p>
      </div>
    </div>
  );
}
