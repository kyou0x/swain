import type {
  EventKind,
  EvtId,
  Hex64,
  ImportResult,
  ProviderId,
  SesId,
  SourceStability,
  WarningCode,
} from "@swain/core";
import type { RunHeader } from "./web-types.js";

/**
 * Structural copy of the store's `ImportRecord` (SPEC-002 sections 4 and 10). Declared here so that
 * `@swain/store` imports the type from `@swain/report` and no package cycle exists.
 * `container` is not exported by `@swain/core`, so it is typed as `string` locally.
 */
export interface ImportRecord {
  readonly importId: `imp_${string}`;
  readonly sessionId: SesId;
  readonly provider: ProviderId;
  readonly sourceKind: string;
  readonly adapter: {
    readonly id: string;
    readonly version: string;
    readonly sourceStability: SourceStability;
    readonly experimental: boolean;
  };
  readonly source: {
    readonly sha256: Hex64;
    readonly byteLength: number;
    readonly container: string;
    readonly displayName: string;
    readonly displayPath: string;
  };
  readonly contentRetention: "hash-only" | "inline";
  readonly outcome: ImportResult["outcome"];
  readonly counts: {
    readonly events: number;
    readonly records: number;
    readonly gaps: number;
    readonly unknowns: number;
    readonly folded: number;
    readonly warnings: number;
    readonly byKind: Partial<Record<EventKind, number>>;
  };
  readonly warningCodes: readonly WarningCode[];
  readonly firstEventTime: string | null;
  readonly lastEventTime: string | null;
  readonly importedAt: string;
}

export interface SessionView {
  readonly record: ImportRecord;
  readonly result: ImportResult;
}

export type Part =
  | { readonly t: "text"; readonly v: string }
  | { readonly t: "data"; readonly v: string }
  | { readonly t: "count"; readonly v: number };

export const TEMPLATE_IDS = [
  "overview.source",
  "overview.counts",
  "overview.span",
  "overview.outcome",
  "turns.turn",
  "turns.prompt",
  "turns.messages",
  "turns.omitted",
  "tools.summary",
  "tools.group",
  "tools.unfinished",
  "files.summary",
  "files.change",
  "files.omitted",
  "failures.tool",
  "failures.ended",
  "failures.retry",
  "permissions.requested",
  "permissions.decided",
  "tokens.cumulative",
  "tokens.summed",
  "gaps.gap",
  "gaps.unknown",
  "gaps.folded",
  "limitations.stability",
  "limitations.retention",
  "limitations.completeness",
  "limitations.warnings",
] as const;
export type TemplateId = (typeof TEMPLATE_IDS)[number];

export interface Statement {
  readonly id: string;
  readonly kind: "evidence" | "interpretation";
  readonly template: TemplateId;
  readonly parts: readonly Part[];
  readonly evidence: readonly EvtId[];
  readonly evidenceTotal: number;
  readonly rule?: `interp.${string}`;
}

export type SectionId =
  | "overview"
  | "turns"
  | "tools"
  | "files"
  | "failures"
  | "permissions"
  | "tokens"
  | "gaps"
  | "limitations";

export interface Explanation {
  readonly format: "atm.explanation/0.1";
  readonly importId: string;
  readonly sessionId: SesId;
  readonly sections: readonly {
    readonly id: SectionId;
    readonly title: string;
    readonly statements: readonly Statement[];
  }[];
}

export interface ExplainOptions {
  readonly includeContentExcerpts: boolean;
  /** Default 160. */
  readonly excerptChars: number;
  /** Home directory spellings masked in excerpts BEFORE they are cut, so a cut never exposes part of one. */
  readonly homeDirs?: readonly (string | null)[];
}

/** Product name and mark shown in the page shell (ADR-0008 section 1). */
export interface Brand {
  /** 1 to 64 characters, no control or bidi characters; always HTML-escaped when rendered. */
  readonly name: string;
  readonly mark: "atm" | "swain";
}

/**
 * The input of `renderRunPage`: the parts of one run.
 *
 * Without `run` (the static viewer) there is exactly one part and the page is byte-identical to
 * `renderUiSessionPage`. With `run` (server pages, N1.6) there are one or more parts: the page
 * shows the run header with its credentials, an index of the parts when there are several, and the
 * full viewer of the selected part (`part`, 1-based, default 1). Parts are never merged: each keeps
 * its own source, ordering and event IDs.
 */
export interface RunView {
  readonly parts: readonly SessionView[];
  readonly run?: RunHeader;
  /** The credential that delivered each part (`keyId` or `local-cli`), parallel to `parts`. */
  readonly partKeys?: readonly string[];
  readonly part?: number;
}

export interface RenderOptions {
  /** Default `{ name: "Swain", mark: "swain" }`, which the goldens pin. */
  readonly brand?: Brand;
  readonly homeDir: string | null;
  /** Realpath of `homeDir` when it differs (symlinked HOME); masked the same way. */
  readonly realHomeDir?: string | null;
  /** Default 268_435_456. */
  readonly maxOutputBytes: number;
  /** Default 10_000. */
  readonly maxRenderedEvents: number;
}

export interface UiFile {
  readonly name: "index.html" | `sessions/${string}.html`;
  readonly data: string;
}

/** Thrown when a rendering exceeds `maxOutputBytes`; partial output is never returned. */
export class OutputTooLarge extends Error {
  readonly code = "OutputTooLarge";
  constructor() {
    super("OutputTooLarge");
    this.name = "OutputTooLarge";
  }
}
