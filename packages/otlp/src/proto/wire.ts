import { OtlpDecodeError } from "../errors.js";

/**
 * Protobuf wire-format scanner (ADR-0006 section 3, G0 finding F13). It reads the fields of ONE
 * message level and never recurses: nested messages are LEN fields whose payload range is
 * recorded and scanned later by the caller, so the scanner has no depth of its own.
 *
 * Every malformation is a whole-request `invalid-structure`: a truncated or inconsistent frame
 * means the sender and the decoder disagree about where fields start, so nothing after it in the
 * same request is trusted. Budget exhaustion is `too-many-values`.
 */

/** Wire types the decoder understands. Groups (3, 4) and 6, 7 are rejected by the scanner. */
export type WireType = 0 | 1 | 2 | 5;

export interface Field {
  /** Field number, 1 .. 2^29-1. */
  readonly num: number;
  readonly wt: WireType;
  /** LEN: payload start. I64 / I32: start of the fixed-width bytes. VARINT: unused. */
  readonly a: number;
  /** LEN: payload end (exclusive). Otherwise equal to `a`. */
  readonly b: number;
  /**
   * VARINT / I64 / I32: the unsigned value as a number when it is below 2^53, else -1 with the
   * exact value in `big`. LEN: 0. (No BigInt is allocated for ordinary values.)
   */
  readonly n: number;
  readonly big: bigint | undefined;
}

/** The exact unsigned value of a VARINT / I64 / I32 field. */
export function bigOf(f: Field): bigint {
  return f.big ?? BigInt(f.n);
}

/** The per-request iteration budget: one unit per field scanned, shared by every message. */
export interface Budget {
  left: number;
}

export const MAX_FIELD_NUMBER = 0x1fff_ffff; // 2^29 - 1
const MAX_LEN = 0x8000_0000; // 2^31
const MAX_TAG = 0xffff_ffff;

export function malformed(): never {
  throw new OtlpDecodeError("invalid-structure");
}

// Results of the last `readVarint` call (module scratch: avoids one allocation per varint).
let nextPos = 0;
let bigValue: bigint | undefined;

/** Slow path: at most 10 bytes, at most 64 bits, exact BigInt value. */
function varintBig(buf: Uint8Array, pos: number, end: number): bigint {
  let result = 0n;
  let shift = 0n;
  let p = pos;
  for (let i = 0; i < 10; i++) {
    if (p >= end) return malformed();
    const b = buf[p++] as number;
    // The 10th byte may only carry bit 63 (b is 0 or 1); anything more overflows 64 bits, and a
    // set continuation bit there would be an 11th byte.
    if (i === 9 && b > 1) return malformed();
    result |= BigInt(b & 0x7f) << shift;
    if (b < 0x80) {
      nextPos = p;
      return result;
    }
    shift += 7n;
  }
  return malformed();
}

/**
 * One varint at `pos`: at most 10 bytes, at most 64 bits. Returns the value as a number when it
 * is below 2^53; otherwise returns -1 and leaves the exact value in `bigValue`. The position
 * after the varint is left in `nextPos`.
 */
function readVarint(buf: Uint8Array, pos: number, end: number): number {
  let n = 0;
  let mul = 1;
  for (let i = 0; i < 7; i++) {
    if (pos + i >= end) return malformed();
    const b = buf[pos + i] as number;
    n += (b & 0x7f) * mul;
    if (b < 0x80) {
      nextPos = pos + i + 1;
      bigValue = undefined;
      return n;
    }
    mul *= 128;
  }
  const v = varintBig(buf, pos, end);
  if (v <= 0x1f_ffff_ffff_ffffn) {
    bigValue = undefined;
    return Number(v);
  }
  bigValue = v;
  return -1;
}

function le32(buf: Uint8Array, p: number): number {
  return (
    ((buf[p] as number) |
      ((buf[p + 1] as number) << 8) |
      ((buf[p + 2] as number) << 16) |
      ((buf[p + 3] as number) << 24)) >>>
    0
  );
}

/**
 * Scan the fields of the message occupying `buf[start, end)`. Every field costs one budget
 * unit, unknown fields included, so the work done for a request is bounded by the budget
 * regardless of the declared sizes.
 */
