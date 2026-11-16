// G3 security-review regressions for the store/CLI layer. Fake HOME and temp dirs only.
import assert from "node:assert/strict";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { CanonicalEvent, ImportResult } from "@swain/core";
import { OutputTooLarge } from "@swain/report";
import { OutputRefused, openStore } from "@swain/store";
import { uiFileKeeper, uiSessionPage } from "../src/cmd-report.js";
import { type CliIo, main } from "../src/main.js";
import { NOW } from "./helpers.js";

const FIXTURES = fileURLToPath(new URL("../../../../fixtures/", import.meta.url));
const GOLDEN = join(FIXTURES, "claude-code/synthetic-mvp/transcript-golden.jsonl");

function run(argv: readonly string[], home: string | undefined) {
  let out = "";
  let err = "";
  const io: CliIo = {
    stdout: {
      write: (s) => {
        out += s;
      },
    },
    stderr: {
      write: (s) => {
        err += s;
      },
    },
    env: { HOME: home, XDG_DATA_HOME: undefined },
    nowMs: NOW,
  };
  return { code: main(argv, io), out, err };
}

function temp(): { dir: string; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "atm-cli-g3-"));
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
}

const FAKE_HOME = "/home/fakeuser";

/** A stored session whose events carry the fake HOME in a path, a cwd and a pointer. */
function seedStore(storeDir: string): string {
  const doc = JSON.parse(
    readFileSync(join(FIXTURES, "report/claude-code/session.json"), "utf8"),
  ) as { record: { adapter: never }; result: ImportResult };
  const events = doc.result.events.map((e, i) => {
    const c = JSON.parse(JSON.stringify(e)) as CanonicalEvent & {
      attributes: Record<string, string>;
      provenance: { pointer: string | null };
    };
    if (c.kind === "file.changed") {
      (c.payload as { path: string }).path = `${FAKE_HOME}/proj/src/app.ts`;
    }
    if (i === 0) c.attributes["claude.cwd"] = `${FAKE_HOME}/proj`;
    if (i === 1) c.provenance.pointer = `/payload/${FAKE_HOME.replaceAll("/", "~1")}/x`;
    return c;
  });
  const result: ImportResult = { ...doc.result, events };
  // The store is opened without a home, so the stored display path keeps the fake HOME.
  const store = openStore(storeDir, { nowMs: NOW, homeDir: null });
  const put = store.put(result, {
    adapter: doc.record.adapter,
    sourcePath: `${FAKE_HOME}/sessions/a.jsonl`,
    container: {
      encoding: "none",
      sha256: result.source.sha256,
      byteLength: result.source.byteLength,
    },
    contentRetention: "hash-only",
    reimport: false,
  });
  return put.record.importId;
}

test("G1: --json output of show, explain and sessions never contains HOME", () => {
  const t = temp();
  try {
    const store = join(t.dir, "store");
    const id = seedStore(store);
    // Sanity: the unmasked data really is in the store.
    assert.ok(run(["--store", store, "sessions", "--json"], undefined).out.includes(FAKE_HOME));
    for (const cmd of [
      ["show", id, "--json"],
      ["explain", id, "--json"],
      ["sessions", "--json"],
    ]) {
      const r = run(["--store", store, ...cmd], FAKE_HOME);
      assert.equal(r.code, 0, cmd[0]);
      assert.ok(r.out.length > 0);
      assert.ok(!r.out.includes(FAKE_HOME), `${cmd[0]} leaked HOME`);
      assert.ok(!r.out.includes(FAKE_HOME.replaceAll("/", "~1")), `${cmd[0]} leaked pointer`);
    }
    const shown = run(["--store", store, "show", id, "--json"], FAKE_HOME).out;
    assert.ok(shown.includes("~/proj/src/app.ts"));
    assert.ok(shown.includes('"claude.cwd":"~/proj"'));
  } finally {
    t.done();
  }
});

test("G3: a missing explicit path is rejected alone; the others still import (exit 4)", () => {
  const t = temp();
  try {
    const home = join(t.dir, "home");
    mkdirSync(home);
    copyFileSync(GOLDEN, join(home, "a.jsonl"));
    const store = join(t.dir, "store");
    const r = run(
      ["--store", store, "import", join(home, "nope.jsonl"), join(home, "a.jsonl")],
      home,
    );
    assert.equal(r.code, 4);
    assert.ok(r.out.includes("rejected  source-unreadable  ~/nope.jsonl\n"));
    assert.ok(/^added /m.test(r.out));
    assert.ok(r.out.includes("1 file: 1 added"));
    assert.ok(!r.out.includes(home));
    assert.equal(openStore(store, { nowMs: NOW, homeDir: home }).list().length, 1);
  } finally {
    t.done();
  }
});

