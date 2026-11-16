/**
 * Byte-level JSON scanner (SPEC-002 section 3.2, M-8). Pure. It validates one JSON value in
 * `bytes[start, end)` against RFC 8259 structure, counts container depth outside strings,
 * detects duplicate object keys (compared as raw bytes; decoded only when they contain a
 * backslash), and records the spans of the elements of declared record arrays. It never
 * recurses (explicit stack), so hostile nesting cannot overflow the call stack. `JSON.parse`
 * runs only after this scanner accepted the bytes.
 */

export interface ElementSpan {
  readonly start: number;
  readonly end: number;
  /** 1-based line on which the element starts. */
  readonly line: number;
}

export type ArrayStatus = "missing" | "array" | "not-array";

export type ScanResult =
  | {
      readonly ok: true;
      /** Byte offsets of keys that repeat an earlier key of the same object (capped). */
      readonly duplicateOffsets: readonly number[];
      /** Duplicates beyond the cap; not attributable to an offset. */
      readonly duplicateOverflow: number;
      /** Per target (declared order): element spans in document order. */
      readonly elements: readonly (readonly ElementSpan[])[];
      readonly status: readonly ArrayStatus[];
      /** Values (including keys) scanned. */
      readonly values: number;
    }
  | { readonly ok: false; readonly failure: "malformed" | "depth" | "too-large" };

/** Optional memory budgets for one scan. */
export interface ScanLimits {
  /** Maximum JSON values (containers, scalars and keys) before failing with `too-large`. */
  readonly maxValues: number;
  /** Maximum element spans retained per target array. */
  readonly maxSpans: number;
}

export const MAX_TRACKED_DUPLICATES = 65_536;

const decoder = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true });

interface Frame {
  readonly isObject: boolean;
  /** Targets whose path prefix matches this object (bit per target). */
  readonly mask: number;
  readonly keys: Set<string> | null;
  /** Targets whose full path matches the value of the current key. */
  exact: number;
  /** Targets whose path continues below the value of the current key. */
  next: number;
  /** For arrays: the record-array target this frame collects, or -1. */
  readonly target: number;
  elemStart: number;
  elemLine: number;
  /** True right after the opening bracket, until the first item starts. */
  fresh: boolean;
}

const WS = (c: number): boolean => c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d;
const HEX = (c: number): boolean =>
  (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x46) || (c >= 0x61 && c <= 0x66);

function binaryKey(b: Uint8Array, from: number, to: number): string {
  let s = "";
  for (let i = from; i < to; i++) s += String.fromCharCode(b[i] ?? 0);
  return s;
}

/** Normalized key identity: UTF-8 bytes as a binary string, so escaped and raw forms agree. */
function keyIdentity(b: Uint8Array, from: number, to: number, escaped: boolean): string {
  if (!escaped) return `b${binaryKey(b, from, to)}`;
  let decoded: string;
  try {
    const v: unknown = JSON.parse(decoder.decode(b.subarray(from - 1, to + 1)));
    decoded = typeof v === "string" ? v : "";
  } catch {
    decoded = "";
  }
  if (!decoded.isWellFormed()) return `s${decoded}`;
  const raw = new TextEncoder().encode(decoded);
  return `b${binaryKey(raw, 0, raw.length)}`;
}

function keyText(b: Uint8Array, from: number, to: number, escaped: boolean): string {
  if (!escaped) return decoder.decode(b.subarray(from, to));
  try {
    const v: unknown = JSON.parse(decoder.decode(b.subarray(from - 1, to + 1)));
    return typeof v === "string" ? v : "";
  } catch {
    return "";
  }
}

