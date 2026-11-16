/**
 * Tiny in-test adapter for the synthetic "reference log" format (fixtures/reference). It is
 * data-driven by the record field `t` so tests can provoke every pipeline path. It is not a
 * provider adapter and ships nowhere.
 */
import { readFileSync } from "node:fs";
import type {
  AdapterRegistration,
  AdapterWarning,
  DetectResult,
  DraftEvent,
  FramedRecord,
  JsonValue,
  ParseContext,
  ProviderCapabilities,
  RecordDisposition,
  RecordParser,
} from "../../src/adapter/contract.js";
import { DEFAULT_BOUNDS } from "../../src/adapter/contract.js";
import { makeContentRef } from "../../src/content/index.js";
import { sha256Hex } from "../../src/ids/index.js";
import type { SourceBytes } from "../../src/ingest/fs/read.js";
import { normalizeTimestamp } from "../../src/time/index.js";

export const FIXTURES = new URL("../../../../../fixtures/", import.meta.url);

export function fixtureBytes(rel: string): Uint8Array {
  return new Uint8Array(readFileSync(new URL(rel, FIXTURES)));
}

export function sourceFrom(bytes: Uint8Array | string, name = "ref.jsonl"): SourceBytes {
  const b = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  const sha = sha256Hex(b);
  return {
    bytes: b,
    sha256: sha,
    byteLength: b.length,
    container: { encoding: "none", sha256: sha, byteLength: b.length },
    displayName: name,
  };
}

const UNKNOWN_CAPS: ProviderCapabilities = {
  sessionLifecycle: "unknown",
  toolCallInputs: "unknown",
  toolCallOutputs: "unknown",
  llmMetadata: "unknown",
  filePatches: "unknown",
  subagents: "unknown",
  permissions: "unknown",
  failures: "unknown",
  timestamps: "unknown",
  tokens: "unknown",
};

type Obj = { readonly [k: string]: JsonValue };
const asObj = (v: JsonValue | undefined): Obj =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Obj) : {};
const str = (o: Obj, k: string): string => {
  const v = o[k];
  return typeof v === "string" ? v : "";
};

export interface RefOptions {
  readonly testedVersions?: readonly string[];
  readonly attributeKeys?: readonly string[];
}

const captured = { state: "captured" } as const;

function base(
  o: Obj,
  kind: DraftEvent["kind"],
  role: "user" | "agent" | "runtime",
  actorKey: string,
  payload: DraftEvent["payload"],
  extra: Partial<DraftEvent> = {},
): DraftEvent {
  return {
    kind,
    providerVersion: "9.9.9",
    time: normalizeTimestamp(o["ts"] ?? null),
    actor: { role },
    status: "none",
    payload,
    completeness: { timestamp: captured, actor: captured },
    attributes: {},
    pointer: "",
    actorKey,
    ...extra,
  };
}

class RefParser implements RecordParser {
  private readonly ctx: ParseContext;
  private endThrows = false;
  private readonly msgs = new Map<string, { order: number; evidence: number; text: string }>();
  private readonly endExtra: DraftEvent[] = [];

  constructor(ctx: ParseContext) {
    this.ctx = ctx;
  }

  private ref(v: unknown) {
    return makeContentRef(v, {
      retention: this.ctx.contentPolicy.retention,
      maxInlineBytes: this.ctx.contentPolicy.maxInlineBytes,
    });
  }

