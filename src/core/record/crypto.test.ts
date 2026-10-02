import { describe, expect, it } from 'vitest';
import {
  GENESIS_HASH,
  exportPublicKeyJwk,
  fromBase64Url,
  fromHex,
  generateExtractableKeyPair,
  importPublicKeyJwk,
  publicKeyFingerprint,
  randomId,
  sha256Hex,
  sha256HexOfText,
  signBytes,
  toBase64Url,
  toHex,
  verifyBytes,
} from './crypto';

const encoder = new TextEncoder();

describe('sha256', () => {
  it('matches the published digest for the empty input', () => {
    // NIST test vector; if this fails the hashing path is wrong.
    return expect(sha256Hex(new Uint8Array(0))).resolves.toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('matches the published digest for "abc"', () => {
    return expect(sha256HexOfText('abc')).resolves.toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('is sensitive to a single bit change', async () => {
    const a = await sha256HexOfText('report');
    const b = await sha256HexOfText('reporu');
    expect(a).not.toBe(b);
  });

  it('produces 64 hex characters', async () => {
    expect(await sha256HexOfText('anything')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('hashes a view into a larger buffer correctly', async () => {
    // Guards the .slice() in sha256: a Uint8Array view over a bigger ArrayBuffer
    // must hash only its own bytes.
    const backing = new Uint8Array([9, 9, 97, 98, 99, 9, 9]);
    const view = backing.subarray(2, 5);
    expect(await sha256Hex(view)).toBe(await sha256HexOfText('abc'));
  });
});

describe('GENESIS_HASH', () => {
  it('is 64 zeroes so the first record has a well-defined predecessor', () => {
    expect(GENESIS_HASH).toBe('0'.repeat(64));
  });
});

describe('hex encoding', () => {
  it('round-trips', () => {
    const bytes = new Uint8Array([0, 1, 15, 16, 127, 128, 254, 255]);
    expect(Array.from(fromHex(toHex(bytes)))).toEqual(Array.from(bytes));
  });

  it('pads single digits', () => {
    expect(toHex(new Uint8Array([0, 5]))).toBe('0005');
  });

  it('rejects malformed input', () => {
    expect(() => fromHex('abc')).toThrow();
    expect(() => fromHex('zz')).toThrow();
  });
});

describe('base64url encoding', () => {
  it('round-trips arbitrary bytes', () => {
    const bytes = new Uint8Array(256);
    for (let i = 0; i < 256; i++) bytes[i] = i;
    expect(Array.from(fromBase64Url(toBase64Url(bytes)))).toEqual(Array.from(bytes));
  });

  it('omits padding and uses url-safe characters', () => {
    const encoded = toBase64Url(new Uint8Array([251, 255, 190]));
    expect(encoded).not.toContain('=');
    expect(encoded).not.toContain('+');
    expect(encoded).not.toContain('/');
  });

  it('handles every input length modulo 3', () => {
    for (const length of [1, 2, 3, 4, 5]) {
      const bytes = new Uint8Array(length).fill(200);
      expect(Array.from(fromBase64Url(toBase64Url(bytes)))).toEqual(Array.from(bytes));
    }
  });
});

describe('signing', () => {
  it('verifies a signature it produced', async () => {
    const keys = await generateExtractableKeyPair();
    const data = encoder.encode('field test record');
    const signature = await signBytes(keys.privateKey, data);
    expect(await verifyBytes(keys.publicKey, signature, data)).toBe(true);
  });

  it('rejects a signature over different data', async () => {
    const keys = await generateExtractableKeyPair();
    const signature = await signBytes(keys.privateKey, encoder.encode('original'));
    expect(await verifyBytes(keys.publicKey, signature, encoder.encode('altered'))).toBe(false);
  });

  it('rejects a signature from a different key', async () => {
    const signer = await generateExtractableKeyPair();
    const impostor = await generateExtractableKeyPair();
    const data = encoder.encode('record');
    const signature = await signBytes(signer.privateKey, data);
    expect(await verifyBytes(impostor.publicKey, signature, data)).toBe(false);
  });

  it('returns false rather than throwing on a malformed signature', async () => {
    const keys = await generateExtractableKeyPair();
    const data = encoder.encode('record');
    expect(await verifyBytes(keys.publicKey, 'not-a-signature', data)).toBe(false);
    expect(await verifyBytes(keys.publicKey, '', data)).toBe(false);
  });

  it('produces a different signature each time but all verify', async () => {
    // ECDSA is randomised, so identical input yields different signatures. A
    // verifier must not assume signature bytes are reproducible.
    const keys = await generateExtractableKeyPair();
    const data = encoder.encode('same input');
    const first = await signBytes(keys.privateKey, data);
    const second = await signBytes(keys.privateKey, data);
    expect(first).not.toBe(second);
    expect(await verifyBytes(keys.publicKey, first, data)).toBe(true);
    expect(await verifyBytes(keys.publicKey, second, data)).toBe(true);
  });
});

describe('public key handling', () => {
  it('exports and re-imports a usable verification key', async () => {
    const keys = await generateExtractableKeyPair();
    const data = encoder.encode('payload');
    const signature = await signBytes(keys.privateKey, data);

    const jwk = await exportPublicKeyJwk(keys.publicKey);
    const reimported = await importPublicKeyJwk(jwk);
    expect(await verifyBytes(reimported, signature, data)).toBe(true);
  });

  it('exports a P-256 key without platform-varying fields', async () => {
    const keys = await generateExtractableKeyPair();
    const jwk = await exportPublicKeyJwk(keys.publicKey);
    expect(jwk.kty).toBe('EC');
    expect(jwk.crv).toBe('P-256');
    expect(jwk.x).toBeTruthy();
    expect(jwk.y).toBeTruthy();
    expect(jwk.d).toBeUndefined();
    // These vary between platforms and would change the canonical bytes.
    expect(jwk.key_ops).toBeUndefined();
    expect(jwk.ext).toBeUndefined();
  });

  it('gives a stable fingerprint for the same key and different for others', async () => {
    const keys = await generateExtractableKeyPair();
    const other = await generateExtractableKeyPair();
    const first = await publicKeyFingerprint(keys.publicKey);
    const again = await publicKeyFingerprint(keys.publicKey);
    expect(first).toBe(again);
    expect(first).toMatch(/^[0-9a-f]{32}$/);
    expect(await publicKeyFingerprint(other.publicKey)).not.toBe(first);
  });
});

describe('randomId', () => {
  it('produces distinct uuid-shaped identifiers', () => {
    const ids = new Set(Array.from({ length: 200 }, () => randomId()));
    expect(ids.size).toBe(200);
    for (const id of ids) {
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    }
  });
});
