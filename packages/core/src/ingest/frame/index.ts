/**
 * Framing (SPEC-002 section 3.2). Pure: bytes in, `FramedRecord`s out. Record bytes are never
 * copied into events; hashes are computed over exact spans of the single source buffer.
 */
import type {
  AdapterWarning,
  Bounds,
  FramedRecord,
  Framing,
  JsonValue,
} from "../../adapter/contract.js";
import { sha256Hex } from "../../ids/index.js";
import { type ArrayStatus, type ElementSpan, scanJson } from "./scan.js";

export interface FrameResult {
  readonly records: readonly FramedRecord[];
  readonly blankLines: number;
  readonly warnings: readonly AdapterWarning[];
  /** Pointer prefix per record: `null` for JSONL, `""` for the envelope, `/arr/<i>` for elements. */
  readonly recordBase: readonly (string | null)[];
  /** True when `maxRecords` stopped framing before the end of the source. */
  readonly recordLimitHit: boolean;
}

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const BOM = [0xef, 0xbb, 0xbf] as const;

type Failure = "malformed" | "too-large" | "depth" | "invalid-utf8";
type Parsed =
  | { readonly ok: true; readonly value: JsonValue }
  | { readonly ok: false; readonly failure: Failure };

function hasBom(b: Uint8Array, at: number): boolean {
  return b[at] === BOM[0] && b[at + 1] === BOM[1] && b[at + 2] === BOM[2];
}

/** Decode strictly; `undefined` means invalid UTF-8. */
function decodeStrict(bytes: Uint8Array): string | undefined {
  try {
    return decoder.decode(bytes);
  } catch {
    return undefined;
  }
}

function parseText(text: string): Parsed {
  try {
    return { ok: true, value: JSON.parse(text) as JsonValue };
  } catch {
    return { ok: false, failure: "malformed" };
  }
}

function warn(
  code: AdapterWarning["code"],
  severity: AdapterWarning["severity"],
  sourceSequence: number | null,
  detail: Readonly<Record<string, string | number>> = {},
): AdapterWarning {
  return { code, severity, sourceSequence, detail };
}

function pointerSegments(pointer: string): string[] {
  return pointer
    .split("/")
    .slice(1)
    .map((s) => s.replaceAll("~1", "/").replaceAll("~0", "~"));
}

function frameJsonl(bytes: Uint8Array, bounds: Bounds): FrameResult {
  const records: FramedRecord[] = [];
  const warnings: AdapterWarning[] = [];
  const dupCounts = new Map<number, number>();
  let blankLines = 0;
  let recordLimitHit = false;
  let valuesLeft = bounds.maxJsonValues;
  let pos = 0;
  let line = 1;
  const len = bytes.length;
  if (hasBom(bytes, 0)) warnings.push(warn("utf8-bom", "info", 0));
  while (pos < len) {
    const nl = bytes.indexOf(0x0a, pos);
    const lineEnd = nl < 0 ? len : nl;
    const next = nl < 0 ? len : nl + 1;
    let blank = true;
    for (let i = pos; i < lineEnd; i++) {
      const c = bytes[i];
      if (c !== 0x20 && c !== 0x09 && c !== 0x0d) {
        blank = false;
        break;
      }
    }
    if (blank) blankLines++;
    else {
      if (records.length >= bounds.maxRecords) {
        recordLimitHit = true;
        warnings.push(warn("bounds-reached", "warn", records.length, { limit: bounds.maxRecords }));
        break;
      }
      const span = bytes.subarray(pos, lineEnd);
      const base = {
        sourceSequence: records.length,
        line,
        byteOffset: pos,
        byteLength: span.length,
        sha256: sha256Hex(span),
        finalWithoutNewline: nl < 0,
      };
      let parse: Parsed;
      if (span.length > bounds.maxRecordBytes) parse = { ok: false, failure: "too-large" };
      else {
        const text = decodeStrict(span.subarray(pos === 0 && hasBom(span, 0) ? 3 : 0));
        if (text === undefined) parse = { ok: false, failure: "invalid-utf8" };
        else {
          const bom = pos === 0 && hasBom(span, 0) ? 3 : 0;
          const scan = scanJson(span, bom, span.length, bounds.maxJsonDepth, [], line, {
            maxValues: valuesLeft,
            maxSpans: 0,
          });
          if (!scan.ok) parse = { ok: false, failure: scan.failure };
          else {
            valuesLeft -= scan.values;
            parse = parseText(text);
            const dups = scan.duplicateOffsets.length + scan.duplicateOverflow;
            if (dups > 0 && parse.ok) dupCounts.set(base.sourceSequence, dups);
          }
        }
      }
      records.push({ ...base, parse });
    }
    line++;
    pos = next;
  }
  for (const [seq, count] of dupCounts) {
    warnings.push(warn("duplicate-json-key", "warn", seq, { count }));
  }
  return {
    records,
    blankLines,
    warnings,
    recordBase: records.map(() => null),
    recordLimitHit,
  };
}

