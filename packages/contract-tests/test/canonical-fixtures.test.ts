import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { validateEvent, validateEvents } from "@swain/core";

const dir = fileURLToPath(new URL("../../../../fixtures/canonical/", import.meta.url));

interface IndexEntry {
  valid: boolean;
  expectedIssueCodes: string[];
  sha256: string;
}
const index = JSON.parse(readFileSync(`${dir}INDEX.json`, "utf8")) as Record<string, IndexEntry>;

function listFiles(sub: string): string[] {
  return readdirSync(`${dir}${sub}`)
    .filter((n) => n.endsWith(".json"))
    .map((n) => `${sub}/${n}`);
}

test("INDEX.json lists exactly the files on disk", () => {
  const onDisk = [...listFiles("valid"), ...listFiles("invalid")].sort();
  assert.deepEqual(Object.keys(index).sort(), onDisk);
});

test("every fixture matches INDEX.json (hash, outcome, issue codes)", () => {
  for (const [rel, entry] of Object.entries(index)) {
    const bytes = readFileSync(`${dir}${rel}`);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), entry.sha256, rel);
    const value: unknown = JSON.parse(bytes.toString("utf8"));
    const r = Array.isArray(value) ? validateEvents(value) : validateEvent(value);
    assert.equal(r.ok, entry.valid, rel);
    const got = r.ok ? [] : r.issues.map((i) => i.code);
    assert.deepEqual(got, entry.expectedIssueCodes, rel);
  }
});

test("coverage: one valid event per kind and the required invalid families", () => {
  const valid = Object.keys(index).filter((k) => k.startsWith("valid/"));
  assert.ok(valid.length >= 17);
  const names = Object.keys(index).join("\n");
  for (const needle of [
    "unknown-key",
    "proto-key",
    "schema-version-0.2.0",
    "schema-version-1.0.0",
    "id-bad-format",
    "hash-uppercase",
    "status-success-on-request",
    "missing-required-facet",
    "time-valid-null-value",
    "time-origin-receipt",
    "lone-surrogate",
    "float-token-count",
    "hash-only-with-inline",
    "attributes-33",
    "links-17",
    "set-duplicate-event-id",
    "set-dangling-link",
    "set-derived-missing-basis",
    "set-out-of-order-sequence",
    "bound-schemaVersion",
    "bound-id",
    "bound-tcId",
    "bound-sha256",
    "bound-providerVersion",
    "bound-sourceKind",
    "bound-adapterId",
    "bound-adapterVersion",
    "bound-rule",
    "bound-pointer",
    "bound-timeValue",
    "bound-attributeKey",
    "bound-attributeString",
    "bound-bounded256",
    "bound-bounded512",
    "bound-filePath",
    "bound-inline",
  ]) {
    assert.ok(names.includes(needle), needle);
  }
});
