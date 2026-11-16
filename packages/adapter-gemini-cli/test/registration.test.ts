import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { CapabilityRow, CapabilityValue } from "@swain/core";
import { STRING_BOUNDS } from "@swain/core";
import { registrations } from "../src/index.js";
import { fixturePath } from "./helpers.js";

const RANK: Record<CapabilityValue, number> = {
  unsupported: 0,
  unknown: 1,
  partial: 2,
  available: 3,
};

interface Matrix {
  providers: Record<
    string,
    { cells: Record<string, { value: CapabilityValue; surfaces: string[] }> }
  >;
}

function matrix(): Matrix {
  const p = fixturePath("../docs/architecture/capability-matrix.json");
  return JSON.parse(readFileSync(p, "utf8")) as Matrix;
}

test("exports the two Gemini surfaces through `registrations`", () => {
  assert.deepEqual(
    registrations.map((r) => r.adapter.manifest.id),
    ["gemini-cli.chat-jsonl", "gemini-cli.chat-json"],
  );
  const [jsonl, json] = registrations.map((r) => r.adapter.manifest);
  assert.deepEqual(jsonl?.framing, { kind: "jsonl" });
  assert.deepEqual(json?.framing, { kind: "json-document", recordArrays: ["/messages"] });
});

test("manifests are conservative and labeled", () => {
  for (const { adapter } of registrations) {
    const m = adapter.manifest;
    assert.equal(m.provider, "gemini-cli");
    assert.equal(m.sourceKind, m.id);
    assert.equal(m.sourceStability, "undocumented");
    assert.equal(m.experimental, true);
    assert.deepEqual(m.captureModes, ["import-file"]);
    assert.deepEqual(m.testedProviderVersions, []);
    assert.match(m.adapterVersion, new RegExp(STRING_BOUNDS.adapterVersion.pattern ?? ""));
    assert.match(m.id, new RegExp(STRING_BOUNDS.adapterId.pattern ?? ""));
    const key = new RegExp(STRING_BOUNDS.attributeKey.pattern ?? "");
    for (const k of m.attributeKeys) assert.match(k, key);
    assert.ok(m.attributeKeys.every((k) => k.startsWith("gemini-cli.")));
  }
});

test("capabilities never exceed capability-matrix.json for the surface (unlisted surface => unknown)", () => {
  const cells = matrix().providers["gemini-cli"]?.cells ?? {};
  for (const { adapter } of registrations) {
    const m = adapter.manifest;
    for (const [row, value] of Object.entries(m.capabilities) as [
      CapabilityRow,
      CapabilityValue,
    ][]) {
      const cell = cells[row];
      assert.ok(cell !== undefined, row);
      const listed = cell.surfaces.includes(m.sourceKind);
      const max = listed ? RANK[cell.value] : RANK.unknown;
      assert.ok(RANK[value] <= max, `${m.id} ${row}`);
    }
  }
});

test("discovery patterns are anchored, backreference-free and select only session files", () => {
  const [jsonl, json] = registrations.map((r) => new RegExp(r.discovery.fileNamePattern));
  for (const r of registrations) {
    assert.ok(
      r.discovery.fileNamePattern.startsWith("^") && r.discovery.fileNamePattern.endsWith("$"),
    );
    assert.doesNotMatch(r.discovery.fileNamePattern, /\\[1-9]|\\k</);
    assert.deepEqual(r.discovery.roots, [{ base: "home", segments: [".gemini", "tmp"] }]);
  }
  assert.ok(jsonl?.test("session-2026-11-15T10-30-a1b2c3d4.jsonl"));
  assert.ok(jsonl?.test("a1b2c3d4-sub.jsonl"));
  assert.ok(!jsonl?.test("session-x.jsonl.unreadable-1700000000000"));
  assert.ok(!jsonl?.test("session-x.jsonl.tmp-123"));
  assert.ok(!jsonl?.test("session-x.json"));
  assert.ok(json?.test("session-2026-11-15T10-30-a1b2c3d4.json"));
  assert.ok(!json?.test("checkpoint-tag.json"));
  assert.ok(!json?.test("logs.json"));
  assert.ok(!json?.test("session-x.jsonl"));
});