function removeMember(root: JsonValue, segments: readonly string[]): void {
  let cur: JsonValue = root;
  for (let i = 0; i < segments.length; i++) {
    const key = segments[i];
    if (key === undefined || typeof cur !== "object" || cur === null || Array.isArray(cur)) return;
    const obj = cur as { [k: string]: JsonValue };
    if (!Object.hasOwn(obj, key)) return;
    if (i === segments.length - 1) {
      delete obj[key];
      return;
    }
    cur = obj[key] as JsonValue;
  }
}

function envelopeFailure(bytes: Uint8Array, failure: Failure): FrameResult {
  const record: FramedRecord = {
    sourceSequence: 0,
    line: 1,
    byteOffset: 0,
    byteLength: bytes.length,
    sha256: sha256Hex(bytes),
    finalWithoutNewline: false,
    parse: { ok: false, failure },
  };
  return {
    records: [record],
    blankLines: 0,
    warnings: [],
    recordBase: [""],
    recordLimitHit: false,
  };
}

function frameDocument(
  bytes: Uint8Array,
  recordArrays: readonly string[],
  bounds: Bounds,
): FrameResult {
  if (bytes.length > bounds.maxDocumentBytes) return envelopeFailure(bytes, "too-large");
  const text = decodeStrict(bytes.subarray(hasBom(bytes, 0) ? 3 : 0));
  if (text === undefined) return envelopeFailure(bytes, "invalid-utf8");
  const segments = recordArrays.map(pointerSegments);
  const scan = scanJson(bytes, 0, bytes.length, bounds.maxJsonDepth, segments, 1, {
    maxValues: bounds.maxJsonValues,
    maxSpans: bounds.maxRecords + 1,
  });
  if (!scan.ok) return envelopeFailure(bytes, scan.failure);
  const doc = parseText(text);
  if (!doc.ok) return envelopeFailure(bytes, "malformed");
  const warnings: AdapterWarning[] = [];
  if (hasBom(bytes, 0)) warnings.push(warn("utf8-bom", "info", 0));

  const status: readonly ArrayStatus[] = scan.status;
  status.forEach((st, t) => {
    if (st === "array") {
      const seg = segments[t];
      if (seg !== undefined) removeMember(doc.value, seg);
    } else warnings.push(warn("record-array-missing", "warn", 0, { arrayIndex: t }));
  });

  const records: FramedRecord[] = [
    {
      sourceSequence: 0,
      line: 1,
      byteOffset: 0,
      byteLength: bytes.length,
      sha256: sha256Hex(bytes),
      finalWithoutNewline: false,
      parse: { ok: true, value: doc.value },
    },
  ];
  const recordBase: (string | null)[] = [""];
  const owners: { start: number; end: number; seq: number }[] = [];
  let recordLimitHit = false;
  outer: for (let t = 0; t < scan.elements.length; t++) {
    const spans: readonly ElementSpan[] = scan.elements[t] ?? [];
    for (let i = 0; i < spans.length; i++) {
      const el = spans[i];
      if (el === undefined) continue;
      if (records.length - 1 >= bounds.maxRecords) {
        recordLimitHit = true;
        warnings.push(warn("bounds-reached", "warn", records.length, { limit: bounds.maxRecords }));
        break outer;
      }
      const span = bytes.subarray(el.start, el.end);
      let parse: Parsed;
      if (span.length > bounds.maxRecordBytes) parse = { ok: false, failure: "too-large" };
      else {
        const t2 = decodeStrict(span);
        parse = t2 === undefined ? { ok: false, failure: "invalid-utf8" } : parseText(t2);
      }
      const seq = records.length;
      owners.push({ start: el.start, end: el.end, seq });
      records.push({
        sourceSequence: seq,
        line: el.line,
        byteOffset: el.start,
        byteLength: span.length,
        sha256: sha256Hex(span),
        finalWithoutNewline: false,
        parse,
      });
      recordBase.push(`${recordArrays[t] ?? ""}/${i}`);
    }
  }
  // Attribute duplicate keys to the element (or the envelope) that contains them.
  if (scan.duplicateOffsets.length + scan.duplicateOverflow > 0) {
    owners.sort((a, b) => a.start - b.start);
    const counts = new Map<number, number>();
    const bump = (seq: number, n: number): void => {
      counts.set(seq, (counts.get(seq) ?? 0) + n);
    };
    for (const off of scan.duplicateOffsets) {
      let lo = 0;
      let hi = owners.length - 1;
      let hit = 0;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const o = owners[mid];
        if (o === undefined) break;
        if (off < o.start) hi = mid - 1;
        else if (off >= o.end) lo = mid + 1;
        else {
          hit = o.seq;
          break;
        }
      }
      bump(hit, 1);
    }
    if (scan.duplicateOverflow > 0) bump(0, scan.duplicateOverflow);
    for (const seq of [...counts.keys()].sort((a, b) => a - b)) {
      warnings.push(warn("duplicate-json-key", "warn", seq, { count: counts.get(seq) ?? 0 }));
    }
  }
  return { records, blankLines: 0, warnings, recordBase, recordLimitHit };
}

/** Frame the whole source. Never throws on hostile bytes. */
export function frameSource(bytes: Uint8Array, framing: Framing, bounds: Bounds): FrameResult {
  return framing.kind === "jsonl"
    ? frameJsonl(bytes, bounds)
    : frameDocument(bytes, framing.recordArrays, bounds);
}
