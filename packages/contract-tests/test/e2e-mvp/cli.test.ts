/**
 * End-to-end CLI contract: drives `runMain` with a temp store and a fake HOME, imports every
 * synthetic fixture, then checks the hostile properties on the real output bytes.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { runMain } from "@swain/cli";
import type { ImportRecord } from "@swain/report";
import {
  cli,
  EXPECTED_REFUSED,
  fixtureFiles,
  listFilesRecursive,
  REPO,
  rawControls,
  SECRETS,
  sandbox,
} from "./helpers.js";

const sb = sandbox();
after(() => sb.done());

const FILES = fixtureFiles();
const IMPORTABLE = FILES.filter((f) => f.adapter !== null);
const REFUSED = FILES.filter((f) => f.adapter === null);

/** Everything the CLI printed, for the byte-level hostile checks. */
const transcript: string[] = [];
function run(args: readonly string[], box = sb, nowMs?: number) {
  const r = cli(box, args, nowMs);
  transcript.push(r.out, r.err);
  return r;
}

test("import: all fixtures by file, the refused ones are reported, exit 4", () => {
  const r = run(["--store", sb.store, "import", ...FILES.map((f) => f.path)]);
  assert.equal(r.code, 4, r.err + r.out);
  const added = r.out.split("\n").filter((l) => l.startsWith("added "));
  assert.equal(added.length, IMPORTABLE.length);
  for (const f of REFUSED) {
    const expected = EXPECTED_REFUSED[f.rel];
    assert.ok(r.out.includes(`rejected  ${expected}  `), f.rel);
  }
  // Labels and the untested-provider-version status are surfaced, honestly.
  assert.ok(r.out.includes("[experimental]"));
  assert.ok(r.out.includes("[undocumented]"));
  assert.ok(r.out.includes("[untested-provider-version]"));
  assert.ok(r.out.includes("not verified against real provider files"));
  assert.ok(r.out.includes("hashes only"));
});

test("import: a directory is walked, re-import is unchanged and byte-identical", () => {
  const before = listFilesRecursive(sb.store).map((p) => [p, readFileSync(p)] as const);
  const dirs = ["claude-code", "codex-cli", "gemini-cli", "opencode"].map((p) =>
    join(REPO, "fixtures", p, "synthetic-mvp"),
  );
  const r = run(["--store", sb.store, "import", ...dirs]);
  assert.ok([3, 4].includes(r.code) || r.code === 0, `exit ${r.code}`);
  assert.equal(r.out.split("\n").filter((l) => l.startsWith("added ")).length, 0);
  assert.ok(r.out.split("\n").filter((l) => l.startsWith("unchanged ")).length > 0);
  assert.ok(r.out.includes("skipped:"), "walk skip counts are printed");
  const after = listFilesRecursive(sb.store).map((p) => [p, readFileSync(p)] as const);
  assert.deepEqual(
    after.map((x) => x[0]),
    before.map((x) => x[0]),
  );
  for (const [i, [p, bytes]] of before.entries()) {
    assert.ok(bytes.equals(after[i]?.[1] ?? Buffer.alloc(0)), `unchanged bytes: ${p}`);
  }
});

test("store: modes 0700/0600 and events are byte-identical across stores and times", () => {
  assert.equal(statSync(sb.store).mode & 0o777, 0o700);
  const other = { ...sb, store: join(sb.root, "store2") };
  const r = run(
    ["--store", other.store, "import", ...IMPORTABLE.map((f) => f.path)],
    other,
    1_800_000_000_000,
  );
  assert.ok([0, 3].includes(r.code));
  for (const p of listFilesRecursive(sb.store)) {
    assert.equal(statSync(p).mode & 0o777, 0o600, p);
  }
  const rel = (root: string) => listFilesRecursive(root).map((p) => p.slice(root.length));
  assert.deepEqual(rel(other.store), rel(sb.store));
  for (const p of rel(sb.store)) {
    const a = readFileSync(join(sb.store, p));
    const b = readFileSync(join(other.store, p));
    if (p.endsWith("events.jsonl") || p.endsWith("result.json")) assert.ok(a.equals(b), p);
    else if (p.endsWith("import.json") || p.endsWith("index.json")) {
      // Only importedAt may differ.
      const strip = (x: Buffer) => x.toString("utf8").replace(/"importedAt":"[^"]*"/g, "");
      assert.equal(strip(a), strip(b), p);
    }
  }
});

function records(): ImportRecord[] {
  const r = run(["--store", sb.store, "sessions", "--json"]);
  assert.equal(r.code, 0);
  return (JSON.parse(r.out) as { imports: ImportRecord[] }).imports;
}

