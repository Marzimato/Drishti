/**
 * Turns an analysed capture into a signed, stored log entry.
 *
 * This is where the measurement pipeline meets the evidentiary one. It is kept
 * separate from React so the whole capture-to-record path can be exercised without
 * a browser.
 *
 * Design note on rejected captures: they are recorded, not discarded. If the
 * software refuses a reading, that refusal is itself part of the account of what
 * happened at the scene. Silently dropping it would leave a gap in the log that
 * looks identical to no test having been attempted.
 */

import {
  RECORD_SCHEMA_VERSION,
  newRecordId,
  signRecord,
  type GeoFix,
  type ImageDigest,
  type OperatorIdentity,
  type RecordedQualityIssue,
  type SignedTestRecord,
  type TestRecordCore,
} from '../core/record/record';
import { sha256Hex } from '../core/record/crypto';
import type { AnalysisResult } from '../core/pipeline/analyse';
import type { ChainPosition, RecordLog, StoredRecord } from '../data/recordLog';
import type { CardCalibration } from '../core/card/spec';
import { CARD_SPEC_VERSION } from '../core/card/spec';

export interface CaptureContext {
  operator: OperatorIdentity;
  device: { id: string; platform?: string };
  deviceKeys: { privateKey: CryptoKey; publicKey: CryptoKey };
  publicKeyFingerprint: string;
  calibration: CardCalibration;
  location: GeoFix | null;
  locationUnavailableReason?: string;
  caseReference?: string;
  kitLotNumber?: string;
  operatorNotes?: string;
  /** Overridable for deterministic tests. */
  capturedAt?: string;
}

export interface CaptureArtefacts {
  /** Original captured frame, as encoded bytes. */
  imageBytes: Uint8Array;
  imageMimeType: string;
  imageWidth: number;
  imageHeight: number;
  imageBlob?: Blob;
  /** Flattened card view, if one was produced. */
  rectifiedBytes?: Uint8Array;
  rectifiedMimeType?: string;
  rectifiedWidth?: number;
  rectifiedHeight?: number;
  rectifiedBlob?: Blob;
}

/**
 * Rounds a measurement for storage.
 *
 * Full double precision in a signed record is noise that differs between devices
 * and invites false precision in how a reader interprets it. Six decimals is far
 * beyond the accuracy of the measurement itself and keeps the canonical bytes
 * stable.
 */
function round(value: number | null | undefined, decimals = 6): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/** Builds the unsigned record core from an analysis result and its context. */
export async function buildRecordCore(
  analysis: AnalysisResult,
  context: CaptureContext,
  artefacts: CaptureArtefacts,
  position: ChainPosition,
): Promise<TestRecordCore> {
  const classification = analysis.classification;
  const now = context.capturedAt ?? new Date().toISOString();

  const image: ImageDigest = {
    sha256: await sha256Hex(artefacts.imageBytes),
    byteLength: artefacts.imageBytes.length,
    mimeType: artefacts.imageMimeType,
    width: artefacts.imageWidth,
    height: artefacts.imageHeight,
  };

  const rectifiedImage: ImageDigest | undefined = artefacts.rectifiedBytes
    ? {
        sha256: await sha256Hex(artefacts.rectifiedBytes),
        byteLength: artefacts.rectifiedBytes.length,
        mimeType: artefacts.rectifiedMimeType ?? 'image/png',
        width: artefacts.rectifiedWidth ?? 0,
        height: artefacts.rectifiedHeight ?? 0,
      }
    : undefined;

  const qualityIssues: RecordedQualityIssue[] =
    analysis.quality?.issues.map((issue) => ({ code: issue.code, severity: issue.severity })) ?? [];

  const metrics = analysis.quality?.metrics;

  return {
    schemaVersion: RECORD_SCHEMA_VERSION,
    recordId: newRecordId(),
    capturedAt: now,
    // Stored so the local wall-clock time at the scene is recoverable from UTC.
    utcOffsetMinutes: -new Date(now).getTimezoneOffset(),
    operator: context.operator,
    device: {
      id: context.device.id,
      publicKeyFingerprint: context.publicKeyFingerprint,
      platform: context.device.platform,
    },
    location: context.location,
    locationUnavailableReason: context.location ? undefined : context.locationUnavailableReason,
    panelId: classification.panelId,
    panelName: classification.panelName,
    kitLotNumber: context.kitLotNumber,
    caseReference: context.caseReference,
    operatorNotes: context.operatorNotes,
    cardSpecVersion: CARD_SPEC_VERSION,
    cardSerial: context.calibration.cardSerial,
    calibrationProvenance: context.calibration.provenance,
    captureAccepted: analysis.ok,
    rejectionReason: analysis.rejectionMessage,
    result: {
      category: classification.category,
      outcomeId: classification.outcomeId,
      label: classification.label,
      confidence: classification.confidence,
      matchDeltaE: round(classification.matchDeltaE, 4),
      separationDeltaE: Number.isFinite(classification.separationDeltaE)
        ? round(classification.separationDeltaE, 4)
        : null,
      inconclusiveReason: classification.inconclusiveReason,
      referenceProvenance: classification.referenceProvenance,
      referenceNeedsVerification: classification.referenceNeedsVerification,
      requiresLaboratoryConfirmation: true,
    },
    measurement: {
      sampleLab: analysis.sampleLab
        ? {
            L: round(analysis.sampleLab.L, 4)!,
            a: round(analysis.sampleLab.a, 4)!,
            b: round(analysis.sampleLab.b, 4)!,
          }
        : null,
      correctionModel: analysis.correction?.model ?? null,
      correctionMeanDeltaE: round(analysis.correction?.meanDeltaE, 4),
      correctionMaxDeltaE: round(analysis.correction?.maxDeltaE, 4),
      focusScore: round(metrics?.focusScore, 3),
      cardCoverage: round(metrics?.cardCoverage, 5),
      illuminationGradientStrength: round(metrics?.illuminationGradientStrength, 4),
      colourCastRatio: round(metrics?.castRatio, 4),
    },
    qualityIssues,
    image,
    rectifiedImage,
    chain: { index: position.index, previousRecordHash: position.previousRecordHash },
  };
}

export interface CommitResult {
  entry: StoredRecord;
  signed: SignedTestRecord;
}

/**
 * Signs the analysis result and appends it to the log.
 *
 * Signing happens inside the log's append callback so it occurs within the
 * serialised critical section, which is what prevents two near-simultaneous
 * captures from signing against the same chain head.
 */
export async function commitCapture(
  log: RecordLog,
  analysis: AnalysisResult,
  context: CaptureContext,
  artefacts: CaptureArtefacts,
): Promise<CommitResult> {
  let signed: SignedTestRecord | undefined;

  const entry = await log.append(async (position) => {
    const core = await buildRecordCore(analysis, context, artefacts, position);
    signed = await signRecord({
      core,
      privateKey: context.deviceKeys.privateKey,
      publicKey: context.deviceKeys.publicKey,
    });
    return {
      core,
      signed,
      image: artefacts.imageBlob,
      rectified: artefacts.rectifiedBlob,
    };
  });

  if (!signed) throw new Error('Signing did not complete');
  return { entry, signed };
}
