/**
 * Tamper-evident test records.
 *
 * Structure of the guarantee, and its honest limits:
 *
 * WHAT THIS PROVIDES
 *   - Integrity. Every field of the record is covered by a digital signature. Any
 *     later edit — a changed result, a moved GPS coordinate, an adjusted timestamp
 *     — invalidates the signature.
 *   - Image binding. The record stores the SHA-256 of the captured image, so the
 *     photograph cannot be swapped for a different one after the fact.
 *   - Ordering. Records form a hash chain: each one commits to the hash of the
 *     previous record. Deleting or reordering entries in the middle of a log breaks
 *     the chain and is detectable, which a per-record signature alone would not
 *     catch.
 *   - Attribution to a device key. The signing key is generated non-extractable,
 *     so records are bound to a specific device.
 *
 * WHAT THIS DOES NOT PROVIDE
 *   - It does not prove the *content* is true. A device-held key attests that this
 *     device produced this record, not that the GPS fix was genuine or that the
 *     substance was what the colour suggested. An operator with a rooted device and
 *     a mock location provider can still produce a validly signed record with false
 *     coordinates.
 *   - It is not a substitute for countersigning by an independent party. The
 *     production hardening path is to have records countersigned server-side on
 *     sync, so the department's own key attests to the time of receipt, plus
 *     hardware-backed key attestation and server-side anomaly detection on
 *     implausible GPS movement.
 *
 * A deliberate note on why this is a hash chain in an ordinary database rather than
 * a blockchain: the property actually needed is "an entry cannot be altered or
 * removed without detection", which a signed hash chain gives directly. A
 * distributed consensus mechanism solves a different problem — mutual distrust
 * between many writers — which does not apply to a single department's evidence
 * log, and would add operational cost with no gain in evidential strength.
 */

import {
  canonicalise,
  pruneUndefined,
  type JsonValue,
} from './canonical';
import {
  GENESIS_HASH,
  SIGNATURE_ALGORITHM,
  exportPublicKeyJwk,
  importPublicKeyJwk,
  publicKeyFingerprint,
  randomId,
  sha256Hex,
  sha256HexOfText,
  signBytes,
  verifyBytes,
  type SigningAlgorithm,
} from './crypto';

/**
 * Names the record schema, and is itself a signed field.
 *
 * Safe to rename alongside the application: verification canonicalises the record
 * object as it was stored, including whatever schemaVersion it carries, so records
 * written under the previous name still hash and verify exactly as before. Nothing
 * compares a stored record's schemaVersion against this constant, and nothing
 * should start to without a migration path.
 */
export const RECORD_SCHEMA_VERSION = 'drishti-record-1';

export interface GeoFix {
  latitude: number;
  longitude: number;
  accuracyMetres: number;
  altitudeMetres: number | null;
  /** When the position fix itself was obtained, which may precede the capture. */
  fixedAt: string;
}

export interface OperatorIdentity {
  /** Service or badge identifier. */
  id: string;
  displayName?: string;
  /** Which authority the operator belongs to. */
  agency?: string;
}

export interface DeviceIdentity {
  id: string;
  publicKeyFingerprint: string;
  platform?: string;
}

export interface ImageDigest {
  sha256: string;
  byteLength: number;
  mimeType: string;
  width: number;
  height: number;
}

export interface RecordedResult {
  category: 'positive' | 'negative' | 'inconclusive';
  outcomeId: string | null;
  label: string;
  confidence: 'high' | 'moderate' | 'low';
  /** Null when no comparison was possible, e.g. a rejected capture. */
  matchDeltaE: number | null;
  separationDeltaE: number | null;
  inconclusiveReason?: string;
  referenceProvenance: string;
  referenceNeedsVerification: boolean;
  requiresLaboratoryConfirmation: true;
}

export interface RecordedMeasurement {
  /** Corrected sample colour, or null if correction was unavailable. */
  sampleLab: { L: number; a: number; b: number } | null;
  correctionModel: string | null;
  correctionMeanDeltaE: number | null;
  correctionMaxDeltaE: number | null;
  focusScore: number | null;
  cardCoverage: number | null;
  illuminationGradientStrength: number | null;
  colourCastRatio: number | null;
}

export interface RecordedQualityIssue {
  code: string;
  severity: 'reject' | 'warn';
}

/** Everything the signature covers. */
export interface TestRecordCore {
  schemaVersion: string;
  recordId: string;
  /** UTC instant of capture. */
  capturedAt: string;
  /** Minutes to add to UTC for the device's local time, so local time is recoverable. */
  utcOffsetMinutes: number;
  operator: OperatorIdentity;
  device: DeviceIdentity;
  /** Null when no position was available; the reason is then required. */
  location: GeoFix | null;
  locationUnavailableReason?: string;
  panelId: string;
  panelName: string;
  kitLotNumber?: string;
  caseReference?: string;
  operatorNotes?: string;
  cardSpecVersion: string;
  cardSerial?: string;
  calibrationProvenance: string;
  captureAccepted: boolean;
  rejectionReason?: string;
  result: RecordedResult;
  measurement: RecordedMeasurement;
  qualityIssues: RecordedQualityIssue[];
  image: ImageDigest;
  /** Digest of the flattened card view, when one was produced. */
  rectifiedImage?: ImageDigest;
  chain: {
    index: number;
    previousRecordHash: string;
  };
}

export interface RecordSignature {
  algorithm: SigningAlgorithm;
  publicKeyJwk: JsonWebKey;
  /** Base64url signature over the canonical bytes of the core record. */
  value: string;
  signedAt: string;
  /** SHA-256 of the canonical core, i.e. exactly what was signed. */
  coreHash: string;
}