  push(record: FramedRecord) {
    const drafts: DraftEvent[] = [];
    const warnings: AdapterWarning[] = [];
    const dispositions: RecordDisposition[] = [];
    if (!record.parse.ok) throw new Error("core must not push failed records");
    const v = record.parse.value;
    const o = asObj(v);
    const t = str(o, "t");
    const seq = record.sourceSequence;
    switch (t) {
      case "session":
        drafts.push(
          base(o, "session.started", "runtime", "runtime", {
            nativeSessionId: str(o, "id"),
            trigger: "startup",
          }),
        );
        break;
      case "turn.start":
        drafts.push(
          base(
            o,
            "turn.started",
            "user",
            "user",
            { prompt: o["text"] === undefined ? null : this.ref(o["text"]) },
            {
              nativeTurnKey: str(o, "turn"),
              correlation: { anchor: `turn:${str(o, "turn")}` },
            },
          ),
        );
        break;
      case "turn.end":
        drafts.push(
          base(
            o,
            "turn.ended",
            "agent",
            "root",
            {},
            {
              status: "success",
              nativeTurnKey: str(o, "turn"),
              correlation: { refs: [{ rel: "ends", key: `turn:${str(o, "turn")}` }] },
            },
          ),
        );
        break;
      case "tool.call":
        drafts.push(
          base(
            o,
            "tool.requested",
            "agent",
            "root",
            {
              toolCallId: str(o, "call"),
              toolName: str(o, "name"),
              toolNamespace: "builtin",
              input: o["input"] === undefined ? null : this.ref(o["input"]),
            },
            {
              completeness: {
                timestamp: captured,
                actor: captured,
                inputs: captured,
                outputs: { state: "unknown" },
              },
              correlation: { anchor: str(o, "call") },
            },
          ),
        );
        break;
      case "tool.result": {
        const ok = o["ok"] === true;
        const payload = ok
          ? {
              toolCallId: str(o, "call"),
              toolName: null,
              output: o["output"] === undefined ? null : this.ref(o["output"]),
            }
          : {
              toolCallId: str(o, "call"),
              toolName: null,
              output: null,
              error: o["error"] === undefined ? null : this.ref(o["error"]),
              errorClass: "error",
            };
        drafts.push(
          base(o, ok ? "tool.completed" : "tool.failed", "agent", "root", payload, {
            status: ok ? "success" : "failure",
            completeness: {
              timestamp: captured,
              actor: captured,
              inputs: { state: "unknown" },
              outputs: captured,
            },
            correlation: { refs: [{ rel: "result-of", key: str(o, "call") }] },
          }),
        );
        break;
      }
      case "meta":
        dispositions.push({ sourceSequence: seq, kind: "metadata", into: 0 });
        break;
      case "ctl":
        dispositions.push({ sourceSequence: seq, kind: "control", into: null });
        break;
      case "throw":
        throw new Error("boom: secret-detail-must-not-leak");
      case "end-throw":
        this.endThrows = true;
        dispositions.push({ sourceSequence: seq, kind: "control", into: null });
        break;
      case "extra-field":
        drafts.push({
          ...base(o, "turn.ended", "agent", "root", {}, { status: "success" }),
          bogus: 1,
        } as DraftEvent);
        break;
      case "attr":
        drafts.push(
          base(
            o,
            "turn.ended",
            "agent",
            "root",
            {},
            {
              status: "success",
              attributes: { [str(o, "key")]: 1 },
            },
          ),
        );
        break;
      case "inline":
        drafts.push(
          base(o, "turn.started", "user", "user", {
            prompt: makeContentRef(str(o, "text"), { retention: "inline" }),
          }),
        );
        break;
      case "many": {
        const n = Number(o["n"] ?? 0);
        for (let i = 0; i < n; i++)
          drafts.push(base(o, "turn.ended", "agent", "root", {}, { status: "success" }));
        break;
      }
      case "fwd":
        drafts.push(
          base(
            o,
            "turn.ended",
            "agent",
            "root",
            {},
            {
              status: "success",
              recordRef: { order: seq + 1, evidence: seq },
            },
          ),
        );
        break;
      case "msg": {
        // Fold: first position is the order, the last write is the evidence.
        const id = str(o, "id");
        const prev = this.msgs.get(id);
        if (prev === undefined)
          this.msgs.set(id, { order: seq, evidence: seq, text: str(o, "text") });
        else {
          dispositions.push({ sourceSequence: prev.evidence, kind: "superseded", into: seq });
          this.msgs.set(id, { order: prev.order, evidence: seq, text: str(o, "text") });
        }
        break;
      }
      case "warn":
        warnings.push({
          code: "unmapped-field",
          severity: "info",
          sourceSequence: seq,
          detail: { field: "x" },
        });
        dispositions.push({ sourceSequence: seq, kind: "control", into: null });
        break;
      case "bad-warn":
        warnings.push({ code: "nope" as never, severity: "info", sourceSequence: seq, detail: {} });
        dispositions.push({ sourceSequence: seq, kind: "control", into: null });
        break;
      case "into-next":
        dispositions.push({ sourceSequence: seq, kind: "control", into: seq + 1 });
        break;
      case "bad-disp":
        dispositions.push({ sourceSequence: seq, kind: "control", into: 9999 });
        break;
      case "unknown-draft":
        drafts.push(
          base(o, "source.unknown", "runtime", "runtime", {
            nativeType: str(o, "t"),
            topLevelKeys: ["forged"],
            recordSha256: sha256Hex(new Uint8Array(1)),
          }),
        );
        break;
      default:
        // Unrecognized: no draft; the core accounts for the record as source.unknown.
        break;
    }
    return { drafts, warnings, dispositions };
  }

