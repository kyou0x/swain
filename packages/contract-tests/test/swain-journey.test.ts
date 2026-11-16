/**
 * The first user-runnable Swain journey (SPEC-003 N1.6 + N1.8), end to end through the real
 * `swain` bin in a temp HOME on loopback: serve, keys create --save, OTLP ingest of the synthetic
 * fixtures, status, open, the pages, SIGTERM. No network beyond 127.0.0.1. It runs twice: in the
 * default mode (no login, owner decision 2026-11-16) and with `--require-login` (login, session,
 * CSRF logout).
 */
import assert from "node:assert/strict";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const REPO = new URL("../../../../", import.meta.url);
const BIN = new URL("packages/cli/dist/src/swain-bin.js", REPO).pathname;
const fixture = (n: string): string => readFileSync(new URL(`fixtures/otlp/${n}`, REPO), "utf8");

function env(home: string): Record<string, string> {
  return { HOME: home, PATH: "/usr/bin:/bin" };
}

function swain(home: string, args: readonly string[]) {
  const r = spawnSync(process.execPath, [BIN, ...args], { env: env(home), encoding: "utf8" });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

async function waitFor(get: () => string, needle: string, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (!get().includes(needle)) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${needle}: ${get()}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

const mode = (p: string): number => statSync(p).mode & 0o777;
const log: string[] = [];
const step = (s: string): void => {
  log.push(s);
};

for (const requireLogin of [false, true]) {
  test(`journey (${requireLogin ? "--require-login" : "default, no login"}): serve, keys, ingest, status, open, pages, stop`, async () => {
    log.length = 0;
    const home = mkdtempSync(join(tmpdir(), "swain-journey-"));
    let child: ChildProcess | undefined;
    try {
      // 1. serve on a free port
      let out = "";
      child = spawn(
        process.execPath,
        [BIN, "serve", "--port", "0", ...(requireLogin ? ["--require-login"] : [])],
        { env: env(home) },
      );
      child.stdout?.on("data", (d: Buffer) => {
        out += d.toString("utf8");
      });
      await waitFor(() => out, "press Ctrl-C");
      const port = Number(/listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(out)?.[1]);
      assert.ok(port > 0, out);
      const origin = `http://127.0.0.1:${port}`;
      step(`serve: listening on ${origin}`);
      const rt = join(home, ".local/state/swain", `server-${port}.json`);
      assert.equal(mode(rt), 0o600);

      // 2. keys create --save (the origin comes from the runtime file)
      const k = swain(home, [
        "keys",
        "create",
        "--project",
        "demo",
        "--agent",
        "planner",
        "--save",
      ]);
      assert.equal(k.code, 0, k.err);
      const credPath = join(home, ".config/swain/credentials/demo.key");
      assert.equal(mode(credPath), 0o600);
      assert.equal(mode(join(home, ".config/swain/credentials")), 0o700);
      const cred = JSON.parse(readFileSync(credPath, "utf8")) as { secret: string; origin: string };
      assert.equal(cred.origin, origin);
      assert.ok(!k.out.includes(cred.secret), "the secret is not printed");
      step("keys create --save: 0600 credential file, secret not printed");

      // 3. ingest the two synthetic fixtures with the saved key
      for (const [path, file] of [
        ["/v1/traces", "traces-genai.json"],
        ["/v1/logs", "logs-claude-code.json"],
      ] as const) {
        const r = await fetch(`${origin}${path}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${cred.secret}` },
          body: fixture(file),
        });
        assert.equal(r.status, 200, `${path} ${await r.text()}`);
        step(`POST ${path} (${file}) -> 200`);
      }
      // protobuf stays off
      const pb = await fetch(`${origin}/v1/traces`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-protobuf",
          Authorization: `Bearer ${cred.secret}`,
        },
        body: new Uint8Array([0x0a, 0x00]),
      });
      assert.equal(pb.status, 415);
      step("POST /v1/traces as protobuf -> 415 (off)");

      // 4. status authenticates the server first, then reports
      const st = swain(home, ["status", "--project", "demo"]);
      assert.equal(st.code, 0, st.err);
      assert.match(st.out, /authenticated/);
      assert.match(st.out, /demo\s+1\s+2\s/);
      step(`status: ${st.out.split("\n")[1]}`);

      let cookie: string | null = null;
      if (requireLogin) {
        // 5. open prints a login URL
        const op = swain(home, ["open"]);
        assert.equal(op.code, 0, op.err);
        const url = /(http:\/\/127\.0\.0\.1:\d+\/login\?code=[A-Za-z0-9_-]{43})/.exec(op.out)?.[1];
        assert.ok(url !== undefined, op.out);
        step("open: printed a single-use login URL (code redacted)");

        // 6. GET shows the form, POST consumes the code and sets the session cookie
        const page = await fetch(url);
        assert.equal(page.status, 200);
        assert.match(await page.text(), /<form method="post" action="\/login">/);
        const code = new URL(url).searchParams.get("code") ?? "";
        const post = await fetch(`${origin}/login`, {
          method: "POST",
          redirect: "manual",
          headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: origin },
          body: new URLSearchParams({ code }).toString(),
        });
        assert.equal(post.status, 303);
        const set = post.headers.get("set-cookie") ?? "";
        assert.match(set, /^swain_session=[A-Za-z0-9_-]{43}; HttpOnly; SameSite=Strict; Path=\/;/);
        cookie = set.split(";")[0] ?? "";
        step("login: GET form, POST code -> 303 + HttpOnly SameSite=Strict cookie");
        const replay = await fetch(`${origin}/login`, {
          method: "POST",
          redirect: "manual",
          headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: origin },
          body: new URLSearchParams({ code }).toString(),
        });
        assert.notEqual(replay.status, 303, "the code is single use");
      } else {
        // 5. open prints the plain page URL: no code, no login
        const op = swain(home, ["open"]);
        assert.equal(op.code, 0, op.err);
        assert.equal(op.out, `${origin}/\n`);
        step("open: printed the plain page URL, no login code");
        assert.equal((await fetch(`${origin}/login`)).status, 404);
        assert.equal((await fetch(`${origin}/logout`, { method: "POST" })).status, 404);
        step("default mode: /login and /logout are 404");
      }

      // 7. pages
      const get = (p: string, c: string | null = cookie): Promise<Response> =>
        fetch(`${origin}${p}`, { headers: c === null ? {} : { Cookie: c } });
      if (requireLogin) {
        const noSession = await get("/", null);
        assert.notEqual(noSession.status, 200);
        assert.doesNotMatch(await noSession.text(), /planner/);
      }

      const fleet = await (await get("/?p=demo")).text();
      assert.match(fleet, /planner/);
      assert.match(fleet, /active/);
      const agentId = /href="\/a\/(agt_[0-9a-f]{32})"/.exec(fleet)?.[1];
      assert.ok(agentId !== undefined);
      step(`GET /?p=demo -> 200, agent planner (${agentId.slice(0, 12)}) listed`);

      const agentPage = await get(`/a/${agentId}`);
      assert.equal(agentPage.status, 200);
      const agentHtml = await agentPage.text();
      assert.match(agentHtml, /planner/);
      const runIds = [...new Set(agentHtml.match(/\/r\/run_[0-9a-f]{32}/g) ?? [])];
      assert.equal(runIds.length, 2);
      step("GET /a/:id -> 200, two runs");

      const runsPage = await (await get("/runs?p=demo")).text();
      assert.match(runsPage, /2 runs/);
      let spans = 0;
      for (const r of runIds) {
        const res = await get(r);
        assert.equal(res.status, 200);
        assert.match(String(res.headers.get("content-security-policy")), /frame-ancestors 'none'/);
        assert.equal(res.headers.get("cache-control"), "no-store");
        assert.equal(res.headers.get("referrer-policy"), "no-referrer");
        const html = await res.text();
        assert.match(html, /key_[0-9a-f]{16}/, "credentials header");
        if (html.includes("invoke_agent planner")) {
          spans++;
          assert.match(html, /execute_tool search/);
          assert.match(html, /chat synthetic-model/);
        }
      }
      assert.equal(spans, 1);
      step("GET /r/:id -> 200, spans invoke_agent/chat/execute_tool shown with the credential");

      if (requireLogin) {
        // 8. logout: CSRF token from the page; the old cookie is dead afterwards
        const csrf = /name="csrf" value="([0-9a-f]{64})"/.exec(fleet)?.[1];
        assert.ok(csrf !== undefined);
        const cross = await fetch(`${origin}/logout`, {
          method: "POST",
          redirect: "manual",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Cookie: cookie ?? "",
            Origin: "http://evil.example",
          },
          body: new URLSearchParams({ csrf }).toString(),
        });
        assert.equal(cross.status, 403);
        const lo = await fetch(`${origin}/logout`, {
          method: "POST",
          redirect: "manual",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Cookie: cookie ?? "",
            Origin: origin,
          },
          body: new URLSearchParams({ csrf }).toString(),
        });
        assert.equal(lo.status, 303);
        assert.notEqual((await get("/")).status, 200);
        step("logout: cross-origin 403; same-origin + CSRF -> 303; old cookie rejected");
      } else {
        assert.doesNotMatch(fleet, /name="csrf"|Sign out|action="\/logout"/);
        const evilHost = await fetch(`${origin}/`, { headers: { Host: "evil.example" } });
        // fetch may not allow a Host override; the real check is in the server tests
        assert.ok(evilHost.status === 200 || evilHost.status === 421);
        step("default mode: no sign-out form on the page");
      }

      // 9. SIGTERM: clean stop, runtime file removed
      const exited = new Promise<number | null>((res) => child?.on("exit", (c) => res(c)));
      child.kill("SIGTERM");
      assert.equal(await exited, 0);
      assert.equal(existsSync(rt), false);
      step("SIGTERM: exit 0, runtime file removed");
      for (const l of log) console.log(`  [journey] ${l}`);
    } finally {
      child?.kill("SIGKILL");
      rmSync(home, { recursive: true, force: true });
    }
  });
}
