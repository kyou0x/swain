import type { Rnd } from "./proto-encoder.js";

type J = Record<string, unknown>;

const int = (rnd: Rnd, n: number): number => Math.floor(rnd() * n);
const hex = (rnd: Rnd, bytes: number): string =>
  Array.from({ length: bytes }, () => int(rnd, 256).toString(16).padStart(2, "0")).join("");

function recordsOf(structure: J, names: readonly [string, string, string]): J[] {
  const out: J[] = [];
  for (const rg of (structure[names[0]] as J[] | undefined) ?? []) {
    for (const sg of (rg[names[1]] as J[] | undefined) ?? []) {
      for (const r of (sg[names[2]] as J[] | undefined) ?? []) out.push(r);
    }
  }
  return out;
}

function deepChain(rnd: Rnd, depth: number): J {
  let v: J = { stringValue: "x" };
  for (let i = 1; i < depth; i++) {
    v =
      rnd() < 0.5
        ? { arrayValue: { values: [v] } }
        : { kvlistValue: { values: [{ key: "k", value: v }] } };
  }
  return v;
}

const kv = (value: J, key = "k"): J => ({ key, value });

/**
 * Inject exactly ONE semantic defect into a random record of a valid request (mutates it). Both
 * wire formats can express every defect below, so the differential comparison stays exact
 * (a single defect cannot expose the documented reason-precedence difference). Returns false
 * when the request has no record to damage.
 */
export function injectDefect(rnd: Rnd, structure: J, traces: boolean): boolean {
  const recs = recordsOf(
    structure,
    traces ? ["resourceSpans", "scopeSpans", "spans"] : ["resourceLogs", "scopeLogs", "logRecords"],
  );
  const r = recs[int(rnd, recs.length)];
  if (r === undefined) return false;
  const push = (v: J): void => {
    const a = (r["attributes"] as J[] | undefined) ?? [];
    a.push(v);
    r["attributes"] = a;
  };
  switch (int(rnd, 12)) {
    case 0:
      r["traceId"] = hex(rnd, [14, 15, 17, 20][int(rnd, 4)] as number);
      break;
    case 1:
      r["spanId"] = "00".repeat(8);
      break;
    case 2:
      // span: parent_span_id; log: span_id (both optional IDs of 8 bytes)
      r[traces ? "parentSpanId" : "spanId"] = hex(rnd, [1, 7, 9, 14][int(rnd, 4)] as number);
      break;
    case 3:
      if (traces) r["kind"] = 6 + int(rnd, 90);
      else r["severityNumber"] = 25 + int(rnd, 90);
      break;
    case 4:
      r[traces ? "startTimeUnixNano" : "timeUnixNano"] = String(
        (1n << 63n) + BigInt(int(rnd, 1e9)),
      );
      break;
    case 5:
      r["droppedAttributesCount"] = 4294967296 + int(rnd, 1000);
      break;
    case 6:
      push(kv(deepChain(rnd, 17 + int(rnd, 6))));
      break;
    case 7:
      push(
        kv({
          arrayValue: {
            values: Array.from({ length: 1025 + int(rnd, 3) }, () => ({ stringValue: "" })),
          },
        }),
      );
      break;
    case 8:
      push(kv({ stringValue: "v" }, "k".repeat(257 + int(rnd, 10))));
      break;
    case 9:
      if (rnd() < 0.15) r[traces ? "name" : "severityText"] = "x".repeat(1_048_577);
      else r["droppedAttributesCount"] = 4294967296;
      break;
    case 10:
      push({ key: "novalue" });
      break;
    default:
      push(
        kv({
          kvlistValue: { values: Array.from({ length: 1025 }, () => kv({ stringValue: "" })) },
        }),
      );
  }
  return true;
}