export function scan(buf: Uint8Array, start: number, end: number, budget: Budget): Field[] {
  const out: Field[] = [];
  let pos = start;
  while (pos < end) {
    if (--budget.left < 0) throw new OtlpDecodeError("too-many-values");
    const tag = readVarint(buf, pos, end);
    pos = nextPos;
    // a tag above 2^32 - 1 means a field number above 2^29 - 1 (-1 marks a value >= 2^53)
    if (tag < 0 || tag > MAX_TAG) return malformed();
    const wt = tag % 8;
    const num = (tag - wt) / 8;
    if (num === 0 || num > MAX_FIELD_NUMBER) return malformed();
    switch (wt) {
      case 0: {
        const n = readVarint(buf, pos, end);
        pos = nextPos;
        out.push({ num, wt: 0, a: pos, b: pos, n, big: bigValue });
        break;
      }
      case 1: {
        if (end - pos < 8) return malformed();
        const lo = le32(buf, pos);
        const hi = le32(buf, pos + 4);
        if (hi < 0x20_0000)
          out.push({ num, wt: 1, a: pos, b: pos, n: hi * 4294967296 + lo, big: undefined });
        else out.push({ num, wt: 1, a: pos, b: pos, n: -1, big: (BigInt(hi) << 32n) | BigInt(lo) });
        pos += 8;
        break;
      }
      case 2: {
        // A length is compared as a number only after it is known to be exact (below 2^53;
        // a value at or above 2^53 comes back as -1) and bounded by 2^31 first.
        const len = readVarint(buf, pos, end);
        pos = nextPos;
        if (len < 0 || len > MAX_LEN) return malformed();
        if (len > end - pos) return malformed();
        out.push({ num, wt: 2, a: pos, b: pos + len, n: 0, big: undefined });
        pos += len;
        break;
      }
      case 5: {
        if (end - pos < 4) return malformed();
        out.push({ num, wt: 5, a: pos, b: pos, n: le32(buf, pos), big: undefined });
        pos += 4;
        break;
      }
      default:
        // 3 and 4 are the deprecated group wire types; 6 and 7 do not exist.
        return malformed();
    }
  }
  return out;
}

/** Singular fields by number: two small arrays instead of a Map (one per message scanned). */
export class Singles {
  private readonly keys: number[] = [];
  private readonly vals: Field[] = [];
  get size(): number {
    return this.keys.length;
  }
  get(num: number): Field | undefined {
    const i = this.keys.indexOf(num);
    return i < 0 ? undefined : this.vals[i];
  }
  has(num: number): boolean {
    return this.keys.includes(num);
  }
  first(): Field | undefined {
    return this.vals[0];
  }
  set(num: number, f: Field): void {
    this.keys.push(num);
    this.vals.push(f);
  }
}

export class Repeats {
  private readonly keys: number[] = [];
  private readonly vals: Field[][] = [];
  get(num: number): readonly Field[] | undefined {
    const i = this.keys.indexOf(num);
    return i < 0 ? undefined : this.vals[i];
  }
  add(num: number, f: Field): void {
    const i = this.keys.indexOf(num);
    if (i < 0) {
      this.keys.push(num);
      this.vals.push([f]);
    } else (this.vals[i] as Field[]).push(f);
  }
}

export interface Slots {
  readonly one: Singles;
  readonly rep: Repeats;
}

/**
 * Sort scanned fields into singular and repeated slots by field number. A second occurrence of
 * a singular field calls `onDuplicate` (which throws): proto3 would merge or take the last
 * value, but a record that says two different things is hostile or corrupt, and the JSON
 * decoder rejects duplicate keys too. Unknown numbers are ignored (OTLP requires that).
 */
export function split(
  fields: readonly Field[],
  one: readonly number[],
  rep: readonly number[],
  onDuplicate: () => never,
): Slots {
  const singles = new Singles();
  const repeats = new Repeats();
  for (const f of fields) {
    if (one.includes(f.num)) {
      if (singles.has(f.num)) return onDuplicate();
      singles.set(f.num, f);
    } else if (rep.includes(f.num)) repeats.add(f.num, f);
  }
  return { one: singles, rep: repeats };
}
