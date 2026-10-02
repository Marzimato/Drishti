/**
 * Hashing, encoding and signing primitives.
 *
 * Built on WebCrypto, which is available both in browsers and in Node 18+, so the
 * same code path is exercised by the tests and by the app. No third-party crypto
 * dependency: for SHA-256 and ECDSA there is nothing to gain from one, and a
 * supply-chain risk in accepting one.
 *
 * ALGORITHM CHOICE: ECDSA over P-256 with SHA-256, rather than Ed25519.
 * Ed25519 is the better modern choice on the merits — smaller, faster, and free of
 * the nonce-reuse hazard that has broken many ECDSA implementations. It is not
 * used here because WebCrypto support for it is still uneven across the mobile
 * browsers this app has to run on, and a signing scheme that silently fails to
 * initialise on an officer's phone is worse than a slightly older one that works
 * everywhere. P-256 is universally supported and the private key is generated
 * non-extractable, so the nonce handling stays inside the platform implementation.
 */

const SIGNING_ALGORITHM = 'ECDSA-P256-SHA256' as const;
export type SigningAlgorithm = typeof SIGNING_ALGORITHM;
export const SIGNATURE_ALGORITHM: SigningAlgorithm = SIGNING_ALGORITHM;

const EC_PARAMS: EcKeyGenParams = { name: 'ECDSA', namedCurve: 'P-256' };
const SIGN_PARAMS: EcdsaParams = { name: 'ECDSA', hash: 'SHA-256' };

function subtle(): SubtleCrypto {
  const cryptoObject = globalThis.crypto;
  if (!cryptoObject?.subtle) {
    throw new Error(
      'WebCrypto is unavailable. A secure context (HTTPS or localhost) is required for signing.',
    );
  }
  return cryptoObject.subtle;
}

/* ------------------------------------------------------------------ encoding */

export function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

export function fromHex(hex: string): Uint8Array {
  const cleaned = hex.trim().toLowerCase();
  if (cleaned.length % 2 !== 0 || /[^0-9a-f]/.test(cleaned)) {
    throw new Error('Invalid hex string');
  }
  const out = new Uint8Array(cleaned.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(cleaned.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** Base64url without padding, per RFC 4648 section 5. */
export function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const base64 =
    typeof btoa === 'function' ? btoa(binary) : Buffer.from(bytes).toString('base64');
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(value: string): Uint8Array {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  if (typeof atob === 'function') {
    const binary = atob(padded);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  }
  return new Uint8Array(Buffer.from(padded, 'base64'));
}

/* -------------------------------------------------------------------- hashing */

export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  // Copy into a fresh buffer so a Uint8Array view over a larger ArrayBuffer
  // cannot hash the wrong bytes.
  const digest = await subtle().digest('SHA-256', data.slice().buffer);
  return new Uint8Array(digest);
}

export async function sha256Hex(data: Uint8Array): Promise<string> {
  return toHex(await sha256(data));
}

export async function sha256HexOfText(text: string): Promise<string> {
  return sha256Hex(new TextEncoder().encode(text));
}

/** All-zero digest, used as the previous-hash of the first record in a chain. */
export const GENESIS_HASH = '0'.repeat(64);

/* ----------------------------------------------------------------- key material */

export interface DeviceKeyPair {
  privateKey: CryptoKey;
  publicKey: CryptoKey;
}

/**
 * Generates a signing key pair for this device.
 *
 * The private key is created non-extractable, so it cannot be read out of the
 * browser even by this application's own code. That is the strongest guarantee
 * available to a web app: it means a copied IndexedDB file does not yield a
 * working signing key.
 */
export async function generateDeviceKeyPair(): Promise<DeviceKeyPair> {
  const pair = (await subtle().generateKey(EC_PARAMS, false, ['sign', 'verify'])) as CryptoKeyPair;
  return { privateKey: pair.privateKey, publicKey: pair.publicKey };
}

/**
 * Generates an extractable key pair.
 *
 * Only for tests and for the "export a demo key" path. Production signing keys
 * should always be non-extractable.
 */
export async function generateExtractableKeyPair(): Promise<DeviceKeyPair> {
  const pair = (await subtle().generateKey(EC_PARAMS, true, ['sign', 'verify'])) as CryptoKeyPair;
  return { privateKey: pair.privateKey, publicKey: pair.publicKey };
}

export async function exportPublicKeyJwk(publicKey: CryptoKey): Promise<JsonWebKey> {
  const jwk = (await subtle().exportKey('jwk', publicKey)) as JsonWebKey;
  // Strip fields that carry no key material but would otherwise vary between
  // platforms and change the canonical bytes.
  delete jwk.key_ops;
  delete jwk.ext;
  return jwk;
}

export async function importPublicKeyJwk(jwk: JsonWebKey): Promise<CryptoKey> {
  return subtle().importKey('jwk', jwk, EC_PARAMS, true, ['verify']);
}

/**
 * Short, stable identifier for a public key.
 *
 * SHA-256 over the canonical JWK coordinates, truncated for display. Lets an
 * auditor confirm at a glance that a batch of records came from the same device
 * key without comparing full keys by eye.
 */
export async function publicKeyFingerprint(publicKey: CryptoKey): Promise<string> {
  const jwk = await exportPublicKeyJwk(publicKey);
  const material = `${jwk.crv ?? ''}.${jwk.x ?? ''}.${jwk.y ?? ''}`;
  const digest = await sha256HexOfText(material);
  return digest.slice(0, 32);
}

/* -------------------------------------------------------------------- signing */

export async function signBytes(privateKey: CryptoKey, data: Uint8Array): Promise<string> {
  const signature = await subtle().sign(SIGN_PARAMS, privateKey, data.slice().buffer);
  return toBase64Url(new Uint8Array(signature));
}

export async function verifyBytes(
  publicKey: CryptoKey,
  signatureBase64Url: string,
  data: Uint8Array,
): Promise<boolean> {
  let signature: Uint8Array;
  try {
    signature = fromBase64Url(signatureBase64Url);
  } catch {
    return false;
  }
  try {
    return await subtle().verify(
      SIGN_PARAMS,
      publicKey,
      signature.slice().buffer,
      data.slice().buffer,
    );
  } catch {
    // A malformed signature makes verify throw on some platforms; that is a
    // verification failure, not an application error.
    return false;
  }
}

/** RFC 4122 version 4 identifier, used for record ids. */
export function randomId(): string {
  const cryptoObject = globalThis.crypto as Crypto | undefined;
  if (!cryptoObject) {
    throw new Error('No crypto source available for generating identifiers.');
  }
  // Feature-tested rather than assumed: randomUUID needs a secure context and is
  // absent on some older mobile browsers.
  if (typeof cryptoObject.randomUUID === 'function') {
    return cryptoObject.randomUUID();
  }
  const bytes = new Uint8Array(16);
  cryptoObject.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = toHex(bytes);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
