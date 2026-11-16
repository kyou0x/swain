/**
 * TEST-ONLY protobuf encoder for OTLP (no library, no runtime use). It turns an OTLP/JSON-shaped
 * structure into OTLP protobuf bytes so the differential tests can feed the same logical request
 * to both decoders. The field numbers are written independently of the decoder's tables but from
 * the same source of belief (packages/otlp/PIN.md), so a wrong number would not be caught here;
 * that is why PIN.md demands verification against the upstream .proto files before G3.
 *
 * Options let the fuzzer produce every legal variation of the same message (explicit default
 * values, any field order, unknown fields) and deliberate field-level corruption.
 */

export type Rnd = () => number;

export interface EncodeOptions {
  /** Emit default-valued scalars explicitly (legal proto3 on the wire). */
  readonly explicitDefaults?: boolean;
  /** Shuffle the order of field groups within each message (repeated fields keep their order). */
  readonly shuffle?: Rnd;
  /** Insert well-formed unknown fields of random wire types. */
  readonly unknownFields?: Rnd;
  /** Field-level corruption: per chunk probability `p` of one random corruption. */
  readonly corrupt?: { readonly rnd: Rnd; readonly p: number };
}

export class NotEncodable extends Error {}

type Bytes = number[];

/** Append arrays without spreading them into call arguments (a 1 MB array overflows the stack). */
function pushAll(out: Bytes, ...parts: readonly (readonly number[])[]): void {
  for (const p of parts) for (let i = 0; i < p.length; i++) out.push(p[i] as number);
}
interface Chunk {
  readonly num: number;
  readonly wt: number;
  /** The payload without tag (and without the length prefix for LEN). */
  readonly payload: Bytes;
}

export function varint(n: bigint | number): Bytes {
  let v = BigInt.asUintN(64, BigInt(n));
  const out: Bytes = [];
  while (v >= 0x80n) {
    pushAll(out, [Number(v & 0x7fn) | 0x80]);
    v >>= 7n;
  }
  pushAll(out, [Number(v)]);
  return out;
}

export function tagBytes(num: number, wt: number): Bytes {
  return varint(BigInt(num) * 8n + BigInt(wt));
}

export function fixed64Bytes(v: bigint): Bytes {
  const x = BigInt.asUintN(64, v);
  const out: Bytes = [];
  for (let i = 0n; i < 8n; i++) pushAll(out, [Number((x >> (8n * i)) & 0xffn)]);
  return out;
}

export function fixed32Bytes(v: number): Bytes {
  return [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255];
}

/** A complete wire field. */
export function field(num: number, wt: number, payload: Bytes): Bytes {
  const head = tagBytes(num, wt);
  const out: Bytes = [];
  pushAll(out, head);
  if (wt === 2) pushAll(out, varint(payload.length));
  pushAll(out, payload);
  return out;
}

export const lenField = (num: number, payload: Bytes | Uint8Array): Bytes =>
  field(num, 2, Array.from(payload));
export const varintField = (num: number, v: bigint | number): Bytes => field(num, 0, varint(v));
export const fixed64Field = (num: number, v: bigint): Bytes => field(num, 1, fixed64Bytes(v));
export const fixed32Field = (num: number, v: number): Bytes => field(num, 5, fixed32Bytes(v));
export const strField = (num: number, s: string): Bytes =>
  lenField(num, new TextEncoder().encode(s));

// ---- JSON-shape accessors -------------------------------------------------------------------------

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function obj(v: unknown): Obj {
  if (!isObj(v)) throw new NotEncodable("object expected");
  return v;
}

function arr(o: Obj, name: string): readonly unknown[] {
  if (!Object.hasOwn(o, name)) return [];
  const v = o[name];
  if (!Array.isArray(v)) throw new NotEncodable("array expected");
  return v as readonly unknown[];
}

function has(o: Obj, name: string): boolean {
  return Object.hasOwn(o, name) && o[name] !== null;
}

