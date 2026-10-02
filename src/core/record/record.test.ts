import { beforeAll, describe, expect, it } from 'vitest';
import {
  GENESIS_HASH,
  RECORD_SCHEMA_VERSION,
  coreHash,
  recordHash,
  signRecord,
  verifyChain,
  verifyRecord,
  type SignedTestRecord,
  type TestRecordCore,
} from './record';
import {
  generateExtractableKeyPair,
  publicKeyFingerprint,
  sha256Hex,
  type DeviceKeyPair,
} from './crypto';
import { canonicalise, pruneUndefined, type JsonValue } from './canonical';

let keys: DeviceKeyPair;
let otherKeys: DeviceKeyPair;
let fingerprint: string;

beforeAll(async () => {
  keys = await generateExtractableKeyPair();
  otherKeys = await generateExtractableKeyPair();
  fingerprint = await publicKeyFingerprint(keys.publicKey);
});

const imageBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4, 5]);

async function makeCore(overrides: Partial<TestRecordCore> = {}): Promise<TestRecordCore> {
  return {
    schemaVersion: RECORD_SCHEMA_VERSION,
    recordId: '11111111-2222-4333-8444-555555555555',
    capturedAt: '2026-09-11T10:15:00.000Z',
    utcOffsetMinutes: 330,
    operator: { id: 'OFFICER-4417', displayName: 'A. Sharma', agency: 'State Police' },
    device: { id: 'device-001', publicKeyFingerprint: fingerprint, platform: 'Android 14' },
    location: {
      latitude: 12.9716,
      longitude: 77.5946,
      accuracyMetres: 8.5,
      altitudeMetres: 920,
      fixedAt: '2026-09-11T10:14:52.000Z',
    },
    panelId: 'marquis',
    panelName: 'Marquis',
    kitLotNumber: 'LOT-2291',
    caseReference: 'FIR-884/2026',
    /*
     * Deliberately an obsolete card version, and deliberately NOT updated to
     * drishti-card-3. A record's card version is data, not configuration: this
     * fixture is a record captured against a card revision that no longer exists,
     * and it must still canonicalise, hash and verify exactly as it did on the day
     * it was signed. Pointing it at the current constant would quietly delete the
     * only coverage of that guarantee.
     */
    cardSpecVersion: 'chromalog-card-1',
    cardSerial: 'CL-0001',
    calibrationProvenance: 'nominal',
    captureAccepted: true,
    result: {
      category: 'positive',
      outcomeId: 'marquis-purple',
      label: 'Purple to violet, consistent with opiates',
      confidence: 'moderate',
      matchDeltaE: 1.82,
      separationDeltaE: 15.4,
      referenceProvenance: 'placeholder',
      referenceNeedsVerification: true,
      requiresLaboratoryConfirmation: true,
    },
    measurement: {
      sampleLab: { L: 27.4, a: 30.1, b: -27.2 },
      correctionModel: 'affine3x4',
      correctionMeanDeltaE: 0.2,
      correctionMaxDeltaE: 0.84,
      focusScore: 230.4,
      cardCoverage: 0.427,
      illuminationGradientStrength: null,
      colourCastRatio: 1.0,
    },
    qualityIssues: [{ code: 'calibration-not-measured', severity: 'warn' }],
    image: {
      sha256: await sha256Hex(imageBytes),
      byteLength: imageBytes.length,
      mimeType: 'image/jpeg',
      width: 1400,
      height: 950,
    },
    chain: { index: 0, previousRecordHash: GENESIS_HASH },
    ...overrides,
  };
}

/** Deep clone so a test mutation cannot leak into another test. */
function clone(record: SignedTestRecord): SignedTestRecord {
  return JSON.parse(JSON.stringify(record)) as SignedTestRecord;
}

/**
 * Rebuilds an object graph with every object's keys in reverse insertion order.
 *
 * Note this cannot be done with JSON.stringify's array replacer: that argument is
 * a key allowlist applied recursively, so it silently drops nested properties
 * rather than reordering them.
 */
