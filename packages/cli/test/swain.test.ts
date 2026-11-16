/**
 * N1.8: the `swain` bin's network commands, run in process against a temp HOME on loopback.
 * `swain serve` is started with port 0 and stopped through the injected signal hook.
 */
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, test } from "node:test";
import { currentUid, loadCredential, sendOtlpJson, writeRuntimeFile } from "@swain/client";
import { runMain } from "../src/main.js";
import { runSwain, type SwainIo } from "../src/swain.js";

const ROOT = new URL("../../../../", import.meta.url);
const fixture = (n: string): Uint8Array =>
  new Uint8Array(readFileSync(new URL(`fixtures/otlp/${n}`, ROOT)));

interface Run {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

function tmpHome(): string {
  return mkdtempSync(join(tmpdir(), "swain-cli-test-"));
}

function makeIo(argv: readonly string[], home: string, over: Partial<SwainIo["env"]> = {}) {
  let out = "";
  let err = "";
  const signals: (() => void)[] = [];
  const io: SwainIo = {
    argv,
    stdout: (s) => {
      out += s;
    },
    stderr: {
      write: (s: string) => {
        err += s;
        return true;
      },
    },
    stdin: undefined,
    env: {
      HOME: home,
      XDG_DATA_HOME: undefined,
      XDG_CONFIG_HOME: undefined,
      XDG_STATE_HOME: undefined,
      SWAIN_SERVER_URL: undefined,
      SWAIN_DB: undefined,
      ...over,
    },
    nowMs: Date.now,
    onSignal: (cb) => {
      signals.push(cb);
    },
    version: "0.0.0",
  };
  return {
    io,
    out: () => out,
    err: () => err,
    signal: () => {
      for (const s of signals) s();
    },
  };
}

async function swain(argv: readonly string[], home: string, over = {}): Promise<Run> {
  const t = makeIo(argv, home, over);
  const code = await runSwain(t.io);
  return { code, out: t.out(), err: t.err() };
}

interface Serving {
  readonly port: number;
  readonly origin: string;
  readonly out: () => string;
  stop(): Promise<number>;
}

const running: Serving[] = [];

afterEach(async () => {
  for (const r of running.splice(0)) await r.stop();
});

async function serve(home: string, extra: readonly string[] = []): Promise<Serving> {
  const t = makeIo(["serve", "--port", "0", ...extra], home);
  const done = runSwain(t.io);
  for (let i = 0; i < 200 && !t.out().includes("press Ctrl-C"); i++) {
    await new Promise((r) => setTimeout(r, 25));
  }
  const m = /listening on http:\/\/(?:127\.0\.0\.1|\[::1\]):(\d+)/.exec(t.out());
  assert.ok(m?.[1] !== undefined, `serve did not start: ${t.out()} ${t.err()}`);
  const port = Number(m[1]);
  const srv: Serving = {
    port,
    origin: `http://127.0.0.1:${port}`,
    out: t.out,
    stop: () => {
      t.signal();
      return done;
    },
  };
  running.push(srv);
  return srv;
}

function dbText(path: string): string {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const parts: string[] = [];
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
      name: string;
    }[];
    for (const t of tables) {
      const st = db.prepare(`SELECT * FROM "${t.name}"`);
      st.setReadBigInts(true);
      parts.push(
        JSON.stringify(st.all(), (_k, v: unknown) =>
          typeof v === "bigint"
            ? v.toString()
            : v instanceof Uint8Array
              ? new TextDecoder("latin1").decode(v)
              : v,
        ),
      );
    }
    return parts.join("\n");
  } finally {
    db.close();
  }
}

const dbFile = (home: string): string => join(home, ".local", "share", "swain", "swain.sqlite");
const credFile = (home: string, slug: string): string =>
  join(home, ".config", "swain", "credentials", `${slug}.key`);
const mode = (p: string): number => statSync(p).mode & 0o777;

function secretOf(home: string, slug: string): string {
  const uid = currentUid(home, [home]);
  return loadCredential(join(home, ".config"), slug, uid).secret;
}

