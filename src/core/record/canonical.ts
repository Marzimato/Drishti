/**
 * Deterministic JSON serialisation.
 *
 * A signature is only meaningful if the exact bytes that were signed can be
 * reproduced later. `JSON.stringify` is not good enough for that: object key
 * order follows insertion order, so two structurally identical records built by
 * different code paths serialise differently and one of them fails verification
 * for no substantive reason.
 *
 * This module fixes a canonical form:
 *
 *   - Object keys are sorted by UTF-16 code unit order.
 *   - Properties whose value is `undefined` are omitted entirely, so an absent
 *     field and a field explicitly set to undefined are indistinguishable.
 *   - Arrays keep their order, which is semantically meaningful.
 *   - No insignificant whitespace.
 *
 * Non-finite numbers throw rather than serialise. `JSON.stringify` silently turns
 * NaN and Infinity into `null`, which would mean a record could be signed with a
 * measurement value that had been quietly replaced by null — the kind of data
 * corruption that is invisible until someone relies on it in a hearing.
 */

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue | undefined };

export function canonicalise(value: JsonValue | undefined, path = '$'): string {
  if (value === undefined) {
    throw new Error(`Cannot canonicalise undefined at ${path}`);
  }
  if (value === null) return 'null';

  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';

    case 'number':
      if (!Number.isFinite(value)) {
        throw new Error(
          `Cannot canonicalise non-finite number (${value}) at ${path}. ` +
            'Replace it with null and record the reason explicitly.',
        );
      }
      // Normalise negative zero so that 0 and -0 cannot produce different bytes.
      return JSON.stringify(value === 0 ? 0 : value);

    case 'string':
      return JSON.stringify(value);

    case 'object':
      break;

    default:
      throw new Error(`Cannot canonicalise ${typeof value} at ${path}`);
  }

  if (Array.isArray(value)) {
    const items = value.map((item, index) => canonicalise(item, `${path}[${index}]`));
    return `[${items.join(',')}]`;
  }

  const record = value as { [key: string]: JsonValue | undefined };
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort();

  const entries = keys.map(
    (key) => `${JSON.stringify(key)}:${canonicalise(record[key], `${path}.${key}`)}`,
  );
  return `{${entries.join(',')}}`;
}

/** UTF-8 bytes of the canonical form, which is what actually gets hashed. */
export function canonicalBytes(value: JsonValue): Uint8Array {
  return new TextEncoder().encode(canonicalise(value));
}

/**
 * Strips undefined-valued properties recursively.
 *
 * Useful when building a record from optional fields: it lets callers assign
 * `undefined` freely and still produce a value that round-trips through
 * JSON.parse identically to what was canonicalised.
 */
export function pruneUndefined<T extends JsonValue>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return value.map((item) => pruneUndefined(item as JsonValue)) as T;
  }
  const out: Record<string, JsonValue> = {};
  for (const [key, item] of Object.entries(value as Record<string, JsonValue | undefined>)) {
    if (item === undefined) continue;
    out[key] = pruneUndefined(item);
  }
  return out as T;
}
