/** Adapter selection (SPEC-002 section 3.3, M-1). Pure and deterministic. */
import type {
  AdapterRegistration,
  Bounds,
  DetectResult,
  FramedRecord,
  ProviderId,
} from "../adapter/contract.js";
import { frameSource } from "./frame/index.js";
import type { SourceBytes } from "./fs/read.js";

export type Selection = { readonly provider?: ProviderId; readonly sourceKind?: string };

export type SelectResult =
  | {
      readonly ok: true;
      readonly registration: AdapterRegistration;
      readonly detect: DetectResult;
    }
  | {
      readonly ok: false;
      readonly reason: "no-match" | "ambiguous" | "unsupported";
      /** Adapter ids. */
      readonly candidates: readonly string[];
    };

const VERDICTS = ["match", "no-match", "unsupported"] as const;

function safeDetect(reg: AdapterRegistration, sample: readonly FramedRecord[]): DetectResult {
  const none: DetectResult = {
    verdict: "no-match",
    providerVersionSeen: null,
    nativeSessionId: null,
    reasons: [],
  };
  try {
    const r = reg.adapter.detect(sample);
    if (typeof r !== "object" || r === null) return none;
    if (!VERDICTS.includes(r.verdict)) return none;
    return r;
  } catch {
    return none;
  }
}

/**
 * Filter by `sel`, frame once per framing group using only the first `detectSampleRecords`
 * records, run every candidate's `detect`, and require exactly one `match`.
 */
export function selectAdapter(
  src: SourceBytes,
  regs: readonly AdapterRegistration[],
  sel: Selection,
  bounds: Bounds,
): SelectResult {
  const candidates = regs.filter(
    (r) =>
      (sel.provider === undefined || r.adapter.manifest.provider === sel.provider) &&
      (sel.sourceKind === undefined || r.adapter.manifest.sourceKind === sel.sourceKind),
  );
  const sampleBounds: Bounds = { ...bounds, maxRecords: Math.max(1, bounds.detectSampleRecords) };
  const samples = new Map<string, readonly FramedRecord[]>();
  const matches: { reg: AdapterRegistration; detect: DetectResult }[] = [];
  const unsupported: string[] = [];
  for (const reg of candidates) {
    const framing = reg.adapter.manifest.framing;
    const key = JSON.stringify(framing);
    let sample = samples.get(key);
    if (sample === undefined) {
      sample = frameSource(src.bytes, framing, sampleBounds).records;
      samples.set(key, sample);
    }
    const detect = safeDetect(reg, sample);
    if (detect.verdict === "match") matches.push({ reg, detect });
    else if (detect.verdict === "unsupported") unsupported.push(reg.adapter.manifest.id);
  }
  const [first, ...rest] = matches;
  if (first !== undefined && rest.length === 0) {
    return { ok: true, registration: first.reg, detect: first.detect };
  }
  if (first !== undefined) {
    return {
      ok: false,
      reason: "ambiguous",
      candidates: matches.map((m) => m.reg.adapter.manifest.id),
    };
  }
  if (unsupported.length > 0) return { ok: false, reason: "unsupported", candidates: unsupported };
  return { ok: false, reason: "no-match", candidates: [] };
}
