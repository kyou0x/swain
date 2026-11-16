import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  base64Encode,
  canonicalLogRecordJson,
  canonicalSpanJson,
  decodeLogsJson,
  decodeTracesJson,
  type LogRecordData,
  logRecordSha256,
  resourceSha256,
  type SpanData,
  spanRecordSha256,
} from "../src/index.js";
import { enc, fixture, oneLog, oneSpan, SPAN, str, TRACE } from "./helpers.js";

const sha = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

// Normative vectors (SPEC-003 section 3.4). The canonical text is written out by hand, and the
// digests were computed with `sha256sum` over exactly that text, independent of the code under test.
const SPAN_CANONICAL =
  '{"attributes":[{"key":"k","value":{"intValue":"5"}}],"endTimeUnixNano":"2000","kind":2,"name":"x","spanId":"00f067aa0ba902b7","startTimeUnixNano":"1000","status":{"code":2,"message":"boom"},"traceId":"5b8efff798038103d269b633813fc60c"}';
const SPAN_SHA = "8129e8c9e9b71fbb041f8765f113e1e2fa243abb077a17a1723ec7296ba333c6";
const LOG_CANONICAL =
  '{"attributes":[{"key":"event.name","value":{"stringValue":"claude_code.user_prompt"}}],"body":{"stringValue":"hi"},"severityNumber":9,"timeUnixNano":"1000"}';
const LOG_SHA = "999538a672e136b5e0e3208573b9d1abe0bd5865f799f32b9d3a24b153f4a231";

const SPAN_WIRE = {
  traceId: TRACE.toUpperCase(),
  spanId: SPAN,
  parentSpanId: "",
  name: "x",
  kind: 2,
  startTimeUnixNano: 1000,
  endTimeUnixNano: "2000",
  attributes: [{ key: "k", value: { intValue: 5 } }],
  status: { code: 2, message: "boom" },
  unknown: "dropped",
};

const firstSpan = (b: Uint8Array) => decodeTracesJson(b).resourceSpans[0]?.scopeSpans[0]?.spans[0];

test("span vector: canonical text and recordSha256", () => {
  const s = firstSpan(oneSpan(SPAN_WIRE));
  assert.ok(s);
  assert.equal(canonicalSpanJson(s), SPAN_CANONICAL);
  assert.equal(s.recordSha256, SPAN_SHA);
  assert.equal(sha(SPAN_CANONICAL), SPAN_SHA);
});

test("log vector: canonical text and recordSha256", () => {
  const body = enc({
    resourceLogs: [
      {
        scopeLogs: [
          {
            logRecords: [
              {
                timeUnixNano: "1000",
                severityNumber: 9,
                body: { stringValue: "hi" },
                attributes: [str("event.name", "claude_code.user_prompt")],
                droppedAttributesCount: 0,
                traceId: "",
              },
            ],
          },
        ],
      },
    ],
  });
  const r = decodeLogsJson(body).resourceLogs[0]?.scopeLogs[0]?.logRecords[0];
  assert.ok(r);
  assert.equal(canonicalLogRecordJson(r), LOG_CANONICAL);
  assert.equal(r.recordSha256, LOG_SHA);
  assert.equal(sha(LOG_CANONICAL), LOG_SHA);
});

test("hash is independent of JSON key order, number-vs-string int64 and id case", () => {
  const reordered = Object.fromEntries(Object.entries(SPAN_WIRE).reverse());
  const members = Object.entries({
    ...reordered,
    traceId: TRACE,
    startTimeUnixNano: "1000",
    attributes: [{ value: { intValue: "5" }, key: "k" }],
  })
    .map(([k, v]) => `${JSON.stringify(k)}:${JSON.stringify(v)}`)
    .join(",");
  const body = new TextEncoder().encode(
    `{"resourceSpans":[{"scopeSpans":[{"spans":[{${members}}]}]}]}`,
  );
  assert.equal(firstSpan(oneSpan(SPAN_WIRE))?.recordSha256, SPAN_SHA);
  assert.equal(firstSpan(body)?.recordSha256, SPAN_SHA);
});

