/**
 * Stable serialization of policy-applied records for the store (`@swain/db`).
 *
 * Format `swain.policy-applied/1`: JSON text of `{"format":..., "type":"span"|"log", ...record}`,
 * with object keys sorted by UTF-16 code unit at every level and no insignificant whitespace.
 * `bigint` values (times) are written as decimal strings; the record schema says which fields
 * they are. `Uint8Array` never occurs (bytes are hashed). The helpers verify `isPolicyApplied`
 * first, so a forged object cannot be serialized.
 */
import { AtmError } from "@swain/core";
import { isPolicyApplied, type PolicyAppliedLog, type PolicyAppliedSpan } from "./types.js";

export const POLICY_APPLIED_FORMAT = "swain.policy-applied/1" as const;

function stable(v: unknown): string {
  if (v === null) return "null";
  switch (typeof v) {
    case "string":
      return JSON.stringify(v);
    case "number":
      if (!Number.isFinite(v)) return JSON.stringify(String(v));
      return Object.is(v, -0) ? "0" : String(v);
    case "boolean":
      return v ? "true" : "false";
    case "bigint":
      return JSON.stringify(v.toString());
    case "object":
      break;
    default:
      throw new AtmError("json-unsupported-type");
  }
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stable(o[k])}`).join(",")}}`;
}

function serialize(type: "span" | "log", rec: object): string {
  if (!isPolicyApplied(rec)) throw new AtmError("invalid-option");
  return stable({ format: POLICY_APPLIED_FORMAT, type, ...rec });
}

export function policyAppliedSpanJson(span: PolicyAppliedSpan): string {
  return serialize("span", span);
}

export function policyAppliedLogJson(log: PolicyAppliedLog): string {
  return serialize("log", log);
}
