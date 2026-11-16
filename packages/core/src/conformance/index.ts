/**
 * Adapter conformance kit (SPEC-002 section 10). Every adapter test suite calls
 * `runAdapterConformance`; an empty result means the adapter conforms on the given cases.
 * Failure details are static strings: they never contain source or adapter text.
 */

import type { AdapterRegistration } from "../adapter/contract.js";
import { DEFAULT_BOUNDS } from "../adapter/contract.js";
import { canonicalJson } from "../content/index.js";
import { sha256Hex } from "../ids/index.js";
import { frameSource } from "../ingest/frame/index.js";
import type { SourceBytes } from "../ingest/fs/read.js";
import { selectAdapter } from "../ingest/select.js";
import { runImport } from "../pipeline/run.js";
import { PROVIDERS, SOURCE_STABILITIES, STRING_BOUNDS } from "../schema/constants.js";
import type { ImportResult } from "../schema/types.js";
import { validateEvents } from "../validate/index.js";

export interface ConformanceCase {
  readonly name: string;
  readonly bytes: Uint8Array;
  /** `canonicalJson(ImportResult)` golden for the case, when one exists. */
  readonly expected?: string;
}

export const CONFORMANCE_CHECKS = [
  "manifest-invalid",
  "capability-exceeds-matrix",
  "discovery-invalid",
  "detect-not-match",
  "import-failed",
  "not-idempotent",
  "golden-mismatch",
  "adapter-threw",
  "adapter-output-invalid",
  "attribute-not-allowed",
  "record-unaccounted",
  "detail-leak",
  "inline-under-hash-only",
  "events-invalid",
  "internal",
] as const;
export type ConformanceCheck = (typeof CONFORMANCE_CHECKS)[number];

export interface ConformanceOptions {
  /**
   * Parsed `docs/architecture/capability-matrix.json`, read by the caller (core never reads
   * files outside `ingest/fs`). When given, M12 is enforced per surface: a capability above
   * `unknown` needs the manifest's `sourceKind` in the cell's `surfaces`, and may not exceed
   * the cell's value.
   */
  readonly capabilityMatrix?: unknown;
}

export interface ConformanceFailure {
  /** The case name, or `null` for registration-level checks. */
  readonly case: string | null;
  readonly check: ConformanceCheck;
  readonly detail: string;
}

const CAPABILITY_ROWS = [
  "sessionLifecycle",
  "toolCallInputs",
  "toolCallOutputs",
  "llmMetadata",
  "filePatches",
  "subagents",
  "permissions",
  "failures",
  "timestamps",
  "tokens",
] as const;
const CAPABILITY_VALUES = ["available", "partial", "unknown", "unsupported"];
const MIN_LEAK_LENGTH = 6;

function re(name: keyof typeof STRING_BOUNDS): RegExp {
  return new RegExp(STRING_BOUNDS[name].pattern ?? "^$");
}

function checkManifest(reg: AdapterRegistration): string[] {
  const m = reg.adapter.manifest;
  const bad: string[] = [];
  if (!re("adapterId").test(m.id)) bad.push("id");
  if (!re("adapterVersion").test(m.adapterVersion)) bad.push("adapterVersion");
  if (!re("sourceKind").test(m.sourceKind)) bad.push("sourceKind");
  if (!(PROVIDERS as readonly string[]).includes(m.provider)) bad.push("provider");
  if (!m.sourceKind.startsWith(`${m.provider}.`)) bad.push("sourceKind-provider");
  if (!m.id.startsWith(`${m.provider}.`)) bad.push("id-provider");
  if (!(SOURCE_STABILITIES as readonly string[]).includes(m.sourceStability)) bad.push("stability");
  if (m.captureModes.length !== 1 || m.captureModes[0] !== "import-file") bad.push("captureModes");
  if (typeof m.experimental !== "boolean") bad.push("experimental");
  if (m.framing.kind === "json-document") {
    const arrays = m.framing.recordArrays;
    if (arrays.length < 1 || arrays.length > 4) bad.push("recordArrays-count");
    for (const p of arrays) {
      if (!/^\/(?:[^~/]|~[01])+(?:\/(?:[^~/]|~[01])+)*$/.test(p)) bad.push("recordArrays-pointer");
    }
  } else if (m.framing.kind !== "jsonl") bad.push("framing");
  const attr = re("attributeKey");
  for (const k of m.attributeKeys)
    if (!attr.test(k) || !k.startsWith(`${m.provider}.`)) bad.push("attributeKeys");
  for (const row of CAPABILITY_ROWS) {
    if (!CAPABILITY_VALUES.includes(m.capabilities[row])) bad.push("capabilities");
  }
  return [...new Set(bad)];
}