function strOf(o: Obj, name: string): string | undefined {
  if (!has(o, name)) return undefined;
  const v = o[name];
  if (typeof v !== "string") throw new NotEncodable("string expected");
  if (!v.isWellFormed()) throw new NotEncodable("lone surrogate");
  return v;
}

function bigOf(o: Obj, name: string): bigint | undefined {
  if (!has(o, name)) return undefined;
  const v = o[name];
  if (typeof v === "string" && /^-?\d+$/.test(v)) return BigInt(v);
  if (typeof v === "number" && Number.isSafeInteger(v)) return BigInt(v);
  throw new NotEncodable("int expected");
}

function hexBytes(s: string): Bytes {
  if (s.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(s)) throw new NotEncodable("hex expected");
  const out: Bytes = [];
  for (let i = 0; i < s.length; i += 2) pushAll(out, [Number.parseInt(s.slice(i, i + 2), 16)]);
  return out;
}

function b64Bytes(s: string): Bytes {
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const out: Bytes = [];
  let acc = 0;
  let bits = 0;
  for (const ch of s.replace(/=+$/, "")) {
    const i = A.indexOf(ch);
    if (i < 0) throw new NotEncodable("base64 expected");
    acc = (acc << 6) | i;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      pushAll(out, [(acc >> bits) & 255]);
    }
  }
  return out;
}

// ---- message assembly -----------------------------------------------------------------------------

class Msg {
  readonly chunks: Chunk[] = [];
  private readonly opt: EncodeOptions;
  constructor(opt: EncodeOptions) {
    this.opt = opt;
  }

  add(num: number, wt: number, payload: Bytes): void {
    this.chunks.push({ num, wt, payload });
  }
  len(num: number, payload: Bytes): void {
    this.add(num, 2, payload);
  }
  text(num: number, s: string | undefined): void {
    if (s === undefined) {
      return;
    }
    if (s !== "" || this.opt.explicitDefaults === true) {
      this.len(num, Array.from(new TextEncoder().encode(s)));
    }
  }
  /** Optional ID bytes: `undefined` means absent. */
  id(num: number, hex: string | undefined): void {
    if (hex === undefined) return;
    if (hex === "" && this.opt.explicitDefaults !== true) return;
    this.len(num, hexBytes(hex));
  }
  varint(num: number, v: bigint | undefined): void {
    if (v === undefined) return;
    if (v !== 0n || this.opt.explicitDefaults === true) this.add(num, 0, varint(v));
  }
  fixed64(num: number, v: bigint | undefined): void {
    if (v === undefined) return;
    if (v < 0n || v >= 1n << 64n) throw new NotEncodable("fixed64 range");
    if (v !== 0n || this.opt.explicitDefaults === true) this.add(num, 1, fixed64Bytes(v));
  }
  fixed32(num: number, v: bigint | undefined): void {
    if (v === undefined) return;
    if (v < 0n || v >= 1n << 32n) throw new NotEncodable("fixed32 range");
    if (v !== 0n || this.opt.explicitDefaults === true) this.add(num, 5, fixed32Bytes(Number(v)));
  }

  /** Serialize: group by field number, optionally shuffle groups, add unknowns and corruption. */
  bytes(): Bytes {
    const groups = new Map<number, Chunk[]>();
    for (const c of this.chunks) {
      const g = groups.get(c.num);
      if (g === undefined) groups.set(c.num, [c]);
      else g.push(c);
    }
    let order = [...groups.values()];
    const shuffle = this.opt.shuffle;
    if (shuffle !== undefined) {
      for (let i = order.length - 1; i > 0; i--) {
        const j = Math.floor(shuffle() * (i + 1));
        const t = order[i] as Chunk[];
        order[i] = order[j] as Chunk[];
        order[j] = t;
      }
    } else order = [...order];
    const out: Bytes = [];
    const unk = this.opt.unknownFields;
    const cor = this.opt.corrupt;
    const emit = (c: Chunk): void => {
      if (cor !== undefined && cor.rnd() < cor.p) {
        corruptChunk(c, cor.rnd, out);
        return;
      }
      pushAll(out, field(c.num, c.wt, c.payload));
    };
    for (const g of order) {
      if (unk !== undefined && unk() < 0.3) pushAll(out, unknownField(unk));
      for (const c of g) emit(c);
    }
    if (unk !== undefined && unk() < 0.3) pushAll(out, unknownField(unk));
    return out;
  }
}