test("swain serve binds loopback literals only and rejects any other host before touching files", async () => {
  const home = tmpHome();
  try {
    for (const h of ["0.0.0.0", "localhost", "::", "192.168.1.5", "127.0.0.2", ""]) {
      const r = await swain(["serve", "--host", h, "--port", "0"], home);
      assert.equal(r.code, 2, h);
      assert.match(r.err, /bind-not-loopback/);
    }
    assert.equal(existsSync(join(home, ".local")), false, "nothing was created");
    for (const p of ["-1", "65536", "abc", "01", "1e3"]) {
      assert.equal((await swain(["serve", "--port", p], home)).code, 2, p);
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("swain serve: hardened files, literal-IP URLs, runtime file, clean stop on signal", async () => {
  const home = tmpHome();
  try {
    const s = await serve(home);
    const text = s.out();
    for (const u of text.match(/https?:\/\/\S+/g) ?? []) {
      assert.match(u, /^http:\/\/(127\.0\.0\.1|\[::1\]):\d+$/, u);
    }
    assert.doesNotMatch(text, /localhost|0\.0\.0\.0/);
    assert.match(text, /protobuf is off/);
    const dir = join(home, ".local", "share", "swain");
    assert.equal(mode(dir), 0o700);
    assert.equal(mode(dbFile(home)), 0o600);
    const rt = join(home, ".local", "state", "swain", `server-${s.port}.json`);
    assert.equal(mode(rt), 0o600);
    assert.equal(mode(join(home, ".local", "state", "swain")), 0o700);
    const info = JSON.parse(readFileSync(rt, "utf8")) as Record<string, unknown>;
    assert.deepEqual(Object.keys(info).sort(), ["instanceId", "origin"]);
    assert.equal(info["origin"], s.origin);
    const health = await fetch(`${s.origin}/healthz`);
    assert.equal(health.status, 200);
    assert.equal(await s.stop(), 0);
    assert.equal(existsSync(rt), false, "runtime file removed on stop");
    await assert.rejects(fetch(`${s.origin}/healthz`));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("allowUnverifiedProtobuf is not reachable through any flag, env var or source", async () => {
  const home = tmpHome();
  try {
    // source: the cli package never mentions it (compiled output and TypeScript)
    let scanned = 0;
    for (const d of ["../src/", "../../src/"]) {
      const src = new URL(d, import.meta.url);
      for (const f of readdirSync(src)) {
        if (!f.endsWith(".js") && !f.endsWith(".ts")) continue;
        scanned++;
        assert.doesNotMatch(readFileSync(new URL(f, src), "utf8"), /allowUnverifiedProtobuf/i, f);
      }
    }
    assert.ok(scanned >= 10, "the scan saw the cli sources");
    // flags
    for (const flag of [
      "--allow-unverified-protobuf",
      "--allowUnverifiedProtobuf",
      "--allow-protobuf",
    ]) {
      const r = await swain(["serve", "--port", "0", flag], home);
      assert.equal(r.code, 2, flag);
      assert.match(r.err, /unknown option/);
    }
    // behavior: even with the environment variable set in the process, protobuf is refused
    process.env["SWAIN_ALLOW_UNVERIFIED_PROTOBUF"] = "1";
    process.env["ALLOW_UNVERIFIED_PROTOBUF"] = "1";
    try {
      const k = await swain(["keys", "create", "--project", "demo", "--save"], home);
      assert.equal(k.code, 0, k.err);
      const s = await serve(home);
      const cred = loadCredential(join(home, ".config"), "demo", currentUid(home, [home]));
      const res = await fetch(`${s.origin}/v1/traces`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-protobuf",
          Authorization: `Bearer ${cred.secret}`,
        },
        body: new Uint8Array([0x0a, 0x00]),
      });
      assert.equal(res.status, 415);
      assert.equal(await s.stop(), 0);
    } finally {
      delete process.env["SWAIN_ALLOW_UNVERIFIED_PROTOBUF"];
      delete process.env["ALLOW_UNVERIFIED_PROTOBUF"];
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("no key is ever accepted in argv, and the key is not echoed", async () => {
  const home = tmpHome();
  try {
    const key = `swn_0123456789abcdef_${"a".repeat(64)}`;
    for (const argv of [
      ["keys", "revoke", key],
      ["keys", "list", key],
      ["keys", "create", "--project", key, "--save"],
      ["keys", "create", `--label=${key}`, "--save"],
      ["status", "--project", key],
      ["status", key],
      ["connect", "otlp", "--project", key],
      ["open", key],
      ["serve", "--db", key],
    ]) {
      const r = await swain(argv, home);
      assert.equal(r.code, 2, argv.join(" "));
      assert.doesNotMatch(r.out + r.err, /swn_0123/);
      assert.match(r.err, /never accepted on the command line/);
    }
    // there is no flag that takes a key at all
    for (const flag of ["--key", "--secret", "--token", "--api-key", "--bearer"]) {
      const r = await swain(["status", flag, "x"], home);
      assert.equal(r.code, 2, flag);
    }
    assert.equal(existsSync(join(home, ".local")), false, "refused before any file was created");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("keys create --save: agent-pinned, 0600 file, secret not printed, db keeps only a hash", async () => {
  const home = tmpHome();
  try {
    const r = await swain(
      ["keys", "create", "--project", "demo", "--agent", "planner", "--save"],
      home,
    );
    assert.equal(r.code, 0, r.err);
    const path = credFile(home, "demo");
    assert.equal(mode(path), 0o600);
    assert.equal(mode(join(home, ".config", "swain", "credentials")), 0o700);
    const secret = secretOf(home, "demo");
    assert.doesNotMatch(r.out + r.err, new RegExp(secret.slice(-64)), "secret not printed");
    assert.match(r.out, /<SWAIN_KEY>/);
    assert.match(r.out, /pinned to planner/);
    assert.match(r.out, /~\/\.config\/swain\/credentials\/demo\.key/);
    assert.match(r.out, /http:\/\/127\.0\.0\.1:4318/);
    // the database never holds the secret
    const dump = dbText(dbFile(home));
    assert.ok(!dump.includes(secret.slice(-64)), "secret absent from the database");
    const cred = JSON.parse(readFileSync(path, "utf8")) as Record<string, string>;
    assert.equal(cred["agentName"], "planner");
    assert.equal(cred["origin"], "http://127.0.0.1:4318");
    // never overwritten
    const again = await swain(["keys", "create", "--project", "demo", "--save"], home);
    assert.equal(again.code, 5);
    assert.equal(readFileSync(path, "utf8"), `${JSON.stringify(cred)}\n`);
    // default agent: pinned to the label even without --agent
    const d = await swain(["keys", "create", "--project", "other", "--save"], home);
    assert.equal(d.code, 0, d.err);
    assert.match(d.out, /pinned to other/);
    // --no-pin is explicit
    const n = await swain(["keys", "create", "--project", "free", "--no-pin", "--save"], home);
    assert.match(n.out, /not pinned/);
    // choosing no output at all is a usage error and creates no key
    const none = await swain(["keys", "create", "--project", "noout"], home);
    assert.equal(none.code, 2);
    const list = await swain(["keys", "list"], home);
    assert.doesNotMatch(list.out, /noout/);
    assert.doesNotMatch(list.out, new RegExp(secret.slice(-64)));
    assert.match(list.out, /planner/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("keys create --show-secret prints the secret once; revoke stops ingest", async () => {
  const home = tmpHome();
  try {
    const s = await serve(home);
    const r = await swain(["keys", "create", "--project", "demo", "--show-secret"], home);
    assert.equal(r.code, 0, r.err);
    const m = /secret:\s+(swn_[0-9a-f]{16}_[0-9a-f]{64})/.exec(r.out);
    assert.ok(m?.[1] !== undefined);
    assert.equal(existsSync(credFile(home, "demo")), false, "no file without --save");
    const keyId = /created key (key_[0-9a-f]{16})/.exec(r.out)?.[1];
    assert.ok(keyId !== undefined);
    const post = (): Promise<Response> =>
      fetch(`${s.origin}/v1/traces`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${m[1]}` },
        body: fixture("traces-genai.json"),
      });
    assert.equal((await post()).status, 200);
    const rv = await swain(["keys", "revoke", keyId], home);
    assert.equal(rv.code, 0, rv.err);
    assert.equal((await post()).status, 401);
    const list = await swain(["keys", "list"], home);
    assert.match(list.out, /revoked/);
    assert.equal((await swain(["keys", "revoke", "key_ffffffffffffffff"], home)).code, 6);
    assert.equal((await swain(["keys", "revoke", "nope"], home)).code, 2);
    assert.equal(await s.stop(), 0);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("status: authenticates the server first and reports; down server is exit 8", async () => {
  const home = tmpHome();
  try {
    const down = await swain(["status", "--server", "http://127.0.0.1:1"], home);
    assert.equal(down.code, 8, down.err);
    const s = await serve(home);
    const k = await swain(
      ["keys", "create", "--project", "demo", "--agent", "planner", "--save"],
      home,
    );
    assert.equal(k.code, 0, k.err);
    assert.match(
      k.out,
      new RegExp(`origin:  ${s.origin}`),
      "the origin comes from the runtime file",
    );
    // a credential is bound to its origin: another server is refused, not tried
    const mism = await swain(
      ["status", "--project", "demo", "--server", "http://127.0.0.1:1"],
      home,
    );
    assert.equal(mism.code, 2);
    assert.match(mism.err, /origin/);
    const ok = await swain(["status", "--project", "demo"], home);
    assert.equal(ok.code, 0, ok.err);
    assert.match(ok.out, /authenticated/);
    assert.match(ok.out, /demo/);
    const c2 = loadCredential(join(home, ".config"), "demo", currentUid(home, [home]));
    assert.doesNotMatch(ok.out, new RegExp(c2.secret.slice(-64)));
    const res = await sendOtlpJson(c2, "traces", fixture("traces-genai.json"), null);
    assert.equal(res.status, 200);
    const json = await swain(["status", "--project", "demo", "--json"], home);
    assert.equal(json.code, 0, json.err);
    const parsed = JSON.parse(json.out) as { authenticated: boolean; projects: { runs: number }[] };
    assert.equal(parsed.authenticated, true);
    assert.equal(parsed.projects.find((p) => p.runs > 0)?.runs, 1);
    assert.equal(await s.stop(), 0);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("status against a listener that fails the proof: exit 8 and the key is never sent", async () => {
  const home = tmpHome();
  try {
    const k = await swain(["keys", "create", "--project", "demo", "--save"], home);
    assert.equal(k.code, 0, k.err);
    // a fake server on a free port; rewrite the credential's origin to it
    const seen: (string | undefined)[] = [];
    const srv = createServer((req, res) => {
      seen.push(req.headers.authorization);
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/healthz") res.end('{"ok":true}');
      else if (req.url === "/api/v1/server-proof") {
        const port = (srv.address() as AddressInfo).port;
        res.end(
          JSON.stringify({
            origin: `http://127.0.0.1:${port}`,
            instanceId: "0".repeat(32),
            proof: "0".repeat(64),
          }),
        );
      } else res.end("{}");
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    try {
      const port = (srv.address() as AddressInfo).port;
      const path = credFile(home, "demo");
      const body = readFileSync(path, "utf8").replace(
        "http://127.0.0.1:4318",
        `http://127.0.0.1:${port}`,
      );
      rmSync(path);
      writeFileSync(path, body, { mode: 0o600 });
      const r = await swain(["status", "--project", "demo"], home);
      assert.equal(r.code, 8, r.out + r.err);
      assert.deepEqual(
        seen.filter((a) => a !== undefined),
        [],
        "no Authorization header was sent",
      );
    } finally {
      await new Promise<void>((r) => srv.close(() => r()));
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("open --require-login: prints a literal-IP login URL with no next parameter and never launches a browser", async () => {
  const home = tmpHome();
  try {
    const s = await serve(home, ["--require-login"]);
    const r = await swain(["open"], home);
    assert.equal(r.code, 0, r.err);
    const url = /(http:\/\/\S+)/.exec(r.out)?.[1];
    assert.ok(url !== undefined);
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/login\?code=[A-Za-z0-9_-]{43}$/);
    assert.doesNotMatch(url, /next=/);
    assert.match(r.out, /xdg-open/);
    assert.match(r.out, /60 s/);
    assert.equal(url.startsWith(s.origin), true);
    // the code is live and single-use through the server
    const page = await fetch(url);
    assert.equal(page.status, 200);
    const code = new URL(url).searchParams.get("code") ?? "";
    const post = (): Promise<Response> =>
      fetch(`${s.origin}/login`, {
        method: "POST",
        redirect: "manual",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: s.origin },
        body: new URLSearchParams({ code }).toString(),
      });
    assert.equal((await post()).status, 303);
    assert.notEqual((await post()).status, 303, "replay refused");
    const nf = await swain(["open", "run", `run_${"0".repeat(32)}`], home);
    assert.equal(nf.code, 6);
    assert.equal((await swain(["open", "agent", "bad"], home)).code, 2);
    assert.equal(await s.stop(), 0);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("open in default mode prints the plain page URL: no code, no login (the owner proof still runs)", async () => {
  const home = tmpHome();
  try {
    const s = await serve(home);
    assert.match(s.out(), /no login/);
    const r = await swain(["open"], home);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out, `${s.origin}/\n`);
    assert.equal(loginCodeCount(home), 0, "no login code row");
    assert.equal((await fetch(r.out.trim())).status, 200, "the printed URL opens without a cookie");
    assert.equal((await fetch(`${s.origin}/login`)).status, 404);
    const nf = await swain(["open", "run", `run_${"0".repeat(32)}`], home);
    assert.equal(nf.code, 6);
    assert.equal(nf.out, "");
    assert.equal((await swain(["open", "agent", "bad"], home)).code, 2);
    assert.equal(loginCodeCount(home), 0);
    assert.equal(await s.stop(), 0);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("open in default mode: no server running is still exit 8 with no output", async () => {
  const home = tmpHome();
  try {
    const s = await serve(home);
    assert.equal(await s.stop(), 0);
    const r = await swain(["open"], home);
    assert.equal(r.code, 8, r.err);
    assert.equal(r.out, "");
    assert.equal(loginCodeCount(home), 0);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("F1: a fake listener claiming webAuth none with a bad or absent proof gets exit 8 and no URL", async () => {
  for (const proofReply of ["bad", "absent"] as const) {
    const home = tmpHome();
    const fake = createServer((req, res) => {
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/healthz") return res.end('{"ok":true,"webAuth":"none"}');
      if (proofReply === "absent") {
        res.statusCode = 404;
        return res.end("{}");
      }
      const port = (fake.address() as AddressInfo).port;
      return res.end(
        JSON.stringify({
          origin: `http://127.0.0.1:${port}`,
          instanceId: INSTANCE,
          proof: "0".repeat(64),
        }),
      );
    });
    await new Promise<void>((r) => fake.listen(0, "127.0.0.1", r));
    try {
      await swain(["keys", "list"], home);
      pinRuntime(home, (fake.address() as AddressInfo).port);
      const r = await swain(["open"], home);
      assert.equal(r.code, 8, `${proofReply}: ${r.out}${r.err}`);
      assert.equal(r.out, "", `${proofReply}: no URL`);
      assert.equal(loginCodeCount(home), 0);
    } finally {
      await new Promise<void>((r) => fake.close(() => r()));
      rmSync(home, { recursive: true, force: true });
    }
  }
});

test("open treats a /healthz with an unknown webAuth as login mode: owner proof, no plain URL", async () => {
  const home = tmpHome();
  const seen: string[] = [];
  const fake = createServer((req, res) => {
    seen.push(req.url ?? "");
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/healthz") return res.end('{"ok":true,"webAuth":"nope"}');
    const port = (fake.address() as AddressInfo).port;
    return res.end(
      JSON.stringify({
        origin: `http://127.0.0.1:${port}`,
        instanceId: INSTANCE,
        proof: "0".repeat(64),
      }),
    );
  });
  await new Promise<void>((r) => fake.listen(0, "127.0.0.1", r));
  try {
    await swain(["keys", "list"], home);
    pinRuntime(home, (fake.address() as AddressInfo).port);
    const r = await swain(["open"], home);
    assert.equal(r.code, 8, r.out + r.err);
    assert.equal(r.out, "", "no plain URL is printed on an unproven mode claim");
    assert.ok(seen.includes("/api/v1/server-proof"), "the owner proof was attempted");
  } finally {
    await new Promise<void>((r) => fake.close(() => r()));
    rmSync(home, { recursive: true, force: true });
  }
});

test("connect otlp prints an http/json exporter with a placeholder and writes nothing", async () => {
  const home = tmpHome();
  try {
    const r = await swain(["connect", "otlp"], home);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /OTEL_EXPORTER_OTLP_PROTOCOL=http\/json/);
    assert.match(r.out, /OTEL_EXPORTER_OTLP_ENDPOINT=http:\/\/127\.0\.0\.1:4318/);
    assert.match(r.out, /Authorization=Bearer <SWAIN_KEY>/);
    assert.match(r.out, /otelHeadersHelper/);
    assert.match(r.out, /documented route, untested/);
    assert.equal(existsSync(join(home, ".config")), false, "no writes");
    assert.equal(existsSync(join(home, ".claude")), false, "no writes");
    assert.equal(readdirSync(home).length, 0);
    const cc = await swain(["connect", "claude-code"], home);
    assert.equal(cc.code, 0);
    assert.match(cc.out, /CLAUDE_CODE_ENABLE_TELEMETRY=1/);
    assert.doesNotMatch(cc.out, /OTEL_LOG_USER_PROMPTS/, "content flags only with --with-content");
    assert.equal(readdirSync(home).length, 0);
    // --show-secret needs a credential file
    assert.equal((await swain(["connect", "otlp", "--show-secret"], home)).code, 6);
    // with a credential the file path is referenced and the secret stays out
    await swain(["keys", "create", "--project", "demo", "--save"], home);
    const withCred = await swain(["connect", "otlp", "--project", "demo"], home);
    assert.equal(withCred.code, 0, withCred.err);
    assert.match(withCred.out, /credentials\/demo\.key/);
    assert.doesNotMatch(withCred.out, new RegExp(secretOf(home, "demo").slice(-64)));
    const shown = await swain(["connect", "otlp", "--project", "demo", "--show-secret"], home);
    assert.match(shown.out, new RegExp(secretOf(home, "demo")));
    assert.equal((await swain(["connect", "other"], home)).code, 2);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("offline commands behave exactly like atm; help lists the network commands only for swain", async () => {
  const home = tmpHome();
  try {
    for (const argv of [["--version"], ["sessions"], ["commands"], ["bogus-command"], ["show"]]) {
      let atmOut = "";
      let atmErr = "";
      const atmCode = runMain(argv, {
        stdout: {
          write: (s: string) => {
            atmOut += s;
          },
        },
        stderr: {
          write: (s: string) => {
            atmErr += s;
          },
        },
        env: { HOME: home, XDG_DATA_HOME: undefined },
        nowMs: Date.now,
      });
      const r = await swain(argv, home);
      assert.equal(r.code, atmCode, argv.join(" "));
      assert.equal(r.out, atmOut, argv.join(" "));
      assert.equal(r.err, atmErr, argv.join(" "));
    }
    const help = await swain(["--help"], home);
    assert.equal(help.code, 0);
    for (const c of [
      "serve",
      "keys create",
      "keys list",
      "keys revoke",
      "status",
      "open",
      "connect",
    ]) {
      assert.match(help.out, new RegExp(c));
    }
    assert.match(help.out, /import/);
    let atmHelp = "";
    runMain(["--help"], {
      stdout: {
        write: (s: string) => {
          atmHelp += s;
        },
      },
      stderr: { write: () => true },
      env: { HOME: home, XDG_DATA_HOME: undefined },
      nowMs: Date.now,
    });
    assert.doesNotMatch(atmHelp, /serve/);
    assert.ok(help.out.startsWith(atmHelp.replace(/\n$/, "")));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("the atm bin's module graph never reaches the server, the database, the client or node:http", () => {
  const dist = new URL("../src/", import.meta.url);
  const seen = new Set<string>();
  const queue = ["bin.js"];
  while (queue.length > 0) {
    const f = queue.pop() as string;
    if (seen.has(f)) continue;
    seen.add(f);
    const text = readFileSync(new URL(f, dist), "utf8");
    assert.doesNotMatch(text, /node:http|node:net|node:sqlite|@swain\/(server|db|client)/, f);
    for (const m of text.matchAll(/from "\.\/([^"]+\.js)"/g)) queue.push(m[1] as string);
  }
  assert.ok(!seen.has("swain.js"));
  assert.ok(![...seen].some((f) => f.startsWith("swain-")));
});

const loginCodeCount = (home: string): number => {
  const db = new DatabaseSync(dbFile(home), { readOnly: true });
  try {
    return Number((db.prepare("SELECT COUNT(*) AS n FROM login_codes").get() as { n: number }).n);
  } finally {
    db.close();
  }
};

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

const stateBase = (home: string): string => join(home, ".local", "state");
const INSTANCE = "0123456789abcdef0123456789abcdef";

function pinRuntime(home: string, port: number, instanceId = INSTANCE): void {
  writeRuntimeFile(
    stateBase(home),
    { origin: `http://127.0.0.1:${port}`, instanceId },
    currentUid(home, [home]),
  );
}

test("B2: open with no runtime file says the server is not running (exit 8), prints no URL, writes no code", async () => {
  const home = tmpHome();
  // a decoy on the old default port must see nothing (no fallback to 4318), when it can be bound
  const seen: string[] = [];
  const decoy = createServer((req: IncomingMessage, res) => {
    seen.push(req.url ?? "");
    res.end("{}");
  });
  const bound = await new Promise<boolean>((r) => {
    decoy.once("error", () => r(false));
    decoy.listen(4318, "127.0.0.1", () => r(true));
  });
  try {
    const r = await swain(["open"], home);
    assert.equal(r.code, 8, r.err);
    assert.match(r.err, /no running server/);
    assert.equal(r.out, "", "no URL");
    assert.doesNotMatch(r.err, /login\?code/);
    assert.equal(loginCodeCount(home), 0);
    if (bound) assert.deepEqual(seen, [], "the default port was never contacted");
  } finally {
    if (bound) await new Promise<void>((r) => decoy.close(() => r()));
    rmSync(home, { recursive: true, force: true });
  }
});

test("B2: open with a stale runtime file (nothing listening) exits 8 and prints no URL", async () => {
  const home = tmpHome();
  try {
    await swain(["keys", "list"], home); // creates the data location
    pinRuntime(home, await freePort());
    const r = await swain(["open"], home);
    assert.equal(r.code, 8, r.err);
    assert.match(r.err, /nothing healthy is listening/);
    assert.equal(r.out, "");
    assert.equal(loginCodeCount(home), 0);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("B2: a fake listener on the port gets no code, no URL is printed", async () => {
  const home = tmpHome();
  const seen: { url: string; body: string }[] = [];
  const fake = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      seen.push({ url: req.url ?? "", body: Buffer.concat(chunks).toString("utf8") });
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/healthz") return res.end('{"ok":true}');
      const port = (fake.address() as AddressInfo).port;
      return res.end(
        JSON.stringify({
          origin: `http://127.0.0.1:${port}`,
          instanceId: INSTANCE,
          proof: "0".repeat(64),
        }),
      );
    });
  });
  await new Promise<void>((r) => fake.listen(0, "127.0.0.1", r));
  try {
    await swain(["keys", "list"], home);
    pinRuntime(home, (fake.address() as AddressInfo).port);
    const r = await swain(["open"], home);
    assert.equal(r.code, 8, r.out + r.err);
    assert.match(r.err, /did not prove/);
    assert.equal(r.out, "");
    assert.equal(loginCodeCount(home), 0, "no login code was created");
    for (const q of seen) assert.doesNotMatch(q.url + q.body, /code|login/i);
    assert.ok(seen.every((q) => q.url === "/healthz" || q.url === "/api/v1/server-proof"));
  } finally {
    await new Promise<void>((r) => fake.close(() => r()));
    rmSync(home, { recursive: true, force: true });
  }
});

test("B2: a real server on another database (a runtime file copied across) fails the owner proof", async () => {
  const a = tmpHome();
  const b = tmpHome();
  try {
    const s = await serve(a, ["--require-login"]);
    await swain(["keys", "list"], b);
    const instance = /"instanceId":"([0-9a-f]{32})"/.exec(
      readFileSync(join(stateBase(a), "swain", `server-${s.port}.json`), "utf8"),
    )?.[1];
    assert.ok(instance !== undefined);
    pinRuntime(b, s.port, instance);
    const r = await swain(["open"], b);
    assert.equal(r.code, 8, r.out + r.err);
    assert.match(r.err, /did not prove/);
    assert.equal(r.out, "");
    assert.equal(loginCodeCount(b), 0);
    // while the same command on the right database works
    const ok = await swain(["open"], a);
    assert.equal(ok.code, 0, ok.err);
    assert.equal(await s.stop(), 0);
  } finally {
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  }
});

test("F9: a key shape in argv is refused for every command, offline ones included", async () => {
  const home = tmpHome();
  try {
    const key = `swn_0123456789abcdef_${"a".repeat(64)}`;
    for (const argv of [
      ["import", key],
      ["sessions", key],
      ["show", key],
      ["report", "--out", key],
      ["--version", key],
      ["--help", key],
      ["commands", key],
      ["bogus", key],
      ["serve", key],
    ]) {
      const r = await swain(argv, home);
      assert.equal(r.code, 2, argv.join(" "));
      assert.match(r.err, /never accepted on the command line/);
      assert.equal(r.out, "");
      assert.doesNotMatch(r.err, /swn_0123/);
    }
    assert.equal(readdirSync(home).length, 0, "nothing was created");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("F7: an existing data directory with group or other bits is refused and left as it is", async () => {
  const home = tmpHome();
  try {
    const dir = join(home, ".local", "share", "swain");
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o755);
    const r = await swain(["keys", "list"], home);
    assert.equal(r.code, 7, r.err);
    assert.equal(statSync(dir).mode & 0o777, 0o755);
    assert.equal(existsSync(dbFile(home)), false, "no database was created in it");
    // the credentials directory too
    chmodSync(dir, 0o700);
    const cdir = join(home, ".config", "swain", "credentials");
    mkdirSync(cdir, { recursive: true });
    chmodSync(cdir, 0o750);
    const k = await swain(["keys", "create", "--project", "demo", "--save"], home);
    assert.equal(k.code, 7, k.out + k.err);
    assert.equal(statSync(cdir).mode & 0o777, 0o750);
    assert.equal(readdirSync(cdir).length, 0);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("F8: a base outside HOME that does not exist is refused; no probe file lands in its parent", async () => {
  const home = tmpHome();
  const outside = tmpHome();
  try {
    const r = await swain(["keys", "list"], home, {
      XDG_DATA_HOME: join(outside, "missing", "data"),
    });
    assert.equal(r.code, 7, r.err);
    assert.deepEqual(readdirSync(outside), [], "no probe file in the parent directory");
    // an existing base outside HOME is a validated base: it works
    const ok = await swain(["keys", "list"], home, { XDG_DATA_HOME: outside });
    assert.equal(ok.code, 0, ok.err);
    assert.ok(existsSync(join(outside, "swain", "swain.sqlite")));
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