const CAPABILITY_RANK: Readonly<Record<string, number>> = {
  unsupported: 0,
  unknown: 0,
  partial: 1,
  available: 2,
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** M12: capability declarations may not exceed the matrix, per surface. */
function checkCapabilities(reg: AdapterRegistration, matrix: unknown): string[] {
  const m = reg.adapter.manifest;
  const providers = isRecord(matrix) ? matrix["providers"] : undefined;
  const provider = isRecord(providers) ? providers[m.provider] : undefined;
  const cells = isRecord(provider) ? provider["cells"] : undefined;
  const bad: string[] = [];
  for (const row of CAPABILITY_ROWS) {
    const declared = CAPABILITY_RANK[m.capabilities[row]] ?? 0;
    if (declared === 0) continue;
    const cell = isRecord(cells) ? cells[row] : undefined;
    const surfaces = isRecord(cell) ? cell["surfaces"] : undefined;
    const value = isRecord(cell) ? cell["value"] : undefined;
    const allowed =
      Array.isArray(surfaces) &&
      surfaces.includes(m.sourceKind) &&
      typeof value === "string" &&
      declared <= (CAPABILITY_RANK[value] ?? 0);
    if (!allowed) bad.push(row);
  }
  return bad;
}

function checkDiscovery(reg: AdapterRegistration): boolean {
  const src = reg.discovery.fileNamePattern;
  if (!src.startsWith("^") || !src.endsWith("$") || /\\(?:[1-9]|k<)/.test(src)) return false;
  try {
    new RegExp(src);
  } catch {
    return false;
  }
  return reg.discovery.roots.every(
    (r) =>
      ["home", "xdg-data", "xdg-config"].includes(r.base) &&
      r.segments.every((s) => s !== "" && s !== ".." && s !== "." && !s.includes("/")),
  );
}

function sourceOf(name: string, bytes: Uint8Array): SourceBytes {
  const sha = sha256Hex(bytes);
  return {
    bytes,
    sha256: sha,
    byteLength: bytes.length,
    container: { encoding: "none", sha256: sha, byteLength: bytes.length },
    displayName: name.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 64) || "case",
  };
}

function* detailStrings(r: ImportResult): Generator<string> {
  for (const w of r.warnings) {
    for (const v of Object.values(w.detail)) if (typeof v === "string") yield v;
  }
  for (const e of r.events) {
    if (e.kind === "capture.gap") yield e.payload.detail;
  }
}