test("sessions, list and filters", () => {
  const recs = records();
  assert.equal(recs.length, IMPORTABLE.length);
  const table = run(["--store", sb.store, "sessions"]);
  assert.equal(table.code, 0);
  assert.equal(run(["--store", sb.store, "list"]).out, table.out);
  assert.ok(table.out.includes(`${recs.length} imports.`));
  const codex = run(["--store", sb.store, "sessions", "--provider", "codex-cli", "--json"]);
  const n = recs.filter((r) => r.provider === "codex-cli").length;
  assert.equal((JSON.parse(codex.out) as { imports: unknown[] }).imports.length, n);
  assert.equal(run(["--store", sb.store, "sessions", "--provider", "nope"]).code, 2);
  assert.equal(run(["--store", sb.store, "sessions", "--outcome", "partial"]).code, 0);
  const empty = run(["--store", join(sb.root, "missing"), "sessions"]);
  assert.equal(empty.code, 0);
  assert.ok(empty.out.includes("No imports yet"));
});

test("show, explain and report for every import (md, html, json)", () => {
  const recs = records();
  const reportDir = join(sb.root, "reports");
  for (const rec of recs) {
    const id = rec.importId;
    const show = run(["--store", sb.store, "show", id, "--limit", "1000"]);
    assert.equal(show.code, 0, show.err);
    assert.equal(show.out.includes("[experimental]"), rec.adapter.experimental);
    assert.ok(show.out.includes("Labels"));
    assert.ok(show.out.includes("SEQ"));
    assert.equal(run(["--store", sb.store, "show", id, "--json"]).code, 0);
    const ex = run(["--store", sb.store, "explain", id]);
    assert.equal(ex.code, 0, ex.err);
    assert.ok(ex.out.includes("Overview"));
    assert.ok(ex.out.includes("[evt_"), "every statement cites event IDs");
    assert.equal(run(["--store", sb.store, "explain", id, "--json"]).code, 0);
    const md = run(["--store", sb.store, "report", id, "--format", "md"]);
    assert.equal(md.code, 0, md.err);
    assert.ok(
      md.out.includes("hashes allow confirmation of guessed content; do not share exports"),
    );
    const js = run(["--store", sb.store, "report", id, "--format", "json"]);
    assert.equal(js.code, 0);
    const doc = JSON.parse(js.out) as { format: string };
    assert.equal(doc.format, "atm.export/0.1");
    assert.equal(run(["--store", sb.store, "report", id, "--format", "html"]).code, 2);
    const out = join(reportDir, `${id}.html`);
    // Parent must exist: first call is refused (5), then create it via the first --out below.
    if (rec === recs[0]) {
      assert.equal(
        run(["--store", sb.store, "report", id, "--format", "html", "--out", out]).code,
        5,
      );
      mkdirSync(reportDir);
    }
    const h = run(["--store", sb.store, "report", id, "--format", "html", "--out", out]);
    assert.equal(h.code, 0, h.err);
    assert.equal(
      run(["--store", sb.store, "report", id, "--format", "html", "--out", out]).code,
      5,
    );
    assert.equal(statSync(out).mode & 0o777, 0o600);
  }
  assert.equal(run(["--store", sb.store, "show", "imp_ffffff"]).code, 6);
  assert.equal(run(["--store", sb.store, "show", "bogus"]).code, 6);
});

function htmlFiles(dir: string): string[] {
  return listFilesRecursive(dir).filter((p) => p.endsWith(".html"));
}

function assertHtmlHostileProperties(path: string): void {
  const html = readFileSync(path, "utf8");
  assert.equal(/<script/i.test(html), false, `${path}: <script`);
  assert.equal(/<[^>]*\son[a-z]+\s*=/i.test(html), false, `${path}: event handler attribute`);
  assert.equal(/\sstyle\s*=/i.test(html), false, `${path}: style attribute`);
  assert.equal(
    /(?:href|src|action)\s*=\s*["']?\s*javascript:/i.test(html),
    false,
    `${path}: javascript: URL`,
  );
  assert.equal(
    /(?:href|src)\s*=\s*["']?(?:https?:)?\/\//i.test(html),
    false,
    `${path}: external URL`,
  );
  const csp = /<meta http-equiv="Content-Security-Policy" content="([^"]*)">/.exec(html);
  assert.ok(csp, `${path}: CSP meta missing`);
  const m =
    /^default-src 'none'; style-src 'sha256-([A-Za-z0-9+/=]+)'; img-src 'none'; base-uri 'none'; form-action 'none'$/.exec(
      csp[1] ?? "",
    );
  assert.ok(m, `${path}: CSP value`);
  const styles = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)];
  assert.equal(styles.length, 1, `${path}: exactly one style block`);
  assert.equal(
    createHash("sha256")
      .update(styles[0]?.[1] ?? "")
      .digest("base64"),
    m[1],
  );
  assert.deepEqual(rawControls(html), [], `${path}: raw control characters`);
}

