import { OtlpDecodeError } from "../errors.js";

/**
 * Bounded, iterative (non-recursive) strict JSON parser (RFC 8259) used instead of `JSON.parse`
 * so that duplicate object keys can be detected and attributed to the records that contain them
 * (F13: proto3 would be "last wins/merge"; both decoders reject instead).
 *
 * - Objects have a null prototype, so a key named `__proto__` is a plain own property.
 * - Nesting deeper than `maxDepth` is `json-too-deep`; more than `maxValues` values (containers,
 *   scalars and object keys) is `too-many-values`; any grammar error is `malformed-json`.
 * - `subtree` holds every object that is, or contains at any depth, an object with a duplicate
 *   key. `direct` holds the objects that themselves repeat a key.
 * - A leading U+FEFF is not whitespace, so a BOM is `malformed-json` (it is never silently dropped).
 */
export interface ParsedJson {
  readonly root: unknown;
  readonly subtree: WeakSet<object>;
  readonly direct: WeakSet<object>;
}

interface Frame {
  readonly isObject: boolean;
  readonly container: Record<string, unknown> | unknown[];
  readonly keys: Set<string> | null;
  key: string;
}

/**
 * A JSON number whose literal has a fraction or an exponent (`1.0`, `1e3`, `2.5`). Integer fields
 * accept only integer literals (digits, optional minus), so they must be able to tell the two
 * apart after parsing; only `doubleValue` reads this wrapper. It is an object, so every other
 * reader (`typeof v === "number"`, `isObj`) rejects it as a non-number.
 */
export class FloatLiteral {
  readonly value: number;
  constructor(value: number) {
    this.value = value;
  }
}

const NUMBER = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;

function malformed(): never {
  throw new OtlpDecodeError("malformed-json");
}

export function parseJson(text: string, maxDepth: number, maxValues: number): ParsedJson {
  const n = text.length;
  let i = 0;
  let values = 0;
  const stack: Frame[] = [];
  const subtree = new WeakSet<object>();
  const direct = new WeakSet<object>();

  const count = (): void => {
    if (++values > maxValues) throw new OtlpDecodeError("too-many-values");
  };
  const skipWs = (): void => {
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) i++;
      else return;
    }
  };
  const readString = (): string => {
    // text[i] is the opening quote
    const start = i++;
    let escaped = false;
    for (;;) {
      if (i >= n) return malformed();
      const c = text.charCodeAt(i);
      if (c === 0x22) break;
      if (c < 0x20) return malformed();
      if (c === 0x5c) {
        escaped = true;
        i += 2;
      } else i++;
    }
    i++;
    if (!escaped) return text.slice(start + 1, i - 1);
    try {
      const v: unknown = JSON.parse(text.slice(start, i));
      if (typeof v !== "string") return malformed();
      return v;
    } catch {
      return malformed();
    }
  };
  const readKey = (f: Frame): void => {
    skipWs();
    if (text.charCodeAt(i) !== 0x22) malformed();
    count();
    f.key = readString();
    skipWs();
    if (text.charCodeAt(i) !== 0x3a) malformed();
    i++;
  };
  const markDuplicate = (f: Frame): void => {
    direct.add(f.container);
    // Marking always covers a whole prefix of the stack, so the first marked ancestor (from the
    // top) proves every frame below it is marked: O(depth) in total, not per duplicate.
    for (let k = stack.length - 1; k >= 0; k--) {
      const c = (stack[k] as Frame).container;
      if (subtree.has(c)) break;
      subtree.add(c);
    }
  };
  const literal = (word: string, value: unknown): unknown => {
    if (!text.startsWith(word, i)) return malformed();
    i += word.length;
    return value;
  };

  let root: unknown;
  outer: for (;;) {
    skipWs();
    if (i >= n) return malformed();
    const c = text.charCodeAt(i);
    let v: unknown;
    if (c === 0x7b || c === 0x5b) {
      count();
      if (stack.length + 1 > maxDepth) throw new OtlpDecodeError("json-too-deep");
      const isObject = c === 0x7b;
      i++;
      skipWs();
      if (text.charCodeAt(i) === (isObject ? 0x7d : 0x5d)) {
        i++;
        v = isObject ? Object.create(null) : [];
      } else {
        const f: Frame = {
          isObject,
          container: isObject ? (Object.create(null) as Record<string, unknown>) : [],
          keys: isObject ? new Set<string>() : null,
          key: "",
        };
        stack.push(f);
        if (isObject) readKey(f);
        continue;
      }
    } else if (c === 0x22) {
      count();
      v = readString();
    } else if (c === 0x74) {
      count();
      v = literal("true", true);
    } else if (c === 0x66) {
      count();
      v = literal("false", false);
    } else if (c === 0x6e) {
      count();
      v = literal("null", null);
    } else {
      count();
      NUMBER.lastIndex = i;
      const m = NUMBER.exec(text);
      if (m === null) return malformed();
      i += m[0].length;
      v = /[.eE]/.test(m[0]) ? new FloatLiteral(Number(m[0])) : Number(m[0]);
    }
    // Attach the finished value upward until a sibling follows or the root is complete.
    for (;;) {
      const f = stack[stack.length - 1];
      if (f === undefined) {
        root = v;
        break outer;
      }
      if (f.isObject) {
        const keys = f.keys as Set<string>;
        if (keys.has(f.key)) markDuplicate(f);
        else keys.add(f.key);
        (f.container as Record<string, unknown>)[f.key] = v;
      } else {
        (f.container as unknown[]).push(v);
      }
      skipWs();
      const d = text.charCodeAt(i);
      if (d === 0x2c) {
        i++;
        if (f.isObject) readKey(f);
        continue outer;
      }
      if (d === (f.isObject ? 0x7d : 0x5d)) {
        i++;
        stack.pop();
        v = f.container;
        continue;
      }
      return malformed();
    }
  }
  skipWs();
  if (i < n) return malformed();
  return { root, subtree, direct };
}
