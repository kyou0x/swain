import { LIMITS } from "../schema/constants.js";
import {
  escapeControlChars,
  truncateCodePoints,
  truncateUtf8,
  utf8ByteLength,
} from "../text/index.js";

/** Closed set of issue codes. Issue messages are static; only codes are reported. */
export const ISSUE_CODES = [
  "internal",
  "not-plain-data",
  "accessor-property",
  "depth-exceeded",
  "too-many-keys",
  "too-many-items",
  "too-few-items",
  "too-many-elements",
  "unknown-key",
  "missing-key",
  "wrong-type",
  "bad-enum",
  "bad-pattern",
  "forbidden-char",
  "too-long",
  "wrong-length",
  "ill-formed-string",
  "out-of-range",
  "not-integer",
  "not-sorted",
  "unsupported-schema-version",
  "status-not-allowed",
  "missing-facet",
  "bad-time",
  "inline-with-hash-only",
  "negative-zero",
  "redaction-with-hash-only",
  "content-inline-missing",
  "content-hash-mismatch",
  "content-length-mismatch",
  "duplicate-event-id",
  "dangling-link",
  "dangling-basis",
  "out-of-order",
] as const;

export type IssueCode = (typeof ISSUE_CODES)[number];

export interface Issue {
  path: string;
  code: IssueCode;
  pathTruncated?: true;
}

export type PathSeg = string | number;

/** Builds a bounded RFC 6901 pointer (C12, R2/N2). */
export function formatPath(segs: readonly PathSeg[]): { path: string; truncated: boolean } {
  let truncated = false;
  let out = "";
  for (const seg of segs) {
    const raw = typeof seg === "number" ? String(seg) : seg;
    const cut = truncateCodePoints(raw, LIMITS.maxIssuePathSegmentCodePoints);
    if (cut.truncated) truncated = true;
    out += `/${escapeControlChars(cut.text.replaceAll("~", "~0").replaceAll("/", "~1"))}`;
  }
  if (out.length > LIMITS.maxIssuePathBytes || utf8ByteLength(out) > LIMITS.maxIssuePathBytes) {
    out = truncateUtf8(out, LIMITS.maxIssuePathBytes).text;
    if (out.endsWith("~")) out = out.slice(0, -1);
    truncated = true;
  }
  return { path: out, truncated };
}

/** Collects at most `maxIssues` issues but keeps counting, so callers can detect failure. */
export class IssueSink {
  readonly issues: Issue[] = [];
  total = 0;

  get full(): boolean {
    return this.total >= LIMITS.maxIssues;
  }

  add(path: readonly PathSeg[], code: IssueCode): void {
    this.total++;
    if (this.issues.length >= LIMITS.maxIssues) return;
    const f = formatPath(path);
    this.issues.push(
      f.truncated ? { path: f.path, code, pathTruncated: true } : { path: f.path, code },
    );
  }
}
