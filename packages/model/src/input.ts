/**
 * Structural mirror of the frozen decoded OTLP model (`@swain/otlp` `model.ts`, SPEC-003 N1.2).
 *
 * `@swain/model` may import only `@swain/core` (tools/policy-check.mjs profile), and `@swain/otlp`
 * already depends on `@swain/model`, so the applier cannot import the decoder's types. TypeScript
 * is structural: a `DecodedTraces` / `DecodedLogs` from `@swain/otlp` is assignable to
 * `PolicyInputTraces` / `PolicyInputLogs`. `packages/contract-tests` asserts that at compile time
 * and runs the real decoder output through the applier. Only fields the policy reads are listed;
 * extra fields on the real objects are ignored and never copied to the output.
 */

export type InputAnyValue =
  | { readonly kind: "string"; readonly value: string }
  | { readonly kind: "bool"; readonly value: boolean }
  | { readonly kind: "int"; readonly value: bigint }
  | { readonly kind: "double"; readonly value: number }
  | { readonly kind: "bytes"; readonly value: Uint8Array }
  | { readonly kind: "array"; readonly values: readonly InputAnyValue[] }
  | { readonly kind: "kvlist"; readonly values: readonly InputKeyValue[] };

export interface InputKeyValue {
  readonly key: string;
  readonly value: InputAnyValue;
}

export interface InputResource {
  readonly attributes: readonly InputKeyValue[];
  readonly droppedAttributesCount: number;
}

export interface InputScope {
  readonly name: string;
  readonly version: string;
  readonly attributes: readonly InputKeyValue[];
  readonly droppedAttributesCount: number;
}

export interface InputSpanEvent {
  readonly timeUnixNano: bigint;
  readonly name: string;
  readonly attributes: readonly InputKeyValue[];
  readonly droppedAttributesCount: number;
}

export interface InputSpanLink {
  readonly traceId: string;
  readonly spanId: string;
  readonly traceState: string;
  readonly attributes: readonly InputKeyValue[];
  readonly droppedAttributesCount: number;
  readonly flags: number;
}

export interface InputSpan {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId: string | null;
  readonly traceState: string;
  readonly flags: number;
  readonly name: string;
  readonly kind: 0 | 1 | 2 | 3 | 4 | 5;
  readonly startTimeUnixNano: bigint;
  readonly endTimeUnixNano: bigint;
  readonly attributes: readonly InputKeyValue[];
  readonly droppedAttributesCount: number;
  readonly events: readonly InputSpanEvent[];
  readonly droppedEventsCount: number;
  readonly links: readonly InputSpanLink[];
  readonly droppedLinksCount: number;
  readonly status: { readonly code: 0 | 1 | 2; readonly message: string };
  readonly path: string;
  readonly recordSha256: string;
}

export interface InputLogRecord {
  readonly timeUnixNano: bigint;
  readonly observedTimeUnixNano: bigint;
  readonly severityNumber: number;
  readonly severityText: string;
  readonly body: InputAnyValue | null;
  readonly attributes: readonly InputKeyValue[];
  readonly droppedAttributesCount: number;
  readonly flags: number;
  readonly traceId: string | null;
  readonly spanId: string | null;
  readonly eventName: string;
  readonly path: string;
  readonly recordSha256: string;
}

export interface InputWarning {
  readonly path: string;
  readonly code: "over-bounds" | "time-inverted";
}

export interface InputRejected {
  readonly path: string;
  readonly reason: string;
}

export interface PolicyInputTraces {
  readonly signal: "traces";
  readonly resourceSpans: readonly {
    readonly path: string;
    readonly resource: InputResource;
    readonly resourceSha256: string;
    readonly schemaUrl: string;
    readonly scopeSpans: readonly {
      readonly path: string;
      readonly scope: InputScope;
      readonly scopeSha256: string;
      readonly schemaUrl: string;
      readonly spans: readonly InputSpan[];
    }[];
  }[];
  readonly rejected: readonly InputRejected[];
  readonly warnings: readonly InputWarning[];
}

export interface PolicyInputLogs {
  readonly signal: "logs";
  readonly resourceLogs: readonly {
    readonly path: string;
    readonly resource: InputResource;
    readonly resourceSha256: string;
    readonly schemaUrl: string;
    readonly scopeLogs: readonly {
      readonly path: string;
      readonly scope: InputScope;
      readonly scopeSha256: string;
      readonly schemaUrl: string;
      readonly logRecords: readonly InputLogRecord[];
    }[];
  }[];
  readonly rejected: readonly InputRejected[];
  readonly warnings: readonly InputWarning[];
}
