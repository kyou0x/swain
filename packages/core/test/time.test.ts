import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeTimestamp } from "../src/time/index.js";

const valid = (value: string) => ({ value, origin: "source", status: "valid" });
const invalid = { value: null, origin: "source", status: "invalid" };

test("valid timestamp vectors", () => {
  assert.deepEqual(normalizeTimestamp("2026-11-15T12:00:00Z"), valid("2026-11-15T12:00:00.000Z"));
  assert.deepEqual(
    normalizeTimestamp("2026-11-15T13:30:00.123456+01:30"),
    valid("2026-11-15T12:00:00.123Z"),
  );
  assert.deepEqual(normalizeTimestamp("2024-02-29T00:00:00Z"), valid("2024-02-29T00:00:00.000Z"));
  assert.deepEqual(
    normalizeTimestamp("2999-12-31T23:59:59.999Z"),
    valid("2999-12-31T23:59:59.999Z"),
  );
  assert.deepEqual(normalizeTimestamp("1970-01-01T00:00:00Z"), valid("1970-01-01T00:00:00.000Z"));
  assert.deepEqual(
    normalizeTimestamp("1970-01-01T01:30:00+01:00"),
    valid("1970-01-01T00:30:00.000Z"),
  );
  assert.deepEqual(normalizeTimestamp("2026-11-15t12:00:00z"), valid("2026-11-15T12:00:00.000Z"));
});

test("invalid timestamp vectors", () => {
  const bad: unknown[] = [
    "2026-11-15T12:00:00",
    "2026-02-29T00:00:00Z",
    "1969-12-31T23:59:59Z",
    "3000-01-01T00:00:00Z",
    "2026-11-15T23:59:60Z",
    "0099-01-01T00:00:00Z",
    "1970-01-01T00:30:00+01:00",
    "2999-12-31T23:59:59-01:00",
    "2026-11-15T12:00:00+24:00",
    "2026-11-15T12:00:00.1234567891Z",
    "２０２６-１１-１５T12:00:00Z",
    "2".repeat(1_000_000),
    1731672000000,
    "garbage",
    {},
    "2026-13-01T00:00:00Z",
    "2026-00-10T00:00:00Z",
    "2026-04-31T00:00:00Z",
    "2026-11-15T12:60:00Z",
    "2026-11-15T12:00:00+01:60",
    "2100-02-29T00:00:00Z",
    true,
    [],
  ];
  for (const b of bad) assert.deepEqual(normalizeTimestamp(b), invalid);
});

test("missing timestamps", () => {
  const missing = { value: null, origin: "none", status: "missing" };
  assert.deepEqual(normalizeTimestamp(null), missing);
  assert.deepEqual(normalizeTimestamp(undefined), missing);
});

test("length precheck happens at 64 characters", () => {
  assert.deepEqual(normalizeTimestamp(`2026-11-15T12:00:00Z${" ".repeat(60)}`), invalid);
});