export interface SignedTestRecord extends TestRecordCore {
  signature: RecordSignature;
}

/** Hash used by the *next* record as its previousRecordHash. */
export async function recordHash(record: SignedTestRecord): Promise<string> {
  return sha256HexOfText(canonicalise(pruneUndefined(record as unknown as JsonValue)));
}

export async function coreHash(core: TestRecordCore): Promise<string> {
  return sha256HexOfText(canonicalise(pruneUndefined(core as unknown as JsonValue)));
}

export interface SignRecordInput {
  core: TestRecordCore;
  privateKey: CryptoKey;
  publicKey: CryptoKey;
  /** Overridable for deterministic tests. */
  signedAt?: string;
}

export async function signRecord(input: SignRecordInput): Promise<SignedTestRecord> {
  const canonical = canonicalise(pruneUndefined(input.core as unknown as JsonValue));
  const bytes = new TextEncoder().encode(canonical);

  const [value, publicKeyJwk, hash] = await Promise.all([
    signBytes(input.privateKey, bytes),
    exportPublicKeyJwk(input.publicKey),
    sha256Hex(bytes),
  ]);

  return {
    ...input.core,
    signature: {
      algorithm: SIGNATURE_ALGORITHM,
      publicKeyJwk,
      value,
      signedAt: input.signedAt ?? new Date().toISOString(),
      coreHash: hash,
    },
  };
}

export type VerificationFailure =
  | 'unsupported-algorithm'
  | 'malformed-public-key'
  | 'core-hash-mismatch'
  | 'bad-signature'
  | 'image-hash-mismatch'
  | 'chain-broken'
  | 'chain-index-mismatch';

export interface VerificationResult {
  valid: boolean;
  failures: VerificationFailure[];
  /** Fingerprint of the key that signed, when it could be read. */
  signedByFingerprint?: string;
}

export interface VerifyOptions {
  /** When supplied, the image bytes are re-hashed and compared. */
  imageBytes?: Uint8Array;
  /** When supplied, chain linkage is checked against the preceding record. */
  previousRecord?: SignedTestRecord | null;
}

/**
 * Verifies a single record.
 *
 * Returns every failure found rather than stopping at the first, because when
 * presenting evidence it matters whether one field was altered or the whole record
 * was fabricated.
 */
export async function verifyRecord(
  record: SignedTestRecord,
  options: VerifyOptions = {},
): Promise<VerificationResult> {
  const failures: VerificationFailure[] = [];

  if (record.signature?.algorithm !== SIGNATURE_ALGORITHM) {
    failures.push('unsupported-algorithm');
    return { valid: false, failures };
  }

  const { signature, ...core } = record;
  const canonical = canonicalise(pruneUndefined(core as unknown as JsonValue));
  const bytes = new TextEncoder().encode(canonical);

  const computedCoreHash = await sha256Hex(bytes);
  if (computedCoreHash !== signature.coreHash) {
    // The stored hash disagrees with the content, so the record was edited after
    // signing (or the stored hash was tampered with to match an edit).
    failures.push('core-hash-mismatch');
  }

  let fingerprint: string | undefined;
  let publicKey: CryptoKey | undefined;
  try {
    publicKey = await importPublicKeyJwk(signature.publicKeyJwk);
    fingerprint = await publicKeyFingerprint(publicKey);
  } catch {
    failures.push('malformed-public-key');
  }

  if (publicKey) {
    const signatureValid = await verifyBytes(publicKey, signature.value, bytes);
    if (!signatureValid) failures.push('bad-signature');
  }

  if (options.imageBytes) {
    const imageHash = await sha256Hex(options.imageBytes);
    if (imageHash !== record.image.sha256) failures.push('image-hash-mismatch');
  }

  if (options.previousRecord !== undefined) {
    const expectedPrevious = options.previousRecord
      ? await recordHash(options.previousRecord)
      : GENESIS_HASH;
    if (record.chain.previousRecordHash !== expectedPrevious) failures.push('chain-broken');

    const expectedIndex = options.previousRecord ? options.previousRecord.chain.index + 1 : 0;
    if (record.chain.index !== expectedIndex) failures.push('chain-index-mismatch');
  }

  return {
    valid: failures.length === 0,
    failures,
    ...(fingerprint ? { signedByFingerprint: fingerprint } : {}),
  };
}

export interface ChainVerificationResult {
  valid: boolean;
  /** Index of the first record that failed, or -1 when the whole chain is intact. */
  firstInvalidIndex: number;
  perRecord: VerificationResult[];
}

/**
 * Verifies an ordered run of records, including the links between them.
 *
 * The chain is what makes deletion detectable. A verifier that only checked
 * signatures would happily accept a log with an inconvenient record removed.
 */
export async function verifyChain(
  records: readonly SignedTestRecord[],
): Promise<ChainVerificationResult> {
  const perRecord: VerificationResult[] = [];
  let firstInvalidIndex = -1;

  for (let i = 0; i < records.length; i++) {
    const previous = i === 0 ? null : records[i - 1];
    const result = await verifyRecord(records[i], { previousRecord: previous });
    perRecord.push(result);
    if (!result.valid && firstInvalidIndex === -1) firstInvalidIndex = i;
  }

  return { valid: firstInvalidIndex === -1, firstInvalidIndex, perRecord };
}

/** Fresh record identifier and the genesis previous-hash, for the first record. */
export function newRecordId(): string {
  return randomId();
}

export { GENESIS_HASH };