export function scanJson(
  b: Uint8Array,
  start: number,
  end: number,
  maxDepth: number,
  targets: readonly (readonly string[])[],
  startLine: number,
  limits?: ScanLimits,
): ScanResult {
  const maxValues = limits?.maxValues ?? Number.POSITIVE_INFINITY;
  const maxSpans = limits?.maxSpans ?? Number.POSITIVE_INFINITY;
  let values = 0;
  let keyBudgetHit = false;
  const MALFORMED = { ok: false, failure: "malformed" } as const;
  const DEPTH = { ok: false, failure: "depth" } as const;
  const TOO_LARGE = { ok: false, failure: "too-large" } as const;
  const stack: Frame[] = [];
  const duplicateOffsets: number[] = [];
  let duplicateOverflow = 0;
  const elements: ElementSpan[][] = targets.map(() => []);
  const status: ArrayStatus[] = targets.map(() => "missing");
  let line = startLine;
  let pos = start;
  const allMask = targets.length === 0 ? 0 : (1 << targets.length) - 1;

  const byte = (i: number): number => (i < end ? (b[i] ?? -1) : -1);
  const skipWs = (): void => {
    for (;;) {
      const c = byte(pos);
      if (c === 0x0a) line++;
      else if (!WS(c)) return;
      pos++;
    }
  };

  // Leading BOM is allowed (the record bytes keep it; framing reports it).
  if (byte(pos) === 0xef && byte(pos + 1) === 0xbb && byte(pos + 2) === 0xbf) pos += 3;
  skipWs();

  // Index after the closing quote, or -1; `stringEscaped` reports whether the string has escapes.
  let stringEscaped = false;
  const scanString = (from: number): number => {
    stringEscaped = false;
    let i = from + 1;
    for (;;) {
      const c = byte(i);
      if (c < 0x20) return -1; // control character, or end of input (-1)
      if (c === 0x22) return i + 1;
      if (c === 0x5c) {
        stringEscaped = true;
        const e = byte(i + 1);
        if (e === 0x75) {
          if (!(HEX(byte(i + 2)) && HEX(byte(i + 3)) && HEX(byte(i + 4)) && HEX(byte(i + 5)))) {
            return -1;
          }
          i += 6;
        } else if (
          e === 0x22 ||
          e === 0x5c ||
          e === 0x2f ||
          e === 0x62 ||
          e === 0x66 ||
          e === 0x6e ||
          e === 0x72 ||
          e === 0x74
        ) {
          i += 2;
        } else return -1;
      } else i++;
    }
  };

  const isDigit = (c: number): boolean => c >= 0x30 && c <= 0x39;
  const scanNumber = (from: number): number => {
    let i = from;
    if (byte(i) === 0x2d) i++;
    const c = byte(i);
    if (c === 0x30) i++;
    else if (c >= 0x31 && c <= 0x39) while (isDigit(byte(i))) i++;
    else return -1;
    if (byte(i) === 0x2e) {
      i++;
      if (!isDigit(byte(i))) return -1;
      while (isDigit(byte(i))) i++;
    }
    if (byte(i) === 0x65 || byte(i) === 0x45) {
      i++;
      if (byte(i) === 0x2b || byte(i) === 0x2d) i++;
      if (!isDigit(byte(i))) return -1;
      while (isDigit(byte(i))) i++;
    }
    return i;
  };

  const scanLiteral = (from: number, word: string): number => {
    for (let k = 0; k < word.length; k++) if (byte(from + k) !== word.charCodeAt(k)) return -1;
    return from + word.length;
  };

  const top = (): Frame | undefined => stack[stack.length - 1];

  type Outcome = "closed" | "opened" | "bad" | "depth" | "too-large";
  /** Called with `pos` at the first byte of a value. */
  const beginValue = (): Outcome => {
    if (++values > maxValues) return "too-large";
    const parent = top();
    if (parent !== undefined && !parent.isObject && parent.target >= 0) {
      parent.elemStart = pos;
      parent.elemLine = line;
    }
    const exact = parent?.isObject ? parent.exact : 0;
    const next = parent?.isObject ? parent.next : 0;
    const c = byte(pos);
    const markNotArray = (): void => {
      for (let t = 0; t < targets.length; t++) {
        if ((exact & (1 << t)) !== 0 && status[t] === "missing") status[t] = "not-array";
      }
    };
    if (c === 0x7b || c === 0x5b) {
      if (stack.length + 1 > maxDepth) return "depth";
      const isObject = c === 0x7b;
      let target = -1;
      if (!isObject && exact !== 0) {
        for (let t = 0; t < targets.length; t++) {
          if ((exact & (1 << t)) !== 0) {
            target = t;
            break;
          }
        }
        if (target >= 0) status[target] = "array";
      } else markNotArray();
      const mask = parent === undefined ? (isObject ? allMask : 0) : isObject ? next : 0;
      stack.push({
        isObject,
        mask,
        keys: isObject ? new Set() : null,
        exact: 0,
        next: 0,
        target,
        elemStart: 0,
        elemLine: 0,
        fresh: true,
      });
      pos++;
      return "opened";
    }
    markNotArray();
    let after = -1;
    if (c === 0x22) after = scanString(pos);
    else if (c === 0x2d || isDigit(c)) after = scanNumber(pos);
    else if (c === 0x74) after = scanLiteral(pos, "true");
    else if (c === 0x66) after = scanLiteral(pos, "false");
    else if (c === 0x6e) after = scanLiteral(pos, "null");
    if (after < 0) return "bad";
    pos = after;
    return "closed";
  };

  /** A value ended at `pos` (exclusive). Unwinds closed containers. Returns false if malformed. */
  const finishValue = (): boolean => {
    for (;;) {
      const f = top();
      if (f === undefined) return true;
      if (!f.isObject && f.target >= 0) {
        const list = elements[f.target];
        if (list !== undefined && list.length < maxSpans) {
          list.push({ start: f.elemStart, end: pos, line: f.elemLine });
        }
      }
      skipWs();
      const c = byte(pos);
      if (c === 0x2c) {
        pos++;
        skipWs();
        return true; // caller continues with the next key or element
      }
      if ((f.isObject && c === 0x7d) || (!f.isObject && c === 0x5d)) {
        pos++;
        stack.pop();
        continue; // the closed container is itself a value of its parent
      }
      return false;
    }
  };

  /** Parse a key at `pos`; leaves `pos` at the first byte of its value. */
  const readKey = (f: Frame): boolean => {
    if (byte(pos) !== 0x22) return false;
    const keyStart = pos;
    const after = scanString(pos);
    if (after < 0) return false;
    const from = keyStart + 1;
    const to = after - 1;
    const id = keyIdentity(b, from, to, stringEscaped);
    if (++values > maxValues) {
      keyBudgetHit = true;
      return false;
    }
    if (f.keys?.has(id)) {
      if (duplicateOffsets.length < MAX_TRACKED_DUPLICATES) duplicateOffsets.push(keyStart);
      else duplicateOverflow++;
    } else f.keys?.add(id);
    f.exact = 0;
    f.next = 0;
    if (f.mask !== 0) {
      const depth = stack.length - 1;
      const text = keyText(b, from, to, stringEscaped);
      for (let t = 0; t < targets.length; t++) {
        const seg = targets[t];
        if ((f.mask & (1 << t)) === 0 || seg === undefined || seg[depth] !== text) continue;
        if (seg.length === depth + 1) f.exact |= 1 << t;
        else f.next |= 1 << t;
      }
    }
    pos = after;
    skipWs();
    if (byte(pos) !== 0x3a) return false;
    pos++;
    skipWs();
    return true;
  };

  // Main loop: alternate between "need a key" and "need a value" at the top frame.
  for (;;) {
    const f = top();
    if (f?.fresh === true) {
      const c = byte(pos);
      if ((f.isObject && c === 0x7d) || (!f.isObject && c === 0x5d)) {
        pos++; // empty container
        stack.pop();
        if (!finishValue()) return MALFORMED;
        if (stack.length === 0) break;
        continue;
      }
      f.fresh = false;
    }
    if (f?.isObject === true && !readKey(f)) return keyBudgetHit ? TOO_LARGE : MALFORMED;
    const outcome = beginValue();
    if (outcome === "depth") return DEPTH;
    if (outcome === "too-large") return TOO_LARGE;
    if (outcome === "bad") return MALFORMED;
    if (outcome === "opened") {
      skipWs();
      continue;
    }
    if (!finishValue()) return MALFORMED;
    if (stack.length === 0) break;
  }
  skipWs();
  if (pos !== end) return MALFORMED;
  return { ok: true, duplicateOffsets, duplicateOverflow, elements, status, values };
}
