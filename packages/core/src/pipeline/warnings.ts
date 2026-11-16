import type { AdapterWarning } from "../adapter/contract.js";
import { WARNING_CODES } from "../schema/constants.js";
import { utf8ByteLength } from "../text/index.js";

const SEVERITIES = ["info", "warn", "error"] as const;
const RANK: Record<AdapterWarning["severity"], number> = { info: 0, warn: 1, error: 2 };
const DETAIL_KEY = /^[a-zA-Z][a-zA-Z0-9]{0,31}$/;

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** Validate an adapter-supplied warning; `undefined` when it breaks the contract. */
export function sanitizeWarning(raw: unknown, maxSequence: number): AdapterWarning | undefined {
  if (!isPlainObject(raw)) return undefined;
  const code = raw["code"];
  const severity = raw["severity"];
  const seq = raw["sourceSequence"];
  const detail = raw["detail"];
  if (typeof code !== "string" || !(WARNING_CODES as readonly string[]).includes(code)) {
    return undefined;
  }
  if (typeof severity !== "string" || !(SEVERITIES as readonly string[]).includes(severity)) {
    return undefined;
  }
  if (seq !== null && !(typeof seq === "number" && Number.isSafeInteger(seq) && seq >= 0)) {
    return undefined;
  }
  if (typeof seq === "number" && seq > maxSequence) return undefined;
  if (!isPlainObject(detail)) return undefined;
  const keys = Object.keys(detail);
  if (keys.length > 8) return undefined;
  const out: Record<string, string | number> = {};
  for (const k of keys) {
    const v = detail[k];
    if (!DETAIL_KEY.test(k)) return undefined;
    if (typeof v === "string") {
      if (!v.isWellFormed() || utf8ByteLength(v) > 256) return undefined;
    } else if (!(typeof v === "number" && Number.isSafeInteger(v))) return undefined;
    out[k] = v;
  }
  return {
    code: code as AdapterWarning["code"],
    severity: severity as AdapterWarning["severity"],
    sourceSequence: seq,
    detail: out,
  };
}

export class WarningSink {
  private readonly list: AdapterWarning[] = [];
  private readonly index = new Set<string>();

  add(
    code: AdapterWarning["code"],
    severity: AdapterWarning["severity"],
    sourceSequence: number | null,
    detail: Readonly<Record<string, string | number>> = {},
  ): void {
    this.push({ code, severity, sourceSequence, detail });
  }

  push(w: AdapterWarning): void {
    this.list.push(w);
    this.index.add(`${w.code}:${w.sourceSequence}`);
  }

  has(code: AdapterWarning["code"], sourceSequence: number | null): boolean {
    return this.index.has(`${code}:${sourceSequence}`);
  }

  /** Keep the first `max` warnings; aggregate the rest by code (`warnings-aggregated`). */
  finalize(max: number): AdapterWarning[] {
    if (this.list.length <= max) return [...this.list];
    const kept = this.list.slice(0, max);
    const rest = new Map<string, { count: number; severity: AdapterWarning["severity"] }>();
    for (const w of this.list.slice(max)) {
      const e = rest.get(w.code);
      if (e === undefined) rest.set(w.code, { count: 1, severity: w.severity });
      else {
        e.count++;
        if (RANK[w.severity] > RANK[e.severity]) e.severity = w.severity;
      }
    }
    for (const code of [...rest.keys()].sort()) {
      const e = rest.get(code);
      if (e === undefined) continue;
      kept.push({
        code: code as AdapterWarning["code"],
        severity: e.severity,
        sourceSequence: null,
        detail: { count: e.count },
      });
    }
    kept.push({
      code: "warnings-aggregated",
      severity: "info",
      sourceSequence: null,
      detail: { total: this.list.length, kept: max },
    });
    return kept;
  }
}