/** A well-formed field with a number no OTLP message uses (100 .. 4999). */
function unknownField(rnd: Rnd): Bytes {
  const num = 100 + Math.floor(rnd() * 4900);
  const wt = [0, 1, 2, 5][Math.floor(rnd() * 4)] as number;
  const n = Math.floor(rnd() * 12);
  if (wt === 0) return field(num, 0, varint(BigInt(Math.floor(rnd() * 2 ** 32)) * 977n));
  if (wt === 1) return field(num, 1, fixed64Bytes(BigInt(Math.floor(rnd() * 2 ** 32))));
  if (wt === 5) return field(num, 5, fixed32Bytes(Math.floor(rnd() * 2 ** 32)));
  return field(
    num,
    2,
    Array.from({ length: n }, () => Math.floor(rnd() * 256)),
  );
}

function corruptChunk(c: Chunk, rnd: Rnd, out: Bytes): void {
  const kind = Math.floor(rnd() * 11);
  const whole = field(c.num, c.wt, c.payload);
  if (kind === 0) {
    pushAll(out, whole, whole); // duplicate
  } else if (kind === 1) {
    // drop
  } else if (kind === 2) {
    // different wire type with a plausible payload
    const wt = [0, 1, 2, 5][Math.floor(rnd() * 4)] as number;
    const payload =
      wt === 0
        ? varint(BigInt(Math.floor(rnd() * 1e9)))
        : wt === 1
          ? fixed64Bytes(7n)
          : wt === 5
            ? fixed32Bytes(9)
            : [1, 2, 3];
    pushAll(out, field(c.num, wt, payload));
  } else if (kind === 3) {
    // field number changed (possibly to a legal neighbour, 0, or above 2^29-1)
    const nums = [0, c.num + 1, c.num > 1 ? c.num - 1 : 2, 0x1fffffff, 0x20000000, 2 ** 31];
    const num = nums[Math.floor(rnd() * nums.length)] as number;
    pushAll(out, field(num, c.wt, c.payload));
  } else if (kind === 4) {
    // declared length off by a random amount
    if (c.wt === 2) {
      const delta = [1, -1, 1000, 2 ** 31, 2 ** 32][Math.floor(rnd() * 5)] as number;
      pushAll(out, tagBytes(c.num, 2), varint(Math.max(0, c.payload.length + delta)), c.payload);
    } else pushAll(out, whole);
  } else if (kind === 5) {
    // group wire types or reserved wire types
    const wt = [3, 4, 6, 7][Math.floor(rnd() * 4)] as number;
    pushAll(out, tagBytes(c.num, wt), c.payload);
  } else if (kind === 6) {
    // overlong or overflowing varint in place of the payload
    pushAll(
      out,
      tagBytes(c.num, 0),
      Array.from({ length: 10 + Math.floor(rnd() * 3) }, () => 0xff),
      [0x01],
    );
  } else if (kind >= 8 && c.wt === 2) {
    // Framing-preserving payload mutation: edit the bytes INSIDE a length-delimited field, then
    // emit it with a correct, re-encoded length. The enclosing frames stay valid, so the damage
    // reaches the nested message decoders (record-level and group-level rejections) instead of
    // being caught as a whole-request framing error at the top.
    const p = [...c.payload];
    const edits = 1 + Math.floor(rnd() * 3);
    for (let k = 0; k < edits; k++) {
      const pos = Math.floor(rnd() * Math.max(1, p.length));
      const op = Math.floor(rnd() * 6);
      if (op === 0) p[pos] = Math.floor(rnd() * 256);
      else if (op === 1) p.splice(pos, 1 + Math.floor(rnd() * 4));
      else if (op === 2) p.splice(pos, 0, Math.floor(rnd() * 256));
      else if (op === 3)
        p[pos] = 0xff; // breaks UTF-8, inflates varints
      else if (op === 4) p.splice(pos, 0, ...p.slice(pos, pos + Math.floor(rnd() * 24)));
      else p[pos] = (p[pos] ?? 0) ^ (1 << Math.floor(rnd() * 8));
    }
    pushAll(out, field(c.num, 2, p));
  } else {
    pushAll(out, whole.slice(0, Math.floor(rnd() * whole.length))); // truncation inside the field
  }
}