test("ui: default and --out, printed file:// URL, hostile properties on real bytes", () => {
  const r = run(["--store", sb.store, "ui"]);
  assert.equal(r.code, 0, r.err);
  const url = /Open in a browser: (file:\/\/\S+)/.exec(r.out)?.[1];
  assert.ok(url);
  assert.equal(fileURLToPath(url), join(sb.store, "ui", "index.html"));
  assert.ok(statSync(fileURLToPath(url)).isFile());
  const again = run(["--store", sb.store, "ui"]);
  assert.equal(again.code, 0, "the default UI dir is regenerated in place");
  const sessions = readdirSync(join(sb.store, "ui", "sessions"));
  assert.equal(sessions.length, IMPORTABLE.length);

  const out = join(sb.root, "ui-out");
  assert.equal(run(["--store", sb.store, "ui", "--out", out]).code, 0);
  assert.equal(run(["--store", sb.store, "ui", "--out", out]).code, 5);
  assert.equal(run(["--store", sb.store, "ui", "--out", out, "--force"]).code, 0);
  const a = readFileSync(join(out, "index.html"));
  assert.ok(a.equals(readFileSync(join(sb.store, "ui", "index.html"))), "deterministic render");

  for (const dir of [join(sb.store, "ui"), out, join(sb.root, "reports")]) {
    const files = htmlFiles(dir);
    assert.ok(files.length > 0);
    for (const f of files) assertHtmlHostileProperties(f);
  }
});

test("hostile: no raw control bytes in anything printed, markdown, or JSON", () => {
  for (const chunk of transcript) assert.deepEqual(rawControls(chunk), []);
  for (const id of records().map((r) => r.importId)) {
    const md = run(["--store", sb.store, "report", id, "--format", "md"]).out;
    assert.deepEqual(rawControls(md), []);
    assert.equal(/\]\((?:javascript|data):/i.test(md), false);
  }
  const all = transcript.join("");
  assert.equal(all.includes("\u001b"), false);
  assert.equal(all.includes("\u0007"), false);
});

test("default content policy: no inline content and no secrets in store, reports or UI", () => {
  const files = [
    ...listFilesRecursive(sb.store),
    ...listFilesRecursive(join(sb.root, "reports")),
    ...listFilesRecursive(join(sb.root, "ui-out")),
  ];
  for (const p of files) {
    const text = readFileSync(p, "utf8");
    if (p.endsWith("events.jsonl")) assert.equal(text.includes('"inline"'), false, p);
    for (const s of SECRETS) assert.equal(text.includes(s), false, `${s} in ${p}`);
  }
  for (const s of SECRETS) assert.equal(transcript.join("").includes(s), false);
});

test("--include-content: inline text is retained masked, secrets stay out, HTML stays inert", () => {
  const box = { ...sb, store: join(sb.root, "store-inline") };
  const hostile = FILES.filter((f) => f.adapter !== null && f.name.includes("hostile"));
  const r = run(
    ["--store", box.store, "import", "--include-content", ...hostile.map((f) => f.path)],
    box,
  );
  assert.ok([0, 3].includes(r.code), r.err + r.out);
  assert.ok(r.out.includes("note: the stored import is") === false);
  let redacted = 0;
  let inline = 0;
  for (const p of listFilesRecursive(box.store)) {
    const text = readFileSync(p, "utf8");
    for (const s of SECRETS) assert.equal(text.includes(s), false, `${s} in ${p}`);
    if (p.endsWith("events.jsonl")) {
      inline += (text.match(/"inline":/g) ?? []).length;
      redacted += (text.match(/"redactionCount":[1-9]/g) ?? []).length;
    }
  }
  assert.ok(inline > 0, "inline content was retained");
  assert.ok(redacted >= 1, "at least one value was redacted");
  const ui = run(["--store", box.store, "ui"], box);
  assert.equal(ui.code, 0);
  for (const f of htmlFiles(join(box.store, "ui"))) {
    assertHtmlHostileProperties(f);
    for (const s of SECRETS) assert.equal(readFileSync(f, "utf8").includes(s), false);
  }
  // A hash-only re-import against the inline store is a no-op that says so.
  const again = run(["--store", box.store, "import", hostile[0]?.path ?? ""], box);
  assert.ok(again.out.includes("unchanged"));
  assert.ok(again.out.includes("use --reimport"));
  for (const chunk of transcript) assert.deepEqual(rawControls(chunk), []);
});

