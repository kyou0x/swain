/**
 * Gemini chat fold engine (SPEC-002 section 3.4 "Gemini rules"), shared by the JSONL and the
 * legacy single-document adapters.
 *
 * Source semantics: docs/research/FORMAT-gemini.md sections 2 and 3 (v0.68.0, source-derived,
 * never checked against a real session file).
 *
 * Everything is emitted from `end()` with a `recordRef`: a message's `order` is the record of
 * its first appearance, its `evidence` the record of its last full write (or of the `$patch`
 * that supplied the value). Records that do not produce an event are declared as dispositions.
 */
import type {
  AdapterOutput,
  AdapterWarning,
  Attributes,
  Completeness,
  DraftEvent,
  EventTime,
  FramedRecord,
  JsonValue,
  ParseContext,
  RecordDisposition,
} from "@swain/core";
import {
  boundedId,
  count,
  facets,
  isArr,
  isObj,
  mk,
  nativeKey,
  normTime,
  type Obj,
  own,
  ownStr,
  ptr,
  Refs,
  refJson,
  topKeys,
  truncBytes,
  Unmapped,
  unknownDraft,
  utf8Len,
} from "./util.js";

export const MESSAGE_TYPES = ["user", "gemini", "info", "error", "warning"] as const;
const TOOL_STATUS_ATTR = [
  "success",
  "error",
  "cancelled",
  "validating",
  "scheduled",
  "executing",
  "awaiting_approval",
] as const;

/** Builtin names listed in FORMAT-gemini.md section 5. Anything else is `unknown` (MCP naming UNKNOWN). */
const BUILTIN_TOOLS: ReadonlySet<string> = new Set([
  "run_shell_command",
  "replace",
  "write_file",
  "read_file",
  "read_many_files",
  "list_directory",
  "glob",
  "grep_search",
  "google_web_search",
  "web_fetch",
  "write_todos",
  "ask_user",
  "activate_skill",
  "get_internal_docs",
  "enter_plan_mode",
  "exit_plan_mode",
  "update_topic",
  "complete_task",
  "read_mcp_resource",
  "list_mcp_resources",
]);

/** Write-type tools whose successful result supports `file.changed` (section 5 of the research). */
const WRITE_TOOLS: ReadonlySet<string> = new Set(["write_file", "replace"]);

interface Patched {
  readonly seq: number;
  readonly ptr: string;
  readonly value: JsonValue;
}

interface Entry {
  readonly id: string;
  readonly order: number;
  readonly sha: string;
  writes: number[];
  last: number;
  lastSha: string;
  msg: Obj;
  removed: boolean;
  contentPatch: Patched | undefined;
  resultPatches: Map<string, Patched>;
}

interface CPart {
  readonly v: JsonValue;
  readonly ptr: string;
}

interface CView {
  readonly value: JsonValue | undefined;
  readonly base: string;
  readonly seq: number;
  readonly parts: readonly CPart[];
}

function view(value: JsonValue | undefined, base: string, seq: number): CView {
  if (isArr(value)) {
    return { value, base, seq, parts: value.map((v, i) => ({ v, ptr: `${base}/${i}` })) };
  }
  if (isObj(value)) return { value, base, seq, parts: [{ v: value, ptr: base }] };
  return { value, base, seq, parts: [] };
}

function isThought(p: JsonValue): boolean {
  return isObj(p) && own(p, "thought") === true && typeof own(p, "text") === "string";
}

function textParts(cv: CView): string[] {
  const out: string[] = [];
  for (const p of cv.parts) {
    if (isObj(p.v) && !isThought(p.v)) {
      const t = own(p.v, "text");
      if (typeof t === "string") out.push(t);
    }
  }
  return out;
}

function responseOf(v: JsonValue | undefined): Obj | undefined {
  const parts = isArr(v) ? v : v === undefined ? [] : [v];
  for (const p of parts) {
    if (isObj(p)) {
      const fr = own(p, "functionResponse");
      if (isObj(fr)) {
        const r = own(fr, "response");
        if (isObj(r)) return r;
      }
    }
  }
  return undefined;
}

function isCarrier(cv: CView): boolean {
  return (
    cv.parts.length > 0 && cv.parts.every((p) => isObj(p.v) && isObj(own(p.v, "functionResponse")))
  );
}

function toolStatusAttr(s: string | undefined): string | null {
  if (s === undefined) return null;
  return (TOOL_STATUS_ATTR as readonly string[]).includes(s) ? s : "other";
}

interface ToolSrc {
  readonly id: string | null;
  readonly name: string;
  readonly args: JsonValue | undefined;
  readonly ptr: string;
  readonly status: string | undefined;
  readonly result: JsonValue | undefined;
  readonly hasResult: boolean;
  readonly resultSeq: number;
  readonly resultPtr: string;
  readonly callTime: EventTime;
  readonly display: JsonValue | undefined;
  readonly displayPtr: string;
  readonly reqTime: EventTime;
  readonly reqSeq: number;
}

