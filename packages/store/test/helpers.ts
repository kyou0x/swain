import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ImportResult } from "@swain/core";
import type { ImportRecord } from "@swain/report";
import type { PutMeta } from "../src/index.js";

export const PROVIDER_FIXTURES = ["claude-code", "codex-cli", "gemini-cli", "opencode"] as const;

const FIXTURE_DIR = new URL("../../../../fixtures/report/", import.meta.url);

export function loadFixture(name: string): { record: ImportRecord; result: ImportResult } {
  return JSON.parse(readFileSync(new URL(`${name}/session.json`, FIXTURE_DIR), "utf8")) as {
    record: ImportRecord;
    result: ImportResult;
  };
}

export function metaFor(record: ImportRecord, over: Partial<PutMeta> = {}): PutMeta {
  return {
    adapter: record.adapter,
    sourcePath: "/home/demo/sessions/a.jsonl",
    container: {
      encoding: "none",
      sha256: record.source.sha256,
      byteLength: record.source.byteLength,
    },
    contentRetention: "hash-only",
    reimport: false,
    ...over,
  };
}

export const DEPS = { nowMs: () => 1_700_000_000_000, homeDir: "/home/demo" };

export function tempRoot(): { dir: string; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "atm-store-test-"));
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
}
