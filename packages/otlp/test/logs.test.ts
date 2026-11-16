import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeLogsJson, partialSuccessOf } from "../src/index.js";
import { enc, expectCode, fixture, nestArray, oneLog, SPAN, str, TRACE } from "./helpers.js";

const recs = (d: ReturnType<typeof decodeLogsJson>) =>
  d.resourceLogs.flatMap((r) => r.scopeLogs.flatMap((s) => s.logRecords));

test("synthetic Claude Code log batch decodes with its event names", () => {
  const d = decodeLogsJson(fixture("logs-claude-code.json"));
  assert.equal(d.rejected.length, 0);
  const r = recs(d);
  assert.deepEqual(
    r.map((x) => x.eventName),
    ["claude_code.user_prompt", "claude_code.api_request", "claude_code.tool_result"],
  );
  const ev = (i: number, key: string) => r[i]?.attributes.find((a) => a.key === key)?.value;
  assert.deepEqual(ev(0, "event.name"), { kind: "string", value: "claude_code.user_prompt" });
  assert.deepEqual(ev(1, "cost_usd"), { kind: "double", value: 0.0123 });
  assert.deepEqual(ev(1, "input_tokens"), { kind: "int", value: 1000n });
  assert.deepEqual(ev(2, "success"), { kind: "bool", value: true });
  assert.equal(r[0]?.severityNumber, 9);
  assert.equal(r[0]?.timeUnixNano, 1700000000000000000n);
  assert.equal(r[0]?.observedTimeUnixNano, 1700000000001000000n);
  assert.equal(r[0]?.path, "/resourceLogs/0/scopeLogs/0/logRecords/0");
  assert.equal(d.resourceLogs[0]?.scopeLogs[0]?.scope.name, "com.anthropic.claude_code.events");
  assert.notEqual(r[0]?.recordSha256, r[1]?.recordSha256);
});

test("log record defaults, body null and optional ids", () => {
  const r = recs(decodeLogsJson(oneLog()))[0];
  assert.equal(r?.body, null);
  assert.equal(r?.traceId, null);
  assert.equal(r?.spanId, null);
  assert.equal(r?.severityNumber, 0);
  assert.equal(r?.observedTimeUnixNano, 0n);
  const ids = recs(
    decodeLogsJson(
      oneLog({
        traceId: TRACE.toUpperCase(),
        spanId: SPAN.toUpperCase(),
        body: { stringValue: "b" },
      }),
    ),
  )[0];
  assert.equal(ids?.traceId, TRACE);
  assert.equal(ids?.spanId, SPAN);
  assert.deepEqual(ids?.body, { kind: "string", value: "b" });
});

test("log record rejections", () => {
  const cases: [Record<string, unknown>, string][] = [
    [{ traceId: "0".repeat(32) }, "invalid-trace-id"],
    [{ traceId: "abc" }, "invalid-trace-id"],
    [{ spanId: "0".repeat(16) }, "invalid-span-id"],
    [{ severityNumber: "SEVERITY_NUMBER_INFO" }, "invalid-enum"],
    [{ severityNumber: 25 }, "invalid-enum"],
    [{ timeUnixNano: "9223372036854775808" }, "time-out-of-range"],
    [{ timeUnixNano: 9007199254740994 }, "invalid-int64"],
    [{ body: {} }, "invalid-any-value"],
    [{ body: nestArray(17) }, "any-value-too-deep"],
    [{ attributes: "x" }, "invalid-type"],
    [{ flags: -1 }, "invalid-uint32"],
  ];
  for (const [over, reason] of cases) {
    const d = decodeLogsJson(oneLog(over));
    assert.equal(recs(d).length, 0, JSON.stringify(over));
    assert.deepEqual(d.rejected, [{ path: "/resourceLogs/0/scopeLogs/0/logRecords/0", reason }]);
  }
  assert.equal(recs(decodeLogsJson(oneLog({ body: nestArray(16) }))).length, 1);
});

test("log partial success counts and reasons", () => {
  const d = decodeLogsJson(
    enc({
      resourceLogs: [
        {
          scopeLogs: [
            {
              logRecords: [
                { body: { stringValue: "a" } },
                { severityNumber: "x" },
                { traceId: "zz" },
              ],
            },
          ],
        },
      ],
    }),
  );
  assert.equal(recs(d).length, 1);
  assert.deepEqual(partialSuccessOf(d.rejected), { rejected: 2, errorMessage: "invalid-enum" });
});

test("log count bounds and attribute truncation", () => {
  const many = Array.from({ length: 10_001 }, () => ({ timeUnixNano: "1" }));
  expectCode(
    () => decodeLogsJson(enc({ resourceLogs: [{ scopeLogs: [{ logRecords: many }] }] })),
    "too-many-records",
  );
  const attrs = Array.from({ length: 300 }, (_, i) => str(`k${i}`, "v"));
  const d = decodeLogsJson(oneLog({ attributes: attrs }));
  assert.equal(recs(d)[0]?.attributes.length, 128);
  assert.equal(recs(d)[0]?.droppedAttributesCount, 172);
  assert.deepEqual(d.warnings, [
    { path: "/resourceLogs/0/scopeLogs/0/logRecords/0", code: "over-bounds" },
  ]);
});

test("a warning from a rejected record does not leak", () => {
  const attrs = Array.from({ length: 300 }, (_, i) => str(`k${i}`, "v"));
  const d = decodeLogsJson(oneLog({ attributes: attrs, severityNumber: "bad" }));
  assert.equal(d.rejected.length, 1);
  assert.equal(d.warnings.length, 0);
});

test("log whole-request errors", () => {
  expectCode(() => decodeLogsJson(new TextEncoder().encode("nope")), "malformed-json");
  expectCode(() => decodeLogsJson(enc({ resourceLogs: {} })), "invalid-structure");
  expectCode(
    () => decodeLogsJson(enc({ resourceLogs: [{ scopeLogs: [{ logRecords: 1 }] }] })),
    "invalid-structure",
  );
  // a traces request is simply an empty logs request: unknown fields are ignored
  assert.equal(decodeLogsJson(fixture("traces-genai.json")).resourceLogs.length, 0);
});