interface ResultSrc {
  readonly seq: number;
  readonly ptr: string;
  readonly raw: JsonValue | undefined;
  readonly response: Obj | undefined;
  readonly time: EventTime;
  readonly status: "success" | "error" | "cancelled" | "unstated";
}

interface Carrier {
  readonly entry: Entry;
  readonly seq: number;
  readonly ptr: string;
  readonly response: JsonValue | undefined;
  readonly name: string | undefined;
}

function validPath(p: JsonValue | undefined): string | null {
  if (typeof p !== "string" || p.length === 0 || p.length > 4096) return null;
  if (!p.isWellFormed() || p.includes("\u0000") || utf8Len(p) > 4096) return null;
  return p;
}

export class GeminiFold {
  readonly #ctx: ParseContext;
  readonly #version: string | null;
  readonly #legacy: boolean;
  readonly #refs: Refs;
  readonly #unmapped = new Unmapped();
  readonly #list: Entry[] = [];
  readonly #byId = new Map<string, Entry>();
  readonly #rewound: Entry[] = [];
  readonly #controls: { seq: number; target: Entry | null }[] = [];
  readonly #metaSeqs: number[] = [];
  readonly #warnings: AdapterWarning[] = [];
  #header: { seq: number; rec: Obj } | null = null;
  #overflowWarned = false;

  constructor(ctx: ParseContext, legacy: boolean) {
    this.#ctx = ctx;
    this.#version = ctx.providerVersionSeen;
    this.#legacy = legacy;
    this.#refs = new Refs(ctx);
  }

  // ---- push side

  /** Classification order of the CLI (research section 2): first match wins. */
  pushJsonl(record: FramedRecord): AdapterOutput {
    if (!record.parse.ok) return { drafts: [], warnings: [] };
    const v = record.parse.value;
    const seq = record.sourceSequence;
    if (!isObj(v)) return this.#unknownRecord(record, v, null);
    const rewind = own(v, "$rewindTo");
    const patch = own(v, "$patch");
    const set = own(v, "$set");
    if (typeof rewind === "string") {
      this.#rewind(seq, rewind);
    } else if (isObj(patch)) {
      this.#patch(seq, patch);
    } else if (typeof own(v, "id") === "string") {
      this.#message(seq, record.sha256, v);
    } else if (isObj(set)) {
      if (Object.hasOwn(set, "messages")) {
        // Deprecated checkpoint: the CLI replaces all messages from it. Not folded (documented gap).
        this.#unmapped.note("gm.set-messages-checkpoint");
        return this.#unknownRecord(record, v, "$set");
      }
      this.#metaSeqs.push(seq);
    } else if (
      typeof own(v, "sessionId") === "string" &&
      typeof own(v, "projectHash") === "string"
    ) {
      if (this.#header === null) this.#header = { seq, rec: v };
      else this.#metaSeqs.push(seq);
    } else {
      const t = own(v, "type");
      return this.#unknownRecord(record, v, typeof t === "string" ? t : null);
    }
    return { drafts: [], warnings: [] };
  }

  /** Legacy `ConversationRecord`: record 0 is the envelope, records 1..N are `/messages` elements. */
  pushLegacy(record: FramedRecord): AdapterOutput {
    if (!record.parse.ok) return { drafts: [], warnings: [] };
    const v = record.parse.value;
    if (record.sourceSequence === 0) {
      if (isObj(v)) {
        this.#header = { seq: 0, rec: v };
        return { drafts: [], warnings: [] };
      }
      return this.#unknownRecord(record, v, null);
    }
    if (!isObj(v)) return this.#unknownRecord(record, v, null);
    this.#message(record.sourceSequence, record.sha256, v);
    return { drafts: [], warnings: [] };
  }

  #unknownRecord(record: FramedRecord, v: JsonValue, nativeType: string | null): AdapterOutput {
    const seq = record.sourceSequence;
    const draft = unknownDraft(v, nativeType, record.sha256, {
      time: normTime(undefined),
      role: "unknown",
      actorKey: "root",
      order: seq,
      evidence: seq,
      pointer: "",
      version: this.#version,
    });
    return {
      drafts: [draft],
      warnings: [
        {
          code: "unknown-record-type",
          severity: "warn",
          sourceSequence: seq,
          detail: { reasonCode: "gm.unknown-record" },
        },
      ],
    };
  }