/** Run every conformance check; an empty array means the registration conforms. */
export function runAdapterConformance(
  reg: AdapterRegistration,
  cases: readonly ConformanceCase[],
  options: ConformanceOptions = {},
): readonly ConformanceFailure[] {
  const failures: ConformanceFailure[] = [];
  const fail = (c: string | null, check: ConformanceCheck, detail: string): void => {
    failures.push({ case: c, check, detail });
  };
  try {
    const badFields = checkManifest(reg);
    if (badFields.length > 0)
      fail(null, "manifest-invalid", `manifest fields: ${badFields.join(",")}`);
    if (!checkDiscovery(reg)) fail(null, "discovery-invalid", "discovery roots or pattern invalid");
  } catch {
    fail(null, "manifest-invalid", "manifest could not be inspected");
  }
  if (options.capabilityMatrix !== undefined) {
    const over = checkCapabilities(reg, options.capabilityMatrix);
    if (over.length > 0) {
      fail(null, "capability-exceeds-matrix", `capability rows: ${over.join(",")}`);
    }
  }
  const bounds = DEFAULT_BOUNDS;
  for (const c of cases) {
    try {
      const src = sourceOf(c.name, c.bytes);
      const sel = selectAdapter(src, [reg], {}, bounds);
      if (!sel.ok) {
        fail(c.name, "detect-not-match", `detect verdict: ${sel.reason}`);
        continue;
      }
      const hashOnly = { retention: "hash-only", maxInlineBytes: 65_536 } as const;
      const a = runImport(src, reg, sel.detect, { bounds, contentPolicy: hashOnly });
      const b = runImport(src, reg, sel.detect, { bounds, contentPolicy: hashOnly });
      const json = canonicalJson(a);
      if (json !== canonicalJson(b)) fail(c.name, "not-idempotent", "two runs differ");
      if (c.expected !== undefined && json !== c.expected) {
        fail(c.name, "golden-mismatch", "result differs from the golden");
      }
      if (a.outcome === "failed") fail(c.name, "import-failed", "import outcome is failed");
      if (!validateEvents(a.events).ok) fail(c.name, "events-invalid", "events fail validation");

      const gapReasons = new Set<string>();
      for (const e of a.events) if (e.kind === "capture.gap") gapReasons.add(e.payload.reason);
      if (gapReasons.has("adapter-error"))
        fail(c.name, "adapter-threw", "adapter threw while mapping");
      if (gapReasons.has("adapter-output-invalid")) {
        fail(c.name, "adapter-output-invalid", "adapter produced an invalid draft");
      }
      if (a.warnings.some((w) => w.code === "attribute-not-allowed")) {
        fail(c.name, "attribute-not-allowed", "attribute key outside the manifest allowlist");
      }
      if (
        a.warnings.some(
          (w) => w.code === "adapter-output-invalid" && w.detail["reason"] === "unaccounted-record",
        )
      ) {
        fail(c.name, "record-unaccounted", "a record has no event, unknown, gap or disposition");
      }

      // Independent accounting check from the event provenance.
      const frame = frameSource(c.bytes, reg.adapter.manifest.framing, bounds);
      const covered = new Set<number>();
      for (const e of a.events) {
        if (e.provenance.type === "record") covered.add(e.sourceSequence);
      }
      const uncovered = frame.records.filter((r) => !covered.has(r.sourceSequence)).length;
      if (uncovered > a.stats.folded + (a.outcome === "failed" ? frame.records.length : 0)) {
        fail(c.name, "record-unaccounted", "records without events exceed folded records");
      }

      // PA-3: no detail value may be copied from the fixture text.
      const text = new TextDecoder("utf-8", { fatal: false }).decode(c.bytes);
      for (const v of detailStrings(a)) {
        if (v.length >= MIN_LEAK_LENGTH && text.includes(v)) {
          fail(c.name, "detail-leak", "a warning or gap detail repeats source text");
          break;
        }
      }
      for (const e of a.events) {
        for (const v of Object.values(e.payload)) {
          if (
            typeof v === "object" &&
            v !== null &&
            !Array.isArray(v) &&
            "retention" in v &&
            v.retention !== "hash-only"
          ) {
            fail(c.name, "inline-under-hash-only", "inline content under the hash-only policy");
          }
        }
      }

      // The inline policy must also import without failure.
      const inline = runImport(src, reg, sel.detect, {
        bounds,
        contentPolicy: { retention: "inline", maxInlineBytes: 65_536 },
      });
      if (inline.outcome === "failed") fail(c.name, "import-failed", "inline import failed");
    } catch {
      fail(c.name, "internal", "conformance check threw");
    }
  }
  return failures;
}