test("hash ignores resource, scope and path; resource is hashed separately", () => {
  const r1 = decodeTracesJson(oneSpan({ name: "n" })).resourceSpans[0];
  const body = enc({
    resourceSpans: [
      {},
      {
        resource: { attributes: [str("service.name", "svc")] },
        scopeSpans: [
          { scope: { name: "sc" }, spans: [{ traceId: TRACE, spanId: SPAN, name: "n" }] },
        ],
      },
    ],
  });
  const r2 = decodeTracesJson(body).resourceSpans[1];
  assert.equal(
    r1?.scopeSpans[0]?.spans[0]?.recordSha256,
    r2?.scopeSpans[0]?.spans[0]?.recordSha256,
  );
  assert.notEqual(r1?.resourceSha256, r2?.resourceSha256);
  assert.equal(
    r2?.resourceSha256,
    sha('{"attributes":[{"key":"service.name","value":{"stringValue":"svc"}}]}'),
  );
  assert.equal(r1?.resourceSha256, sha("{}"));
  assert.equal(r2?.scopeSpans[0]?.scopeSha256, sha('{"name":"sc"}'));
});

test("default-valued scalars are omitted; presence of an AnyValue member is kept", () => {
  const s: SpanData = {
    traceId: TRACE,
    spanId: SPAN,
    parentSpanId: null,
    traceState: "",
    flags: 0,
    name: "",
    kind: 0,
    startTimeUnixNano: 0n,
    endTimeUnixNano: 0n,
    attributes: [
      { key: "e", value: { kind: "string", value: "" } },
      { key: "z", value: { kind: "int", value: 0n } },
    ],
    droppedAttributesCount: 0,
    events: [{ timeUnixNano: 0n, name: "", attributes: [], droppedAttributesCount: 0 }],
    droppedEventsCount: 0,
    links: [],
    droppedLinksCount: 0,
    status: { code: 0, message: "" },
  };
  assert.equal(
    canonicalSpanJson(s),
    `{"attributes":[{"key":"e","value":{"stringValue":""}},{"key":"z","value":{"intValue":"0"}}],"events":[{}],"spanId":"${SPAN}","traceId":"${TRACE}"}`,
  );
});

test("AnyValue canonical forms: bytes base64, nested array and kvlist, double, bool", () => {
  const r: LogRecordData = {
    timeUnixNano: 0n,
    observedTimeUnixNano: 0n,
    severityNumber: 0,
    severityText: "",
    body: {
      kind: "kvlist",
      values: [
        { key: "b", value: { kind: "bytes", value: new Uint8Array([0xfb, 0xff]) } },
        {
          key: "a",
          value: {
            kind: "array",
            values: [
              { kind: "double", value: 1.5 },
              { kind: "bool", value: false },
            ],
          },
        },
      ],
    },
    attributes: [],
    droppedAttributesCount: 0,
    flags: 0,
    traceId: null,
    spanId: null,
    eventName: "",
  };
  assert.equal(
    canonicalLogRecordJson(r),
    '{"body":{"kvlistValue":{"values":[{"key":"b","value":{"bytesValue":"+/8="}},{"key":"a","value":{"arrayValue":{"values":[{"doubleValue":1.5},{"boolValue":false}]}}}]}}}',
  );
});

test("base64 encoder vectors (RFC 4648)", () => {
  const e = (s: string) => base64Encode(new TextEncoder().encode(s));
  assert.deepEqual(["", "f", "fo", "foo", "foob", "fooba", "foobar"].map(e), [
    "",
    "Zg==",
    "Zm8=",
    "Zm9v",
    "Zm9vYg==",
    "Zm9vYmE=",
    "Zm9vYmFy",
  ]);
});

test("bytesValue round trips through decode and is distinguishable from strings", () => {
  const rec = (b: Uint8Array) => decodeLogsJson(b).resourceLogs[0]?.scopeLogs[0]?.logRecords[0];
  const a = rec(oneLog({ body: { bytesValue: "+/8=" } }));
  assert.deepEqual(a?.body, { kind: "bytes", value: new Uint8Array([0xfb, 0xff]) });
  const b = rec(oneLog({ body: { stringValue: "+/8=" } }));
  assert.notEqual(a?.recordSha256, b?.recordSha256);
});

test("hash functions on the decoded fixtures are stable", () => {
  const d = decodeTracesJson(fixture("traces-genai.json"));
  for (const s of d.resourceSpans.flatMap((r) => r.scopeSpans.flatMap((x) => x.spans))) {
    assert.equal(spanRecordSha256(s), s.recordSha256);
  }
  const l = decodeLogsJson(fixture("logs-claude-code.json"));
  for (const r of l.resourceLogs.flatMap((x) => x.scopeLogs.flatMap((y) => y.logRecords))) {
    assert.equal(logRecordSha256(r), r.recordSha256);
  }
  assert.equal(resourceSha256({ attributes: [], droppedAttributesCount: 0 }), sha("{}"));
});
