import { describe, expect, it } from 'vitest';
import { canonicalBytes, canonicalise, pruneUndefined, type JsonValue } from './canonical';

describe('canonicalise', () => {
  it('produces identical output regardless of key insertion order', () => {
    // The property the whole signing scheme rests on: two structurally identical
    // records must serialise to the same bytes.
    const a = { zebra: 1, apple: 2, mango: { z: 1, a: 2 } };
    const b = { mango: { a: 2, z: 1 }, apple: 2, zebra: 1 };
    expect(canonicalise(a)).toBe(canonicalise(b));
    expect(canonicalise(a)).toBe('{"apple":2,"mango":{"a":2,"z":1},"zebra":1}');
  });

  it('differs from JSON.stringify, which is order dependent', () => {
    const a = { b: 1, a: 2 };
    const b = { a: 2, b: 1 };
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
    expect(canonicalise(a)).toBe(canonicalise(b));
  });

  it('omits properties whose value is undefined', () => {
    expect(canonicalise({ a: 1, b: undefined })).toBe('{"a":1}');
    expect(canonicalise({ a: 1 })).toBe(canonicalise({ a: 1, b: undefined }));
  });

  it('preserves array order, which is meaningful', () => {
    expect(canonicalise([3, 1, 2])).toBe('[3,1,2]');
    expect(canonicalise([1, 2, 3])).not.toBe(canonicalise([3, 2, 1]));
  });

  it('handles nesting and mixed types', () => {
    const value = {
      list: [1, 'two', true, null, { inner: 'x' }],
      flag: false,
      nothing: null,
    };
    expect(canonicalise(value)).toBe(
      '{"flag":false,"list":[1,"two",true,null,{"inner":"x"}],"nothing":null}',
    );
  });

  it('throws on non-finite numbers instead of silently writing null', () => {
    // JSON.stringify turns these into null, which would let a record be signed
    // with a measurement quietly replaced by null.
    expect(JSON.stringify({ x: Number.NaN })).toBe('{"x":null}');
    expect(() => canonicalise({ x: Number.NaN })).toThrow(/non-finite/);
    expect(() => canonicalise({ x: Number.POSITIVE_INFINITY })).toThrow(/non-finite/);
    expect(() => canonicalise({ x: Number.NEGATIVE_INFINITY })).toThrow(/non-finite/);
  });

  it('names the offending path so the problem is findable', () => {
    expect(() => canonicalise({ a: { b: [1, Number.NaN] } })).toThrow(/\$\.a\.b\[1\]/);
  });

  it('normalises negative zero', () => {
    expect(canonicalise({ x: -0 })).toBe(canonicalise({ x: 0 }));
  });

  it('throws when asked to canonicalise a bare undefined', () => {
    expect(() => canonicalise(undefined)).toThrow(/undefined/);
  });

  it('escapes strings deterministically, including unicode', () => {
    const value = { text: 'line\nbreak "quoted" \u00e9\u0001' };
    const once = canonicalise(value);
    const twice = canonicalise(JSON.parse(once));
    expect(twice).toBe(once);
  });

  it('round-trips through JSON.parse unchanged', () => {
    const value = { b: [1, 2, { c: 'x' }], a: null, d: 1.5 };
    expect(canonicalise(JSON.parse(canonicalise(value)))).toBe(canonicalise(value));
  });

  it('sorts by code unit order, not locale order', () => {
    // Locale-aware sorting would vary by device, breaking verification.
    const result = canonicalise({ b: 1, A: 2, a: 3, B: 4 });
    expect(result).toBe('{"A":2,"B":4,"a":3,"b":1}');
  });
});

describe('canonicalBytes', () => {
  it('encodes as UTF-8', () => {
    const bytes = canonicalBytes({ k: 'é' });
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(new TextDecoder().decode(bytes)).toBe('{"k":"é"}');
  });

  it('is stable across calls', () => {
    const value = { z: 1, a: [1, 2] };
    expect(Array.from(canonicalBytes(value))).toEqual(Array.from(canonicalBytes(value)));
  });
});

describe('pruneUndefined', () => {
  it('removes undefined properties recursively', () => {
    const value: JsonValue = { a: 1, b: undefined, c: { d: undefined, e: 2 } };
    expect(pruneUndefined(value)).toEqual({ a: 1, c: { e: 2 } });
  });

  it('leaves arrays and primitives alone', () => {
    expect(pruneUndefined([1, 2, 3])).toEqual([1, 2, 3]);
    expect(pruneUndefined(null)).toBeNull();
    expect(pruneUndefined(5)).toBe(5);
  });

  it('produces a value that canonicalises identically to the original', () => {
    const value: JsonValue = { a: 1, b: undefined, c: { d: undefined, e: 2 } };
    expect(canonicalise(pruneUndefined(value))).toBe(canonicalise(value));
  });
});