test("usage, sources and store errors", () => {
  assert.equal(run(["--store", sb.store, "show"]).code, 2);
  assert.equal(run(["--store", sb.store, "import"]).code, 2);
  assert.equal(run(["--store", sb.store, "import", "--max-file-bytes", "x", "a"]).code, 2);
  assert.equal(run(["--store", sb.store, "report", "imp_abcdef"]).code, 2);
  const src = run(["sources"]);
  assert.equal(src.code, 0);
  assert.ok(src.out.includes("~/.codex/sessions"));
  assert.ok(src.out.includes("opencode export <session-id> > session.json"));
  assert.equal(statSync(sb.store).isDirectory(), true);
  // A held lock is exit 7 and leaves the lock in place.
  const lockBox = { ...sb, store: join(sb.root, "store-lock") };
  assert.ok(
    [0, 3].includes(
      run(["--store", lockBox.store, "import", IMPORTABLE[0]?.path ?? ""], lockBox).code,
    ),
  );
  const lock = join(lockBox.store, "store.lock");
  writeLock(lock);
  const locked = run(
    ["--store", lockBox.store, "import", "--reimport", IMPORTABLE[0]?.path ?? ""],
    lockBox,
  );
  assert.equal(locked.code, 7);
  assert.ok(locked.err.includes("store.lock"));
  // No store location at all is a usage error.
  let err = "";
  const noHome = runNoHome((s) => {
    err += s;
  });
  assert.equal(noHome, 2);
  assert.ok(err.includes("no store location"));
});

function writeLock(p: string): void {
  writeFileSync(p, "");
}
function runNoHome(onErr: (s: string) => void): number {
  return runMain(["sessions"], {
    stdout: { write: () => undefined },
    stderr: { write: onErr },
    env: { HOME: undefined, XDG_DATA_HOME: undefined },
    nowMs: () => 0,
  });
}

test("the real bin runs under the Node permission model with scoped fs access", () => {
  const bin = fileURLToPath(new URL("../../../../cli/dist/src/bin.js", import.meta.url));
  const store = join(sb.root, "store-spawn");
  const fixture = FILES.find((f) => f.rel === "codex-cli/rollout-legacy-golden.jsonl")?.path ?? "";
  const node = (args: string[]) =>
    spawnSync(
      process.execPath,
      [
        "--permission",
        `--allow-fs-read=${REPO}`,
        `--allow-fs-read=${sb.root}`,
        `--allow-fs-write=${sb.root}`,
        bin,
        ...args,
      ],
      { encoding: "buffer", env: { HOME: sb.home, PATH: "" } },
    );
  const imp = node(["--store", store, "import", fixture]);
  assert.equal(imp.status, 0, imp.stderr.toString("utf8"));
  assert.ok(imp.stdout.toString("utf8").startsWith("added "));
  const ui = node(["--store", store, "ui"]);
  assert.equal(ui.status, 0, ui.stderr.toString("utf8"));
  assert.ok(ui.stdout.toString("utf8").includes("file://"));
  assert.equal(ui.stdout.includes(0x1b), false);
  const bad = node(["--store", "/nonexistent-dir/x", "import", fixture]);
  assert.notEqual(bad.status, 0);
  assert.equal(bad.stderr.includes(0x1b), false);
});

test("walked directories skip symlinks (counted); an explicit symlink argument is followed", () => {
  const box = { ...sb, store: join(sb.root, "store-walk") };
  const dir = join(sb.root, "walkdir");
  mkdirSync(dir);
  const fixture = FILES.find((f) => f.rel === "codex-cli/rollout-legacy-golden.jsonl")?.path ?? "";
  symlinkSync(fixture, join(dir, "rollout-link.jsonl"));
  copyFileSync(fixture, join(dir, "rollout-real.jsonl"));
  const r = run(["--store", box.store, "import", dir], box);
  assert.ok([0, 3].includes(r.code), r.out + r.err);
  assert.equal(r.out.split("\n").filter((l) => l.startsWith("added ")).length, 1);
  assert.ok(r.out.includes("1 symlink"));
  const explicit = run(["--store", box.store, "import", join(dir, "rollout-link.jsonl")], box);
  assert.ok(explicit.out.startsWith("unchanged "), explicit.out);
});