function reverseKeyOrder<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => reverseKeyOrder(item)) as unknown as T;
  }
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).reverse()) {
      out[key] = reverseKeyOrder(source[key]);
    }
    return out as T;
  }
  return value;
}

describe('signRecord and verifyRecord', () => {
  it('verifies a record it just signed', async () => {
    const signed = await signRecord({
      core: await makeCore(),
      privateKey: keys.privateKey,
      publicKey: keys.publicKey,
    });

    const result = await verifyRecord(signed);
    expect(result.valid).toBe(true);
    expect(result.failures).toEqual([]);
    expect(result.signedByFingerprint).toBe(fingerprint);
  });

  it('records the hash of exactly what was signed', async () => {
    const core = await makeCore();
    const signed = await signRecord({
      core,
      privateKey: keys.privateKey,
      publicKey: keys.publicKey,
    });
    expect(signed.signature.coreHash).toBe(await coreHash(core));
    expect(signed.signature.algorithm).toBe('ECDSA-P256-SHA256');
  });

  it('does not leak private key material into the record', async () => {
    const signed = await signRecord({
      core: await makeCore(),
      privateKey: keys.privateKey,
      publicKey: keys.publicKey,
    });
    expect(signed.signature.publicKeyJwk.d).toBeUndefined();
    expect(JSON.stringify(signed)).not.toContain('"d":');
  });

  it('is unaffected by property order in the stored JSON', async () => {
    // Records go through IndexedDB and JSON export, which need not preserve key
    // order. Verification must survive that, and this is the property that
    // canonical serialisation exists to guarantee.
    const signed = await signRecord({
      core: await makeCore(),
      privateKey: keys.privateKey,
      publicKey: keys.publicKey,
    });

    const reordered = reverseKeyOrder(signed);

    // Sanity-check the helper actually changed insertion order without losing data.
    expect(Object.keys(reordered)).not.toEqual(Object.keys(signed));
    expect(Object.keys(reordered).sort()).toEqual(Object.keys(signed).sort());

    expect((await verifyRecord(reordered)).valid).toBe(true);
  });
});

