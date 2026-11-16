import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type DecodeErrorCode, OtlpDecodeError } from "../src/index.js";

// dist/test/helpers.js -> repository root is four levels up from the compiled file.
const here = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURE_DIR = path.resolve(here, "../../../../fixtures/otlp");

export function fixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(path.join(FIXTURE_DIR, name)));
}

export const enc = (v: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(v));
export const encText = (s: string): Uint8Array => new TextEncoder().encode(s);

export const TRACE = "5b8efff798038103d269b633813fc60c";
export const SPAN = "00f067aa0ba902b7";

export type J = Record<string, unknown>;

/** A traces request with one span; `over` replaces or adds span fields. */
export function oneSpan(over: J = {}): Uint8Array {
  return enc(spanReq([{ traceId: TRACE, spanId: SPAN, name: "x", ...over }]));
}

export function spanReq(spans: readonly J[], resource?: J, scope?: J): J {
  return {
    resourceSpans: [
      {
        ...(resource === undefined ? {} : { resource }),
        scopeSpans: [{ ...(scope === undefined ? {} : { scope }), spans }],
      },
    ],
  };
}

export function oneLog(over: J = {}): Uint8Array {
  return enc({ resourceLogs: [{ scopeLogs: [{ logRecords: [{ timeUnixNano: "1", ...over }] }] }] });
}

export const str = (key: string, value: string): J => ({ key, value: { stringValue: value } });

/** `n` nested AnyValues: n = 1 is a scalar, each further level is an arrayValue. */
export function nestArray(n: number): J {
  return n <= 1 ? { stringValue: "x" } : { arrayValue: { values: [nestArray(n - 1)] } };
}

export function nestKv(n: number): J {
  return n <= 1
    ? { stringValue: "x" }
    : { kvlistValue: { values: [{ key: "k", value: nestKv(n - 1) }] } };
}

export function expectCode(fn: () => unknown, code: DecodeErrorCode): void {
  assert.throws(fn, (e: unknown) => {
    assert.ok(e instanceof OtlpDecodeError, `expected OtlpDecodeError, got ${String(e)}`);
    assert.equal(e.code, code);
    return true;
  });
}