// ---- OTLP messages --------------------------------------------------------------------------------

function anyValue(v: unknown, opt: EncodeOptions): Bytes {
  const o = obj(v);
  const m = new Msg(opt);
  const names = [
    "stringValue",
    "boolValue",
    "intValue",
    "doubleValue",
    "bytesValue",
    "arrayValue",
    "kvlistValue",
  ];
  const present = names.filter((n) => has(o, n));
  if (present.length !== 1) throw new NotEncodable("exactly one AnyValue member expected");
  const key = present[0] as string;
  const x = o[key];
  switch (key) {
    case "stringValue": {
      if (typeof x !== "string" || !x.isWellFormed()) throw new NotEncodable("string");
      m.len(1, Array.from(new TextEncoder().encode(x)));
      break;
    }
    case "boolValue":
      if (typeof x !== "boolean") throw new NotEncodable("bool");
      m.add(2, 0, varint(x ? 1 : 0));
      break;
    case "intValue": {
      const n = bigOf(o, "intValue") as bigint;
      if (n < -(1n << 63n) || n >= 1n << 63n) throw new NotEncodable("int64 range");
      m.add(3, 0, varint(n));
      break;
    }
    case "doubleValue": {
      if (typeof x !== "number" || !Number.isFinite(x)) throw new NotEncodable("double");
      const dv = new DataView(new ArrayBuffer(8));
      dv.setFloat64(0, x, true);
      m.add(4, 1, Array.from(new Uint8Array(dv.buffer)));
      break;
    }
    case "bytesValue":
      if (typeof x !== "string") throw new NotEncodable("bytes");
      m.len(7, b64Bytes(x));
      break;
    case "arrayValue": {
      const inner = new Msg(opt);
      for (const it of arr(obj(x), "values")) inner.len(1, anyValue(it, opt));
      m.len(5, inner.bytes());
      break;
    }
    default: {
      const inner = new Msg(opt);
      for (const it of arr(obj(x), "values")) inner.len(1, keyValue(it, opt));
      m.len(6, inner.bytes());
    }
  }
  return m.bytes();
}

function keyValue(v: unknown, opt: EncodeOptions): Bytes {
  const o = obj(v);
  const m = new Msg(opt);
  m.text(1, strOf(o, "key"));
  if (has(o, "value")) m.len(2, anyValue(o["value"], opt));
  return m.bytes();
}

function attrs(m: Msg, num: number, o: Obj, opt: EncodeOptions): void {
  for (const a of arr(o, "attributes")) m.len(num, keyValue(a, opt));
}

function resource(v: unknown, opt: EncodeOptions): Bytes {
  const o = obj(v);
  const m = new Msg(opt);
  attrs(m, 1, o, opt);
  m.varint(2, bigOf(o, "droppedAttributesCount"));
  return m.bytes();
}

function scope(v: unknown, opt: EncodeOptions): Bytes {
  const o = obj(v);
  const m = new Msg(opt);
  m.text(1, strOf(o, "name"));
  m.text(2, strOf(o, "version"));
  attrs(m, 3, o, opt);
  m.varint(4, bigOf(o, "droppedAttributesCount"));
  return m.bytes();
}

function event(v: unknown, opt: EncodeOptions): Bytes {
  const o = obj(v);
  const m = new Msg(opt);
  m.fixed64(1, bigOf(o, "timeUnixNano"));
  m.text(2, strOf(o, "name"));
  attrs(m, 3, o, opt);
  m.varint(4, bigOf(o, "droppedAttributesCount"));
  return m.bytes();
}

