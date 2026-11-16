import type {
  InputAnyValue,
  InputKeyValue,
  InputLogRecord,
  InputSpan,
  PolicyInputLogs,
  PolicyInputTraces,
} from "../src/index.js";

import { type IdentityValue, identityOfAdr0002 } from "../src/index.js";

/** An unmasked identity (as an ADR-0002 ID would be). */
export const id = (v: string): IdentityValue => identityOfAdr0002(v) as IdentityValue;

export const PRJ = "prj_00000000000000000000000000000001";
export const PRJ2 = "prj_00000000000000000000000000000002";
export const TRACE = "5b8efff798038103d269b633813fc60c";
export const SHA = "a".repeat(64);

export const s = (value: string): InputAnyValue => ({ kind: "string", value });
export const n = (value: bigint): InputAnyValue => ({ kind: "int", value });
export const d = (value: number): InputAnyValue => ({ kind: "double", value });
export const b = (value: boolean): InputAnyValue => ({ kind: "bool", value });
export const bytes = (...value: number[]): InputAnyValue => ({
  kind: "bytes",
  value: Uint8Array.from(value),
});
export const arr = (...values: InputAnyValue[]): InputAnyValue => ({ kind: "array", values });
export const kvs = (...values: InputKeyValue[]): InputAnyValue => ({ kind: "kvlist", values });
export const kv = (key: string, value: InputAnyValue): InputKeyValue => ({ key, value });

export function span(over: Partial<InputSpan> = {}): InputSpan {
  return {
    traceId: TRACE,
    spanId: "00f067aa0ba902b7",
    parentSpanId: null,
    traceState: "",
    flags: 0,
    name: "x",
    kind: 0,
    startTimeUnixNano: 1n,
    endTimeUnixNano: 2n,
    attributes: [],
    droppedAttributesCount: 0,
    events: [],
    droppedEventsCount: 0,
    links: [],
    droppedLinksCount: 0,
    status: { code: 0, message: "" },
    path: "/resourceSpans/0/scopeSpans/0/spans/0",
    recordSha256: SHA,
    ...over,
  };
}

export function log(over: Partial<InputLogRecord> = {}): InputLogRecord {
  return {
    timeUnixNano: 1n,
    observedTimeUnixNano: 0n,
    severityNumber: 0,
    severityText: "",
    body: null,
    attributes: [],
    droppedAttributesCount: 0,
    flags: 0,
    traceId: null,
    spanId: null,
    eventName: "",
    path: "/resourceLogs/0/scopeLogs/0/logRecords/0",
    recordSha256: SHA,
    ...over,
  };
}

export interface GroupOpts {
  readonly resource?: readonly InputKeyValue[];
  readonly scope?: {
    readonly name?: string;
    readonly version?: string;
    readonly attributes?: readonly InputKeyValue[];
  };
  readonly resourceSchemaUrl?: string;
  readonly scopeSchemaUrl?: string;
}

export function traces(spans: readonly InputSpan[], o: GroupOpts = {}): PolicyInputTraces {
  return {
    signal: "traces",
    resourceSpans: [
      {
        path: "/resourceSpans/0",
        resource: { attributes: o.resource ?? [], droppedAttributesCount: 0 },
        resourceSha256: SHA,
        schemaUrl: o.resourceSchemaUrl ?? "",
        scopeSpans: [
          {
            path: "/resourceSpans/0/scopeSpans/0",
            scope: {
              name: o.scope?.name ?? "",
              version: o.scope?.version ?? "",
              attributes: o.scope?.attributes ?? [],
              droppedAttributesCount: 0,
            },
            scopeSha256: SHA,
            schemaUrl: o.scopeSchemaUrl ?? "",
            spans,
          },
        ],
      },
    ],
    rejected: [],
    warnings: [],
  };
}

export function logs(records: readonly InputLogRecord[], o: GroupOpts = {}): PolicyInputLogs {
  return {
    signal: "logs",
    resourceLogs: [
      {
        path: "/resourceLogs/0",
        resource: { attributes: o.resource ?? [], droppedAttributesCount: 0 },
        resourceSha256: SHA,
        schemaUrl: o.resourceSchemaUrl ?? "",
        scopeLogs: [
          {
            path: "/resourceLogs/0/scopeLogs/0",
            scope: {
              name: o.scope?.name ?? "",
              version: o.scope?.version ?? "",
              attributes: o.scope?.attributes ?? [],
              droppedAttributesCount: 0,
            },
            scopeSha256: SHA,
            schemaUrl: o.scopeSchemaUrl ?? "",
            logRecords: records,
          },
        ],
      },
    ],
    rejected: [],
    warnings: [],
  };
}

/** JSON text of any policy output (bigint as decimal string, bytes as an array). */
export function dump(v: unknown): string {
  return JSON.stringify(v, (_k, x: unknown) => (typeof x === "bigint" ? x.toString() : x));
}

/** Every kept-text value and every attribute key in a policy output, depth first. */
export function allStrings(v: unknown, out: string[] = []): string[] {
  if (Array.isArray(v)) {
    for (const x of v) allStrings(x, out);
  } else if (typeof v === "object" && v !== null) {
    const o = v as Record<string, unknown>;
    if (o["kind"] === "text" && typeof o["value"] === "string") out.push(o["value"]);
    if (typeof o["key"] === "string" && "keyAltered" in o) out.push(o["key"]);
    for (const x of Object.values(o)) allStrings(x, out);
  }
  return out;
}