describe('tamper detection', () => {
  let signed: SignedTestRecord;

  beforeAll(async () => {
    signed = await signRecord({
      core: await makeCore(),
      privateKey: keys.privateKey,
      publicKey: keys.publicKey,
    });
  });

  it('detects a changed result category', async () => {
    const tampered = clone(signed);
    tampered.result.category = 'negative';
    const result = await verifyRecord(tampered);
    expect(result.valid).toBe(false);
    expect(result.failures).toContain('core-hash-mismatch');
    expect(result.failures).toContain('bad-signature');
  });

  it('detects a moved GPS coordinate', async () => {
    const tampered = clone(signed);
    tampered.location!.latitude = 19.076;
    const result = await verifyRecord(tampered);
    expect(result.valid).toBe(false);
    expect(result.failures).toContain('bad-signature');
  });

  it('detects an altered timestamp', async () => {
    const tampered = clone(signed);
    tampered.capturedAt = '2026-09-10T10:15:00.000Z';
    expect((await verifyRecord(tampered)).valid).toBe(false);
  });

  it('detects a swapped operator', async () => {
    const tampered = clone(signed);
    tampered.operator.id = 'OFFICER-9999';
    expect((await verifyRecord(tampered)).valid).toBe(false);
  });

  it('detects a removed optional field', async () => {
    const tampered = clone(signed);
    delete tampered.caseReference;
    expect((await verifyRecord(tampered)).valid).toBe(false);
  });

  it('detects an added field', async () => {
    const tampered = clone(signed) as SignedTestRecord & { extra?: string };
    tampered.extra = 'injected';
    expect((await verifyRecord(tampered)).valid).toBe(false);
  });

  it('still fails when the attacker also updates the stored core hash', async () => {
    // Recomputing coreHash to match an edit defeats the hash comparison but not
    // the signature, which is the point of signing rather than just hashing.
    const tampered = clone(signed);
    tampered.result.category = 'negative';
    const { signature, ...core } = tampered;
    tampered.signature.coreHash = await sha256Hex(
      new TextEncoder().encode(canonicalise(pruneUndefined(core as unknown as JsonValue))),
    );
    void signature;

    const result = await verifyRecord(tampered);
    expect(result.valid).toBe(false);
    expect(result.failures).not.toContain('core-hash-mismatch');
    expect(result.failures).toContain('bad-signature');
  });

  it('rejects a record re-signed with a different key', async () => {
    // An attacker can always produce a validly self-signed record; what they
    // cannot do is produce one bearing the original device's fingerprint.
    const forged = await signRecord({
      core: { ...(await makeCore()), result: { ...(await makeCore()).result, category: 'negative' } },
      privateKey: otherKeys.privateKey,
      publicKey: otherKeys.publicKey,
    });

    const result = await verifyRecord(forged);
    // Internally consistent...
    expect(result.valid).toBe(true);
    // ...but attributable to a different key, which is what an auditor checks.
    expect(result.signedByFingerprint).not.toBe(fingerprint);
    expect(forged.device.publicKeyFingerprint).toBe(fingerprint);
    expect(result.signedByFingerprint).not.toBe(forged.device.publicKeyFingerprint);
  });

  it('detects a substituted image', async () => {
    const differentImage = new Uint8Array([1, 1, 1, 1]);
    const result = await verifyRecord(signed, { imageBytes: differentImage });
    expect(result.valid).toBe(false);
    expect(result.failures).toContain('image-hash-mismatch');
  });

  it('accepts the original image', async () => {
    const result = await verifyRecord(signed, { imageBytes });
    expect(result.valid).toBe(true);
  });

  it('rejects an unknown signature algorithm', async () => {
    const tampered = clone(signed);
    (tampered.signature as { algorithm: string }).algorithm = 'MD5-something';
    const result = await verifyRecord(tampered);
    expect(result.valid).toBe(false);
    expect(result.failures).toEqual(['unsupported-algorithm']);
  });

  it('rejects a malformed public key without throwing', async () => {
    const tampered = clone(signed);
    tampered.signature.publicKeyJwk = { kty: 'EC', crv: 'P-256', x: 'nope', y: 'nope' };
    const result = await verifyRecord(tampered);
    expect(result.valid).toBe(false);
    expect(result.failures.length).toBeGreaterThan(0);
  });

  it('reports every failure found rather than stopping at the first', async () => {
    const tampered = clone(signed);
    tampered.result.category = 'negative';
    const result = await verifyRecord(tampered, { imageBytes: new Uint8Array([7]) });
    expect(result.failures.length).toBeGreaterThanOrEqual(3);
    expect(result.failures).toContain('core-hash-mismatch');
    expect(result.failures).toContain('bad-signature');
    expect(result.failures).toContain('image-hash-mismatch');
  });
});

