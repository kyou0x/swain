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
    {
      surfaces: { id: string; stability: string }[];
      cells: Record<string, { value: CapabilityValue; surfaces: string[] }>;
    }
  >;
}

const matrix = (): Matrix =>
  JSON.parse(
    readFileSync(fixturePath("../docs/architecture/capability-matrix.json"), "utf8"),
  ) as Matrix;

test("exports exactly opencode.session-export with json-document framing over /messages", () => {
  assert.equal(registrations.length, 1);
  const m = registrations[0]?.adapter.manifest;
  assert.equal(m?.id, "opencode.session-export");
  assert.equal(m?.provider, "opencode");
  assert.equal(m?.sourceKind, "opencode.session-export");
  assert.deepEqual(m?.framing, { kind: "json-document", recordArrays: ["/messages"] });
  assert.deepEqual(m?.captureModes, ["import-file"]);
  assert.deepEqual(m?.testedProviderVersions, []);
  assert.equal(m?.experimental, true);
  assert.match(m?.id ?? "", new RegExp(STRING_BOUNDS.adapterId.pattern ?? ""));
  assert.match(m?.adapterVersion ?? "", new RegExp(STRING_BOUNDS.adapterVersion.pattern ?? ""));
  for (const k of m?.attributeKeys ?? []) {
    assert.match(k, new RegExp(STRING_BOUNDS.attributeKey.pattern ?? ""));
    assert.ok(k.startsWith("opencode."));
  }
});

test("stability matches the matrix surface", () => {
  const surface = matrix().providers["opencode"]?.surfaces.find(
    (s) => s.id === "opencode.session-export",
  );
  assert.equal(registrations[0]?.adapter.manifest.sourceStability, surface?.stability);
});

test("capabilities never exceed capability-matrix.json for the surface (cells name other surfaces => unknown)", () => {
  const cells = matrix().providers["opencode"]?.cells ?? {};
  const m = registrations[0]?.adapter.manifest;
  assert.ok(m !== undefined);
  for (const [row, value] of Object.entries(m.capabilities) as [CapabilityRow, CapabilityValue][]) {
    const cell = cells[row];
    assert.ok(cell !== undefined, row);
    const max = cell.surfaces.includes(m.sourceKind) ? RANK[cell.value] : RANK.unknown;
    assert.ok(RANK[value] <= max, row);
  }
});

test("discovery pattern is anchored and backreference-free", () => {
  const d = registrations[0]?.discovery;
  assert.ok(d !== undefined);
  assert.ok(d.fileNamePattern.startsWith("^") && d.fileNamePattern.endsWith("$"));
  assert.doesNotMatch(d.fileNamePattern, /\\[1-9]|\\k</);
  const re = new RegExp(d.fileNamePattern);
  assert.ok(re.test("opencode-export.json"));
  assert.ok(re.test("session-ses_x.json"));
  assert.ok(!re.test("opencode.db"));
  assert.ok(!re.test("notes.json"));
  assert.deepEqual(d.roots, [{ base: "xdg-data", segments: ["opencode"] }]);
});