  #message(seq: number, sha: string, rec: Obj): void {
    const idRaw = own(rec, "id");
    const id = typeof idRaw === "string" ? idRaw : "";
    const existing = this.#legacy ? undefined : this.#byId.get(id);
    if (existing !== undefined) {
      existing.writes.push(seq);
      existing.last = seq;
      existing.lastSha = sha;
      existing.msg = rec;
      // A full re-write replaces the message wholesale, including earlier patches.
      existing.contentPatch = undefined;
      existing.resultPatches = new Map();
      return;
    }
    const entry: Entry = {
      id,
      order: seq,
      sha,
      writes: [seq],
      last: seq,
      lastSha: sha,
      msg: rec,
      removed: false,
      contentPatch: undefined,
      resultPatches: new Map(),
    };
    this.#list.push(entry);
    if (this.#legacy) return;
    if (this.#byId.size < this.#ctx.bounds.maxOpenCorrelations) {
      this.#byId.set(id, entry);
    } else if (!this.#overflowWarned) {
      // Fold state is bounded (SPEC-002 section 3.4): stop folding, map the rest unfolded.
      this.#overflowWarned = true;
      this.#warnings.push({
        code: "bounds-reached",
        severity: "warn",
        sourceSequence: seq,
        detail: { reasonCode: "gm.fold-state-full", limit: this.#ctx.bounds.maxOpenCorrelations },
      });
    }
  }

  #remove(e: Entry): void {
    if (e.removed) return;
    e.removed = true;
    if (this.#byId.get(e.id) === e) this.#byId.delete(e.id);
    this.#rewound.push(e);
  }

  #rewind(seq: number, id: string): void {
    const e = this.#byId.get(id);
    this.#controls.push({ seq, target: null });
    if (e === undefined) {
      // The loader clears every message when the id is unknown (research section 2.4).
      this.#warnings.push({
        code: "unmapped-field",
        severity: "warn",
        sourceSequence: seq,
        detail: { reasonCode: "gm.rewind-unknown-id" },
      });
      for (const x of this.#list) this.#remove(x);
      this.#list.length = 0;
      return;
    }
    const idx = this.#list.lastIndexOf(e);
    for (let i = idx; i < this.#list.length; i++) {
      const x = this.#list[i];
      if (x !== undefined) this.#remove(x);
    }
    this.#list.length = idx;
  }

  #patch(seq: number, p: Obj): void {
    const rec = { seq, target: null as Entry | null };
    this.#controls.push(rec);
    if (typeof own(p, "id") === "string") this.#patchItem(rec, p, "/$patch");
    const updates = own(p, "updates");
    if (isArr(updates)) {
      for (let i = 0; i < updates.length; i++) {
        const u = updates[i];
        if (isObj(u)) this.#patchItem(rec, u, ptr("$patch", "updates", i));
      }
    }
    const remove = own(p, "removeIds");
    if (isArr(remove)) {
      for (const rid of remove) {
        if (typeof rid !== "string") continue;
        const t = this.#byId.get(rid);
        if (t !== undefined) this.#remove(t);
        else this.#unmapped.note("gm.patch-unknown-id");
      }
    }
    if (isArr(own(p, "orderIds"))) this.#unmapped.note("gm.patch-order-ids");
  }

  #patchItem(rec: { seq: number; target: Entry | null }, item: Obj, base: string): void {
    const id = own(item, "id");
    const t = typeof id === "string" ? this.#byId.get(id) : undefined;
    if (t === undefined) {
      this.#unmapped.note("gm.patch-unknown-id");
      return;
    }
    rec.target ??= t;
    if (Object.hasOwn(item, "content")) {
      t.contentPatch = {
        seq: rec.seq,
        ptr: `${base}/content`,
        value: item["content"] as JsonValue,
      };
    }
    const calls = own(item, "toolCalls");
    const existing = own(t.msg, "toolCalls");
    if (isArr(calls) && ownStr(t.msg, "type") === "gemini" && isArr(existing)) {
      for (let i = 0; i < calls.length; i++) {
        const c = calls[i];
        if (isObj(c) && typeof own(c, "id") === "string" && Object.hasOwn(c, "result")) {
          t.resultPatches.set(own(c, "id") as string, {
            seq: rec.seq,
            ptr: `${base}/toolCalls/${i}/result`,
            value: c["result"] as JsonValue,
          });
        }
      }
    }
  }

  // ---- end side

  end(): AdapterOutput {
    const alive = this.#list.filter((e) => !e.removed);
    const carriers = new Map<string, Carrier>();
    const requested = new Set<string>();
    for (const e of alive) {
      const cv = this.#content(e);
      if (ownStr(e.msg, "type") === "user" && isCarrier(cv)) {
        cv.parts.forEach((p, i) => {
          const fr = isObj(p.v) ? own(p.v, "functionResponse") : undefined;
          if (!isObj(fr)) return;
          const id = nativeKey(own(fr, "id"));
          if (id !== null && !carriers.has(id)) {
            carriers.set(id, {
              entry: e,
              seq: cv.seq,
              ptr: `${cv.parts[i]?.ptr ?? cv.base}/functionResponse`,
              response: own(fr, "response"),
              name: ownStr(fr, "name"),
            });
          }
        });
      } else if (ownStr(e.msg, "type") === "gemini") {
        const calls = own(e.msg, "toolCalls");
        if (isArr(calls)) {
          for (const c of calls) {
            const id = isObj(c) ? nativeKey(own(c, "id")) : null;
            if (id !== null) requested.add(id);
          }
        }
        for (const p of cv.parts) {
          const fc = isObj(p.v) ? own(p.v, "functionCall") : undefined;
          const id = isObj(fc) ? nativeKey(own(fc, "id")) : null;
          if (id !== null) requested.add(id);
        }
      }
    }

    this.noteHeaderFields();
    const drafts: DraftEvent[] = [];
    const local: AdapterWarning[] = [];
    const perEntry = new Map<Entry, DraftEvent[]>();
    if (this.#header !== null) drafts.push(this.#sessionStarted(this.#header));
    const cap = this.#ctx.bounds.maxDraftsPerRecord;
    for (const e of alive) {
      let ds = this.#mapEntry(e, carriers, requested);
      if (ds.length > cap) {
        local.push({
          code: "bounds-reached",
          severity: "warn",
          sourceSequence: e.order,
          detail: { reasonCode: "gm.drafts-capped", limit: cap },
        });
        ds = ds.slice(0, cap);
      }
      perEntry.set(e, ds);
      for (const d of ds) drafts.push(d);
    }

    const used = new Set<number>();
    for (const d of drafts) {
      if (d.recordRef !== undefined) {
        used.add(d.recordRef.order);
        used.add(d.recordRef.evidence);
      }
    }

    const headerSeq = this.#header?.seq ?? null;
    const dispositions: RecordDisposition[] = [];
    const disp = (sourceSequence: number, kind: RecordDisposition["kind"], into: number | null) => {
      dispositions.push({ sourceSequence, kind, into });
    };
    for (const e of alive) {
      const ds = perEntry.get(e) ?? [];
      const carrierTarget = (): number | null => {
        const cv = this.#content(e);
        for (const p of cv.parts) {
          const fr = isObj(p.v) ? own(p.v, "functionResponse") : undefined;
          const id = isObj(fr) ? nativeKey(own(fr, "id")) : null;
          if (id === null) continue;
          for (const o of alive) {
            if (o !== e && this.#hasCall(o, id)) return o.order;
          }
        }
        return null;
      };
      if (ds.length === 0 && !used.has(e.order)) {
        if (ownStr(e.msg, "type") === "user" && isCarrier(this.#content(e))) {
          disp(e.order, "superseded", carrierTarget());
        } else {
          disp(e.order, "metadata", headerSeq);
        }
      }
      for (const w of e.writes) {
        if (w === e.order) continue;
        if (w === e.last && used.has(w)) continue;
        if (used.has(w)) continue;
        disp(w, "superseded", e.order);
      }
    }
    for (const e of this.#rewound) {
      for (const w of e.writes) disp(w, "rewound", null);
    }
    for (const c of this.#controls) {
      if (used.has(c.seq)) continue;
      disp(c.seq, "control", c.target !== null && !c.target.removed ? c.target.order : null);
    }
    for (const m of this.#metaSeqs) disp(m, "metadata", headerSeq);

    const warnings: AdapterWarning[] = [...this.#warnings, ...local];
    for (const [code, n] of this.#unmapped.entries()) {
      warnings.push({
        code: "unmapped-field",
        severity: "info",
        sourceSequence: null,
        detail: { fieldCode: code, occurrences: n },
      });
    }
    dispositions.sort((a, b) => a.sourceSequence - b.sourceSequence);
    return { drafts, warnings, dispositions };
  }

  #hasCall(e: Entry, id: string): boolean {
    if (ownStr(e.msg, "type") !== "gemini") return false;
    const calls = own(e.msg, "toolCalls");
    if (isArr(calls)) {
      for (const c of calls) {
        if (isObj(c) && own(c, "id") === id) return true;
      }
    }
    for (const p of this.#content(e).parts) {
      const fc = isObj(p.v) ? own(p.v, "functionCall") : undefined;
      if (isObj(fc) && own(fc, "id") === id) return true;
    }
    return false;
  }

  #content(e: Entry): CView {
    const p = e.contentPatch;
    return p === undefined
      ? view(own(e.msg, "content"), "/content", e.last)
      : view(p.value, p.ptr, p.seq);
  }

  #sessionStarted(h: { seq: number; rec: Obj }): DraftEvent {
    const time = normTime(own(h.rec, "startTime"));
    return mk(
      "session.started",
      "none",
      { nativeSessionId: boundedId(own(h.rec, "sessionId")), trigger: "unknown" },
      {
        time,
        role: "runtime",
        actorKey: "runtime",
        order: h.seq,
        evidence: h.seq,
        pointer: "",
        version: this.#version,
        nativeSessionId: boundedId(own(h.rec, "sessionId")),
        completeness: facets(time, { state: "captured" }),
      },
    );
  }

  #contentRef(cv: CView): ReturnType<Refs["make"]> | undefined {
    if (cv.value === undefined || cv.value === null) return undefined;
    if (typeof cv.value === "string") return this.#refs.make(cv.value);
    const hasText = cv.parts.some(
      (p) => isObj(p.v) && !isThought(p.v) && typeof own(p.v, "text") === "string",
    );
    if (hasText) return this.#refs.make(textParts(cv).join(""));
    return this.#refs.make(cv.value);
  }

  #mapEntry(e: Entry, carriers: Map<string, Carrier>, requested: Set<string>): DraftEvent[] {
    const msg = e.msg;
    const type = ownStr(msg, "type");
    const ts = normTime(own(msg, "timestamp"));
    const cv = this.#content(e);
    const attr = (extra: Attributes = {}): Attributes => ({
      ...(type === undefined ? {} : { "gemini-cli.message_type": truncBytes(type, 64) }),
      ...extra,
    });
    const unknown = (nativeType: string | null): DraftEvent[] => [
      unknownDraft(msg, nativeType, e.lastSha, {
        time: ts,
        role: "unknown",
        actorKey: "root",
        order: e.order,
        evidence: e.last,
        pointer: "",
        version: this.#version,
      }),
    ];
    if (type === undefined || !(MESSAGE_TYPES as readonly string[]).includes(type)) {
      this.#warnings.push({
        code: "unknown-record-type",
        severity: "warn",
        sourceSequence: e.order,
        detail: { reasonCode: "gm.unknown-message-type" },
      });
      return unknown(type ?? null);
    }
    this.#noteMessageFields(msg);
    const ref = this.#contentRef(cv);

    if (type === "user") {
      if (isCarrier(cv)) return this.#carrierDrafts(e, cv, ts, requested);
      const content: Completeness =
        ref === undefined
          ? { content: { state: "absent", reason: "missing-in-record" } }
          : { content: { state: "captured" } };
      return [
        mk(
          "turn.started",
          "none",
          { prompt: ref === undefined ? null : refJson(ref) },
          {
            time: ts,
            role: "user",
            actorKey: "user",
            order: e.order,
            evidence: cv.seq,
            pointer: cv.base,
            version: this.#version,
            attributes: attr(),
            completeness: facets(ts, { state: "captured" }, content),
          },
        ),
      ];
    }

    if (type !== "gemini") {
      if (ref === undefined || ref === null) return unknown(type);
      return [
        mk(
          "message.observed",
          "none",
          { role: "system", channel: "notification", content: refJson(ref) },
          {
            time: ts,
            role: "runtime",
            actorKey: "runtime",
            order: e.order,
            evidence: cv.seq,
            pointer: cv.base,
            version: this.#version,
            attributes: attr(),
            completeness: facets(
              ts,
              { state: "captured" },
              {
                content: { state: "captured" },
                internalReasoning: { state: "unavailable", reason: "provider-does-not-expose" },
              },
            ),
          },
        ),
      ];
    }

    // ---- gemini (model) message
    const out: DraftEvent[] = [];
    const agentActor = { state: "unknown" } as const;
    const reasoning = (
      text: JsonValue,
      pointer: string,
      evidence: number,
      time: EventTime,
      extra: Attributes,
    ): void => {
      const r = this.#refs.make(text);
      if (r === null) return;
      out.push(
        mk(
          "message.observed",
          "none",
          { role: "assistant", channel: "reasoning", content: refJson(r) },
          {
            time,
            role: "agent",
            actorKey: "root",
            order: e.order,
            evidence,
            pointer,
            version: this.#version,
            attributes: attr(extra),
            completeness: facets(time, agentActor, {
              content: { state: "captured" },
              // Provider-exposed reasoning text only; never hidden chain-of-thought.
              internalReasoning: { state: "unavailable", reason: "provider-does-not-expose" },
            }),
          },
        ),
      );
    };

    const thoughts = own(msg, "thoughts");
    if (isArr(thoughts)) {
      thoughts.forEach((th, i) => {
        if (
          !isObj(th) ||
          (typeof own(th, "subject") !== "string" && typeof own(th, "description") !== "string")
        ) {
          this.#unmapped.note("gm.thought-malformed");
          return;
        }
        const tt = Object.hasOwn(th, "timestamp") ? normTime(own(th, "timestamp")) : ts;
        reasoning(
          { subject: ownStr(th, "subject") ?? "", description: ownStr(th, "description") ?? "" },
          ptr("thoughts", i),
          e.last,
          tt,
          { "gemini-cli.thought_source": "summary", "gemini-cli.thought_index": i },
        );
      });
    }
    for (const p of cv.parts) {
      if (isObj(p.v) && isThought(p.v)) {
        reasoning(own(p.v, "text") as JsonValue, p.ptr, cv.seq, ts, {
          "gemini-cli.thought_source": "part",
        });
      }
    }

    const hasContent =
      typeof cv.value === "string" ? cv.value.length > 0 : textParts(cv).join("").length > 0;
    if (hasContent && ref !== undefined && ref !== null) {
      out.push(
        mk(
          "message.observed",
          "none",
          { role: "assistant", channel: "text", content: refJson(ref) },
          {
            time: ts,
            role: "agent",
            actorKey: "root",
            order: e.order,
            evidence: cv.seq,
            pointer: cv.base,
            version: this.#version,
            attributes: attr(),
            completeness: facets(ts, agentActor, {
              content: { state: "captured" },
              internalReasoning: { state: "unavailable", reason: "provider-does-not-expose" },
            }),
          },
        ),
      );
    }

    const calls = own(msg, "toolCalls");
    const callIds = new Set<string>();
    if (isArr(calls)) {
      calls.forEach((c, i) => {
        if (!isObj(c) || typeof own(c, "name") !== "string") {
          out.push(
            unknownDraft(c, null, e.lastSha, {
              time: ts,
              role: "agent",
              actorKey: "root",
              order: e.order,
              evidence: e.last,
              pointer: ptr("toolCalls", i),
              version: this.#version,
            }),
          );
          return;
        }
        const id = nativeKey(own(c, "id"));
        if (id !== null) callIds.add(id);
        const patched = id === null ? undefined : e.resultPatches.get(id);
        const resultPtr = patched?.ptr ?? ptr("toolCalls", i, "result");
        const hasResult = patched !== undefined || Object.hasOwn(c, "result");
        this.#toolEvents(
          e,
          {
            id,
            name: own(c, "name") as string,
            args: own(c, "args"),
            ptr: ptr("toolCalls", i),
            status: ownStr(c, "status"),
            result: patched !== undefined ? patched.value : own(c, "result"),
            hasResult,
            resultSeq: patched?.seq ?? e.last,
            resultPtr,
            callTime: Object.hasOwn(c, "timestamp") ? normTime(own(c, "timestamp")) : ts,
            display: own(c, "resultDisplay"),
            displayPtr: ptr("toolCalls", i, "resultDisplay"),
            reqTime: ts,
            reqSeq: e.last,
          },
          carriers,
          out,
        );
        this.#noteCallFields(c);
      });
    }
    cv.parts.forEach((p) => {
      const fc = isObj(p.v) ? own(p.v, "functionCall") : undefined;
      if (!isObj(fc) || typeof own(fc, "name") !== "string") return;
      const id = nativeKey(own(fc, "id"));
      if (id !== null && callIds.has(id)) return;
      this.#toolEvents(
        e,
        {
          id,
          name: own(fc, "name") as string,
          args: own(fc, "args"),
          ptr: `${p.ptr}/functionCall`,
          status: undefined,
          result: undefined,
          hasResult: false,
          resultSeq: cv.seq,
          resultPtr: p.ptr,
          callTime: ts,
          display: undefined,
          displayPtr: "",
          reqTime: ts,
          reqSeq: cv.seq,
        },
        carriers,
        out,
      );
    });

    const tokens = own(msg, "tokens");
    const model = own(msg, "model");
    const modelStr = typeof model === "string" ? truncBytes(model, 256) : null;
    const tk = isObj(tokens) ? tokens : undefined;
    if (tk !== undefined || modelStr !== null) {
      const payload: { [key: string]: JsonValue } = { scope: "message", model: modelStr };
      const put = (k: string, v: JsonValue | undefined): void => {
        const n = count(v);
        if (n !== undefined) payload[k] = n;
      };
      if (tk !== undefined) {
        put("inputTokens", own(tk, "input"));
        put("outputTokens", own(tk, "output"));
        put("cachedInputTokens", own(tk, "cached"));
        put("reasoningOutputTokens", own(tk, "thoughts"));
        put("totalTokens", own(tk, "total"));
        if (Object.hasOwn(tk, "tool")) this.#unmapped.note("gm.tokens-tool");
      }
      const anyCount = Object.keys(payload).length > 2;
      out.push(
        mk("model.usage", "none", payload, {
          time: ts,
          role: "agent",
          actorKey: "root",
          order: e.order,
          evidence: e.last,
          pointer: tk === undefined ? "/model" : "/tokens",
          version: this.#version,
          attributes: attr(),
          completeness: facets(ts, agentActor, {
            model:
              modelStr === null
                ? { state: "absent", reason: "missing-in-record" }
                : { state: "captured" },
            tokens: anyCount
              ? { state: "captured" }
              : { state: "absent", reason: "missing-in-record" },
          }),
        }),
      );
    }
    return out;
  }

  #toolEvents(e: Entry, t: ToolSrc, carriers: Map<string, Carrier>, out: DraftEvent[]): void {
    const name = truncBytes(t.name, 256);
    const argsRef = isObj(t.args) ? this.#refs.make(t.args) : null;
    const stAttr = toolStatusAttr(t.status);
    out.push(
      mk(
        "tool.requested",
        "none",
        {
          toolCallId: t.id,
          toolName: name,
          toolNamespace: BUILTIN_TOOLS.has(t.name) ? "builtin" : "unknown",
          input: refJson(argsRef),
        },
        {
          time: t.reqTime,
          role: "agent",
          actorKey: "root",
          order: e.order,
          evidence: t.reqSeq,
          pointer: t.ptr,
          version: this.#version,
          attributes: {
            "gemini-cli.message_type": "gemini",
            ...(stAttr === null ? {} : { "gemini-cli.tool_status": stAttr }),
          },
          ...(t.id === null ? {} : { anchor: t.id }),
          completeness: facets(
            t.reqTime,
            { state: "unknown" },
            {
              inputs:
                argsRef !== null
                  ? { state: "captured" }
                  : t.args === undefined
                    ? { state: "absent", reason: "missing-in-record" }
                    : { state: "partial", reason: "malformed-value" },
              outputs: { state: "unknown" },
            },
          ),
        },
      ),
    );

    const terminal = t.status === "success" || t.status === "error" || t.status === "cancelled";
    const carrier = t.id === null ? undefined : carriers.get(t.id);
    if (terminal) {
      this.#resultDrafts(
        e,
        name,
        t.id,
        {
          seq: t.resultSeq,
          ptr: t.resultPtr,
          raw: t.hasResult ? t.result : undefined,
          response: responseOf(t.result),
          time: t.callTime,
          status: t.status as "success" | "error" | "cancelled",
        },
        out,
      );
    } else if (carrier !== undefined) {
      const resp = carrier.response;
      this.#resultDrafts(
        e,
        name,
        t.id,
        {
          seq: carrier.seq,
          ptr: carrier.ptr,
          raw: resp,
          response: isObj(resp) ? resp : undefined,
          time: normTime(own(carrier.entry.msg, "timestamp")),
          status: "unstated",
        },
        out,
      );
    } else {
      return;
    }
    if (t.status === "success" && WRITE_TOOLS.has(t.name)) this.#fileChanged(e, t, out);
  }

  #resultDrafts(e: Entry, name: string, id: string | null, s: ResultSrc, out: DraftEvent[]): void {
    const errText = s.response === undefined ? undefined : ownStr(s.response, "error");
    const outText = s.response === undefined ? undefined : ownStr(s.response, "output");
    const time = s.time.status === "missing" ? normTime(own(e.msg, "timestamp")) : s.time;
    const causality: Completeness =
      id === null
        ? { causality: { state: "absent", reason: "correlation-missing" } }
        : { causality: { state: "captured" } };
    const base = {
      time,
      role: "agent" as const,
      order: e.order,
      evidence: s.seq,
      pointer: s.ptr,
      version: this.#version,
      actorKey: "root",
      ...(id === null ? {} : { resultOf: id }),
    };
    const attributes: Attributes = {
      "gemini-cli.message_type": "gemini",
      ...(s.status === "unstated" ? {} : { "gemini-cli.tool_status": s.status }),
    };
    const failed = s.status === "error" || s.status === "cancelled" || errText !== undefined;
    if (failed) {
      const errVal: JsonValue | undefined = errText ?? s.raw;
      const errRef = errVal === undefined ? null : this.#refs.make(errVal);
      const interrupted = s.status === "cancelled";
      out.push(
        mk(
          "tool.failed",
          interrupted ? "interrupted" : "failure",
          {
            toolCallId: id,
            toolName: name,
            output: null,
            error: refJson(errRef),
            errorClass: interrupted ? "interrupted" : "error",
          },
          {
            ...base,
            attributes,
            completeness: facets(
              time,
              { state: "unknown" },
              {
                ...causality,
                inputs: { state: "unknown" },
                outputs:
                  errRef !== null
                    ? { state: "captured" }
                    : { state: "absent", reason: "missing-in-record" },
              },
            ),
          },
        ),
      );
      return;
    }
    const val: JsonValue | undefined = outText ?? s.raw;
    const ref = val === undefined ? null : this.#refs.make(val);
    out.push(
      mk(
        "tool.completed",
        s.status === "success" ? "success" : "unknown",
        { toolCallId: id, toolName: name, output: refJson(ref) },
        {
          ...base,
          attributes,
          completeness: facets(
            time,
            { state: "unknown" },
            {
              ...causality,
              inputs: { state: "unknown" },
              outputs:
                ref !== null
                  ? { state: "captured" }
                  : { state: "absent", reason: "missing-in-record" },
            },
          ),
        },
      ),
    );
  }

  /**
   * `file.changed` only for a successful write-type tool. A FileDiff in `resultDisplay` is
   * provider-reported; otherwise the path comes from the request arguments and the basis is
   * `derived-from-tool-result`. A request alone, an error or a cancellation never qualifies.
   */
  #fileChanged(e: Entry, t: ToolSrc, out: DraftEvent[]): void {
    const time = t.callTime.status === "missing" ? t.reqTime : t.callTime;
    const disp = t.display;
    let path: string | null = null;
    let basis: "provider-reported" | "derived-from-tool-result" = "derived-from-tool-result";
    let changeKind: "add" | "update" | "unknown" = t.name === "replace" ? "update" : "unknown";
    let diff: JsonValue = null;
    let pointer = t.ptr;
    if (isObj(disp) && validPath(own(disp, "filePath")) !== null) {
      path = validPath(own(disp, "filePath"));
      basis = "provider-reported";
      pointer = t.displayPtr;
      const isNew = own(disp, "isNewFile");
      const orig = own(disp, "originalContent");
      if (isNew === true || orig === null) changeKind = "add";
      else if (isNew === false || typeof orig === "string") changeKind = "update";
      else changeKind = "unknown";
      const fd = own(disp, "fileDiff");
      if (typeof fd === "string") diff = refJson(this.#refs.make(fd));
    } else if (isObj(t.args) && validPath(own(t.args, "file_path")) !== null) {
      path = validPath(own(t.args, "file_path"));
      pointer = `${t.ptr}/args/file_path`;
    }
    if (path === null) return;
    out.push(
      mk(
        "file.changed",
        "success",
        { path, changeKind, diff, viaToolCallId: t.id, basis },
        {
          time,
          role: "agent",
          actorKey: "root",
          order: e.order,
          evidence: t.resultSeq,
          pointer,
          version: this.#version,
          attributes: { "gemini-cli.message_type": "gemini", "gemini-cli.tool_status": "success" },
          completeness: facets(time, { state: "unknown" }),
        },
      ),
    );
  }

  #carrierDrafts(e: Entry, cv: CView, ts: EventTime, requested: Set<string>): DraftEvent[] {
    // A tool result also appears as a user message of functionResponse parts (research 3.1).
    // It is deduplicated against the matching call; only orphans yield events here.
    const out: DraftEvent[] = [];
    for (const p of cv.parts) {
      const fr = isObj(p.v) ? own(p.v, "functionResponse") : undefined;
      if (!isObj(fr)) continue;
      const id = nativeKey(own(fr, "id"));
      if (id !== null && requested.has(id)) continue;
      const nm = ownStr(fr, "name");
      const response = own(fr, "response");
      this.#resultDrafts(
        e,
        nm === undefined ? "" : truncBytes(nm, 256),
        id,
        {
          seq: cv.seq,
          ptr: `${p.ptr}/functionResponse`,
          raw: response,
          response: isObj(response) ? response : undefined,
          time: ts,
          status: "unstated",
        },
        out,
      );
    }
    return out;
  }

  #noteMessageFields(msg: Obj): void {
    if (Object.hasOwn(msg, "displayContent")) this.#unmapped.note("gm.display-content");
    for (const k of Object.keys(msg)) {
      if (
        ![
          "id",
          "timestamp",
          "type",
          "content",
          "displayContent",
          "toolCalls",
          "thoughts",
          "tokens",
          "model",
        ].includes(k)
      ) {
        this.#unmapped.note("gm.message-extra-key");
        break;
      }
    }
  }

  #noteCallFields(c: Obj): void {
    if (
      Object.hasOwn(c, "displayName") ||
      Object.hasOwn(c, "description") ||
      Object.hasOwn(c, "renderOutputAsMarkdown")
    ) {
      this.#unmapped.note("gm.tool-ui-fields");
    }
    if (Object.hasOwn(c, "agentId")) this.#unmapped.note("gm.tool-agent-id");
    const d = own(c, "resultDisplay");
    if (d !== undefined && !isObj(d)) this.#unmapped.note("gm.result-display");
  }

  /** Envelope or header fields that have no canonical home. */
  noteHeaderFields(): void {
    const h = this.#header?.rec;
    if (h === undefined) return;
    for (const k of ["summary", "memoryScratchpad", "directories", "kind", "lastUpdated"]) {
      if (Object.hasOwn(h, k)) this.#unmapped.note("gm.meta-fields");
    }
  }

  topKeysOf(v: JsonValue): string[] {
    return topKeys(v);
  }
}
