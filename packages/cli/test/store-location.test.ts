/** Default store directory: swain/, with a read-only fallback to the legacy agent-time-machine/. */
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { main } from "../src/main.js";
import { NOW } from "./helpers.js";

function sandbox(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "swain-loc-")));
}

const SAMPLE = fileURLToPath(
  new URL(
    "../../../../fixtures/claude-code/synthetic-mvp/transcript-golden.jsonl",
    import.meta.url,
  ),
);

function run(env: { HOME: string | undefined; XDG_DATA_HOME: string | undefined }) {
  const out: string[] = [];
  const err: string[] = [];
  const code = main(["import", SAMPLE], {
    stdout: { write: (s: string) => void out.push(s) },
    stderr: { write: (s: string) => void err.push(s) },
    env,
    nowMs: NOW,
  });
  return { code, out: out.join(""), err: err.join("") };
}

test("fresh HOME: swain/ is used under ~/.local/share and no legacy notice is printed", () => {
  const home = sandbox();
  mkdirSync(join(home, ".local/share"), { recursive: true });
  const r = run({ HOME: home, XDG_DATA_HOME: undefined });
  assert.ok(r.code === 0 || r.code === 3, r.err);
  assert.ok(!r.err.includes("legacy"));
  assert.ok(existsSync(join(home, ".local/share/swain/STORE.json")));
  assert.ok(!existsSync(join(home, ".local/share/agent-time-machine")));
});

test("XDG_DATA_HOME wins over HOME", () => {
  const home = sandbox();
  const xdg = sandbox();
  const r = run({ HOME: home, XDG_DATA_HOME: xdg });
  assert.ok(r.code === 0 || r.code === 3, r.err);
  assert.ok(existsSync(join(xdg, "swain/STORE.json")));
  assert.ok(!existsSync(join(home, ".local")));
});

test("only the legacy directory exists: it is used, announced once, and left untouched", () => {
  const xdg = sandbox();
  const legacy = join(xdg, "agent-time-machine");
  mkdirSync(legacy);
  const r = run({ HOME: undefined, XDG_DATA_HOME: xdg });
  assert.ok(r.code === 0 || r.code === 3, r.err);
  assert.equal(r.err.split("legacy store directory").length - 1, 1);
  assert.ok(r.err.startsWith("swain: using the legacy store directory "));
  assert.ok(!existsSync(join(xdg, "swain")), "no new directory is created");
  assert.ok(existsSync(join(legacy, "STORE.json")), "the legacy directory is the store");
  assert.deepEqual(readdirSync(xdg), ["agent-time-machine"]);
});

test("both exist: swain/ wins and nothing is said", () => {
  const xdg = sandbox();
  mkdirSync(join(xdg, "agent-time-machine"));
  mkdirSync(join(xdg, "swain"));
  const r = run({ HOME: undefined, XDG_DATA_HOME: xdg });
  assert.ok(r.code === 0 || r.code === 3, r.err);
  assert.ok(!r.err.includes("legacy"));
  assert.ok(existsSync(join(xdg, "swain/STORE.json")));
  assert.deepEqual(readdirSync(join(xdg, "agent-time-machine")), []);
});

test("a legacy symlink is not adopted", () => {
  const xdg = sandbox();
  const elsewhere = sandbox();
  symlinkSync(elsewhere, join(xdg, "agent-time-machine"));
  const r = run({ HOME: undefined, XDG_DATA_HOME: xdg });
  assert.ok(!r.err.includes("legacy"));
  assert.deepEqual(readdirSync(elsewhere), []);
});