test("G3: a StoreError on a file does not stop the run; exit 7 beats 4", () => {
  const t = temp();
  try {
    const home = join(t.dir, "home");
    mkdirSync(home);
    copyFileSync(GOLDEN, join(home, "a.jsonl"));
    copyFileSync(GOLDEN, join(home, "b.jsonl"));
    const store = join(t.dir, "store");
    openStore(store, { nowMs: NOW, homeDir: home }).init();
    writeFileSync(join(store, "store.lock"), "");
    const r = run(
      [
        "--store",
        store,
        "import",
        join(home, "nope.jsonl"),
        join(home, "a.jsonl"),
        join(home, "b.jsonl"),
      ],
      home,
    );
    assert.equal(r.code, 7);
    assert.equal(r.out.split("\n").filter((l) => l.startsWith("store-error  locked")).length, 2);
    assert.ok(r.out.includes("2 files:"));
    assert.ok(r.out.includes("2 store errors"));
    assert.ok(r.out.includes("rejected  source-unreadable"));
  } finally {
    t.done();
  }
});

test("G4: a HOME containing a symlink is masked for walked (realpath) files", () => {
  const t = temp();
  try {
    const real = join(t.dir, "real");
    mkdirSync(join(real, "sessions"), { recursive: true });
    copyFileSync(GOLDEN, join(real, "sessions", "transcript.jsonl"));
    const link = join(t.dir, "link");
    symlinkSync(real, link);
    const store = join(t.dir, "store");
    const r = run(["--store", store, "import", join(link, "sessions")], link);
    assert.ok(r.code === 0 || r.code === 3, String(r.code));
    assert.ok(/^added .*~\/sessions\/transcript\.jsonl$/m.test(r.out), r.out);
    assert.ok(!r.out.includes(realpathSync(real)));
    const listed = run(["--store", store, "sessions", "--json"], link).out;
    assert.ok(listed.includes("~/sessions/transcript.jsonl"));
    assert.ok(!listed.includes(realpathSync(real)));
  } finally {
    t.done();
  }
});

test("--include-content prints the best-effort masking note", () => {
  const t = temp();
  try {
    const store = join(t.dir, "store");
    const on = run(["--store", store, "import", "--include-content", GOLDEN], t.dir);
    assert.ok(on.out.includes("note: content is stored with best-effort secret masking\n"));
    const off = run(["--store", join(t.dir, "s2"), "import", GOLDEN], t.dir);
    assert.ok(!off.out.includes("best-effort secret masking"));
  } finally {
    t.done();
  }
});

test("G5: the UI page collector stops with too-large once the running total exceeds the cap", () => {
  const keep = uiFileKeeper(10);
  assert.deepEqual(keep("index.html", "12345"), { name: "index.html", data: "12345" });
  assert.deepEqual(keep("sessions/a.html", "12345"), { name: "sessions/a.html", data: "12345" });
  assert.throws(
    () => keep("sessions/b.html", "1"),
    (e: unknown) => e instanceof OutputRefused && e.code === "too-large",
  );
  // Bytes, not UTF-16 units.
  assert.throws(() => uiFileKeeper(3)("index.html", "€€"), OutputRefused);
});

test("UI: an oversized session gets a static stub page; other errors still propagate", () => {
  const rec = JSON.parse(
    readFileSync(join(FIXTURES, "report/claude-code/session.json"), "utf8"),
  ) as { record: Parameters<typeof uiSessionPage>[0] };
  const o = { homeDir: null, maxOutputBytes: 1_000_000, maxRenderedEvents: 10 };
  for (const err of [new OutputTooLarge(), new RangeError("Invalid string length")]) {
    const page = uiSessionPage(
      rec.record,
      () => {
        throw err;
      },
      o,
    );
    assert.ok(page.includes("too large for a static page"));
    assert.ok(page.includes("swain report"));
    assert.ok(page.includes("swain commands"));
    assert.ok(page.includes(`<code>${rec.record.importId.slice(0, 12)}</code>`));
    assert.ok(!page.includes("<script"));
    assert.ok(page.includes("default-src 'none'"));
  }
  assert.throws(
    () =>
      uiSessionPage(
        rec.record,
        () => {
          throw new TypeError("x");
        },
        o,
      ),
    TypeError,
  );
});