  end() {
    if (this.endThrows) throw new Error("end boom");
    const drafts: DraftEvent[] = [];
    for (const [id, m] of this.msgs) {
      drafts.push({
        kind: "message.observed",
        providerVersion: "9.9.9",
        time: normalizeTimestamp(null),
        actor: { role: "agent" },
        status: "none",
        payload: {
          role: "assistant",
          channel: "text",
          content: this.ref(m.text),
        },
        completeness: {
          timestamp: { state: "absent", reason: "missing-in-record" },
          actor: captured,
          content: captured,
          internalReasoning: { state: "unavailable" },
        },
        attributes: {},
        pointer: "/text",
        actorKey: "root",
        recordRef: { order: m.order, evidence: m.evidence },
        correlation: { anchor: `msg:${id}` },
      } as DraftEvent);
    }
    drafts.push(...this.endExtra);
    return { drafts, warnings: [] as AdapterWarning[] };
  }
}

export function refRegistration(opts: RefOptions = {}): AdapterRegistration {
  return {
    adapter: {
      manifest: {
        id: "opencode.reference-log",
        adapterVersion: "0.0.1",
        provider: "opencode",
        sourceKind: "opencode.reference-log",
        sourceStability: "undocumented",
        captureModes: ["import-file"],
        testedProviderVersions: opts.testedVersions ?? [],
        capabilities: UNKNOWN_CAPS,
        framing: { kind: "jsonl" },
        experimental: true,
        attributeKeys: opts.attributeKeys ?? ["opencode.cwd"],
      },
      detect(sample): DetectResult {
        const first = sample[0];
        const v = first?.parse.ok === true ? asObj(first.parse.value) : {};
        const ok = v["t"] === "session";
        return {
          verdict: ok ? "match" : "no-match",
          providerVersionSeen: typeof v["v"] === "string" ? v["v"] : null,
          nativeSessionId: typeof v["id"] === "string" ? v["id"] : null,
          reasons: [],
        };
      },
      createParser: (ctx) => new RefParser(ctx),
    },
    discovery: {
      roots: [{ base: "home", segments: [".reference"] }],
      fileNamePattern: "^.*\\.ref\\.jsonl$",
    },
  };
}

/** json-document variant: envelope record 0 plus `/messages` elements. */
export function docRegistration(): AdapterRegistration {
  const reg = refRegistration();
  return {
    adapter: {
      manifest: {
        ...reg.adapter.manifest,
        framing: { kind: "json-document", recordArrays: ["/messages"] },
      },
      detect: (sample) => {
        const env = sample[0];
        const v = env?.parse.ok === true ? asObj(env.parse.value) : {};
        const ok = typeof v["id"] === "string";
        return {
          verdict: ok ? "match" : "no-match",
          providerVersionSeen: "9.9.9",
          nativeSessionId: ok ? str(v, "id") : null,
          reasons: [],
        };
      },
      createParser: () => ({
        push(record: FramedRecord) {
          if (!record.parse.ok) return { drafts: [], warnings: [] };
          const o = record.parse.value as Obj;
          if (record.sourceSequence === 0) {
            return {
              drafts: [
                base(o, "session.started", "runtime", "runtime", {
                  nativeSessionId: str(o, "id"),
                  trigger: "startup",
                }),
              ],
              warnings: [],
            };
          }
          return {
            drafts: [
              base(
                o,
                "message.observed",
                "user",
                "user",
                {
                  role: "user",
                  channel: "text",
                  content: makeContentRef(str(o, "text")),
                },
                {
                  pointer: "/text",
                  completeness: {
                    timestamp: { state: "absent", reason: "missing-in-record" },
                    actor: captured,
                    content: captured,
                    internalReasoning: { state: "unavailable" },
                  },
                },
              ),
            ],
            warnings: [],
          };
        },
        end: () => ({ drafts: [], warnings: [] }),
      }),
    },
    discovery: reg.discovery,
  };
}

export const SMALL = { ...DEFAULT_BOUNDS };