function link(v: unknown, opt: EncodeOptions): Bytes {
  const o = obj(v);
  const m = new Msg(opt);
  m.id(1, strOf(o, "traceId"));
  m.id(2, strOf(o, "spanId"));
  m.text(3, strOf(o, "traceState"));
  attrs(m, 4, o, opt);
  m.varint(5, bigOf(o, "droppedAttributesCount"));
  m.fixed32(6, bigOf(o, "flags"));
  return m.bytes();
}

function span(v: unknown, opt: EncodeOptions): Bytes {
  const o = obj(v);
  const m = new Msg(opt);
  m.id(1, strOf(o, "traceId"));
  m.id(2, strOf(o, "spanId"));
  m.text(3, strOf(o, "traceState"));
  m.id(4, strOf(o, "parentSpanId"));
  m.text(5, strOf(o, "name"));
  m.varint(6, bigOf(o, "kind"));
  m.fixed64(7, bigOf(o, "startTimeUnixNano"));
  m.fixed64(8, bigOf(o, "endTimeUnixNano"));
  attrs(m, 9, o, opt);
  m.varint(10, bigOf(o, "droppedAttributesCount"));
  for (const e of arr(o, "events")) m.len(11, event(e, opt));
  m.varint(12, bigOf(o, "droppedEventsCount"));
  for (const l of arr(o, "links")) m.len(13, link(l, opt));
  m.varint(14, bigOf(o, "droppedLinksCount"));
  if (has(o, "status")) {
    const so = obj(o["status"]);
    const st = new Msg(opt);
    st.text(2, strOf(so, "message"));
    st.varint(3, bigOf(so, "code"));
    m.len(15, st.bytes());
  }
  m.fixed32(16, bigOf(o, "flags"));
  return m.bytes();
}

function logRecord(v: unknown, opt: EncodeOptions): Bytes {
  const o = obj(v);
  const m = new Msg(opt);
  m.fixed64(1, bigOf(o, "timeUnixNano"));
  m.varint(2, bigOf(o, "severityNumber"));
  m.text(3, strOf(o, "severityText"));
  if (has(o, "body")) m.len(5, anyValue(o["body"], opt));
  attrs(m, 6, o, opt);
  m.varint(7, bigOf(o, "droppedAttributesCount"));
  m.fixed32(8, bigOf(o, "flags"));
  m.id(9, strOf(o, "traceId"));
  m.id(10, strOf(o, "spanId"));
  m.fixed64(11, bigOf(o, "observedTimeUnixNano"));
  m.text(12, strOf(o, "eventName"));
  return m.bytes();
}

function request(
  root: unknown,
  names: readonly [string, string, string],
  record: (v: unknown, opt: EncodeOptions) => Bytes,
  opt: EncodeOptions,
): Uint8Array {
  const [rn, sn, xn] = names;
  const top = new Msg(opt);
  for (const rgRaw of arr(obj(root), rn)) {
    const rg = obj(rgRaw);
    const rm = new Msg(opt);
    if (has(rg, "resource")) rm.len(1, resource(rg["resource"], opt));
    for (const sgRaw of arr(rg, sn)) {
      const sg = obj(sgRaw);
      const sm = new Msg(opt);
      if (has(sg, "scope")) sm.len(1, scope(sg["scope"], opt));
      for (const r of arr(sg, xn)) sm.len(2, record(r, opt));
      sm.text(3, strOf(sg, "schemaUrl"));
      rm.len(2, sm.bytes());
    }
    rm.text(3, strOf(rg, "schemaUrl"));
    top.len(1, rm.bytes());
  }
  return new Uint8Array(top.bytes());
}

/** Encode an OTLP/JSON-shaped `ExportTraceServiceRequest` as protobuf. Throws `NotEncodable`. */
export function encodeTraces(root: unknown, opt: EncodeOptions = {}): Uint8Array {
  return request(root, ["resourceSpans", "scopeSpans", "spans"], span, opt);
}

export function encodeLogs(root: unknown, opt: EncodeOptions = {}): Uint8Array {
  return request(root, ["resourceLogs", "scopeLogs", "logRecords"], logRecord, opt);
}