describe('hash chain', () => {
  async function buildChain(length: number): Promise<SignedTestRecord[]> {
    const records: SignedTestRecord[] = [];
    let previousHash = GENESIS_HASH;

    for (let index = 0; index < length; index++) {
      const core = await makeCore({
        recordId: `record-${index}`,
        capturedAt: new Date(Date.UTC(2026, 8, 11, 10, index)).toISOString(),
        chain: { index, previousRecordHash: previousHash },
      });
      const signed = await signRecord({
        core,
        privateKey: keys.privateKey,
        publicKey: keys.publicKey,
      });
      records.push(signed);
      previousHash = await recordHash(signed);
    }

    return records;
  }

  it('verifies an intact chain', async () => {
    const chain = await buildChain(4);
    const result = await verifyChain(chain);
    expect(result.valid).toBe(true);
    expect(result.firstInvalidIndex).toBe(-1);
  });

  it('requires the first record to point at the genesis hash', async () => {
    const chain = await buildChain(2);
    expect(chain[0].chain.previousRecordHash).toBe(GENESIS_HASH);
  });

  it('detects a deleted middle record', async () => {
    // The property a per-record signature alone cannot give: every record here is
    // individually valid, yet the log has been altered.
    const chain = await buildChain(4);
    const withHole = [chain[0], chain[1], chain[3]];

    for (const record of withHole) {
      expect((await verifyRecord(record)).valid).toBe(true);
    }

    const result = await verifyChain(withHole);
    expect(result.valid).toBe(false);
    expect(result.firstInvalidIndex).toBe(2);
    expect(result.perRecord[2].failures).toContain('chain-broken');
  });

  it('detects reordered records', async () => {
    const chain = await buildChain(3);
    const swapped = [chain[0], chain[2], chain[1]];
    const result = await verifyChain(swapped);
    expect(result.valid).toBe(false);
  });

  it('detects an edit to a record in the middle of the chain', async () => {
    const chain = await buildChain(4);
    chain[1].result.category = 'negative';
    const result = await verifyChain(chain);
    expect(result.valid).toBe(false);
    // The edited record fails on its own signature...
    expect(result.perRecord[1].failures).toContain('bad-signature');
    // ...and its successor's link no longer matches, so the damage is localised.
    expect(result.perRecord[2].failures).toContain('chain-broken');
  });

  it('detects a record appended with the wrong index', async () => {
    const chain = await buildChain(2);
    const bad = await signRecord({
      core: await makeCore({
        recordId: 'record-bad',
        chain: { index: 7, previousRecordHash: await recordHash(chain[1]) },
      }),
      privateKey: keys.privateKey,
      publicKey: keys.publicKey,
    });
    const result = await verifyChain([...chain, bad]);
    expect(result.valid).toBe(false);
    expect(result.perRecord[2].failures).toContain('chain-index-mismatch');
  });

  it('verifies a single-record chain', async () => {
    const chain = await buildChain(1);
    expect((await verifyChain(chain)).valid).toBe(true);
  });

  it('treats an empty chain as valid', async () => {
    const result = await verifyChain([]);
    expect(result.valid).toBe(true);
    expect(result.perRecord).toEqual([]);
  });

  it('gives every record a distinct hash', async () => {
    const chain = await buildChain(4);
    const hashes = await Promise.all(chain.map(recordHash));
    expect(new Set(hashes).size).toBe(hashes.length);
  });
});

describe('rejected captures', () => {
  it('signs and verifies a record for a capture that was refused', async () => {
    // Recording refused attempts is what distinguishes "no test was done" from
    // "a test was done and could not be read".
    const core = await makeCore({
      captureAccepted: false,
      rejectionReason: 'The card is not sharp. Hold steadier and let the camera focus.',
      result: {
        category: 'inconclusive',
        outcomeId: null,
        label: 'Inconclusive, capture rejected',
        confidence: 'low',
        matchDeltaE: null,
        separationDeltaE: null,
        inconclusiveReason: 'capture-rejected',
        referenceProvenance: 'placeholder',
        referenceNeedsVerification: true,
        requiresLaboratoryConfirmation: true,
      },
      measurement: {
        sampleLab: null,
        correctionModel: null,
        correctionMeanDeltaE: null,
        correctionMaxDeltaE: null,
        focusScore: 2.5,
        cardCoverage: 0.42,
        illuminationGradientStrength: null,
        colourCastRatio: null,
      },
      qualityIssues: [{ code: 'out-of-focus', severity: 'reject' }],
    });

    const signed = await signRecord({
      core,
      privateKey: keys.privateKey,
      publicKey: keys.publicKey,
    });

    const result = await verifyRecord(signed);
    expect(result.valid).toBe(true);
    expect(signed.captureAccepted).toBe(false);
    expect(signed.result.matchDeltaE).toBeNull();
  });

  it('signs a record with no location and a stated reason', async () => {
    const core = await makeCore({
      location: null,
      locationUnavailableReason: 'Location permission denied by operator',
    });
    const signed = await signRecord({
      core,
      privateKey: keys.privateKey,
      publicKey: keys.publicKey,
    });
    expect((await verifyRecord(signed)).valid).toBe(true);
    expect(signed.location).toBeNull();
    expect(signed.locationUnavailableReason).toBeTruthy();
  });
});
