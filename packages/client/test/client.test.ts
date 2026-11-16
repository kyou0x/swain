/**
 * `@swain/client`: server-proof HMAC, origin pinning, credential files and the fake-listener cases
 * (a server that fails the proof must never see an Authorization header). Loopback only.
 */
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  authenticateOwner,
  authenticateServer,
  ClientError,
  CREDENTIAL_FORMAT,
  type Credential,
  checkHealth,
  credentialPath,
  currentUid,
  ensurePrivateDir,
  fetchStatus,
  loadCredential,
  originFor,
  parseCredential,
  parseOrigin,
  saveCredential,
  sendOtlpJson,
  serverProofHex,
} from "../src/index.js";

const uid = currentUid(tmpdir(), [tmpdir()]);
const KEY_HEX = "ab".repeat(32);
const INSTANCE = "0123456789abcdef0123456789abcdef";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "swain-client-test-"));
}

function cred(origin: string, over: Partial<Credential> = {}): Credential {
  return {
    format: CREDENTIAL_FORMAT,
    origin,
    keyId: "key_0123456789abcdef",
    secret: `swn_0123456789abcdef_${"c".repeat(64)}`,
    serverProofKey: KEY_HEX,
    projectSlug: "demo",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

function lp(s: string): Buffer {
  const b = Buffer.from(s, "utf8");
  return Buffer.concat([Buffer.from(`${b.length}:`, "ascii"), b]);
}

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    return e instanceof ClientError ? e.code : "other";
  }
  return "none";
}

async function codeAsync(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return e instanceof ClientError ? e.code : "other";
  }
  return "none";
}

interface Fake {
  readonly origin: string;
  readonly seen: {
    path: string;
    authorization: string | undefined;
    clientPort: number | undefined;
  }[];
  close(): Promise<void>;
}

interface FakeOptions {
  /** Close the connection after the proof answer (the key request then needs a new socket). */
  readonly closeAfterProof?: boolean;
  /** Answer owner challenges with this owner key (hex); a server-proof-labelled answer otherwise. */
  readonly ownerKey?: string;
}

/** A loopback server whose proof is either honest (`good`) or forged. */
async function fake(good: boolean, opts: FakeOptions = {}): Promise<Fake> {
  const seen: Fake["seen"] = [];
  const srv = createServer((req: IncomingMessage, res) => {
    seen.push({
      path: req.url ?? "",
      authorization: req.headers.authorization,
      clientPort: req.socket.remotePort,
    });
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const port = (srv.address() as AddressInfo).port;
      const origin = `http://127.0.0.1:${port}`;
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/healthz") {
        res.end('{"ok":true}');
        return;
      }
      if (req.url === "/api/v1/server-proof") {
        const { challenge, purpose } = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
          challenge: string;
          purpose?: string;
        };
        const owner = purpose === "owner";
        const label =
          owner && opts.ownerKey !== undefined ? "swain:v1:owner-proof" : "swain:v1:server-proof";
        const key = owner && opts.ownerKey !== undefined ? opts.ownerKey : KEY_HEX;
        const proof = good
          ? createHmac("sha256", Buffer.from(key, "hex"))
              .update(Buffer.concat([lp(label), lp(origin), lp(INSTANCE), lp(challenge)]))
              .digest("hex")
          : "0".repeat(64);
        if (opts.closeAfterProof === true) res.setHeader("Connection", "close");
        res.end(JSON.stringify({ origin, instanceId: INSTANCE, proof }));
        return;
      }
      res.statusCode = 200;
      res.end("{}");
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as AddressInfo).port;
  return {
    origin: `http://127.0.0.1:${port}`,
    seen,
    close: () => new Promise<void>((r) => srv.close(() => r())),
  };
}

test("serverProofHex matches the ADR-0006 section 8 construction", () => {
  const origin = "http://127.0.0.1:4318";
  const challenge = "f".repeat(64);
  const want = createHmac("sha256", Buffer.from(KEY_HEX, "hex"))
    .update(Buffer.concat([lp("swain:v1:server-proof"), lp(origin), lp(INSTANCE), lp(challenge)]))
    .digest("hex");
  assert.equal(serverProofHex(KEY_HEX, origin, INSTANCE, challenge), want);
  assert.notEqual(serverProofHex(KEY_HEX, "http://127.0.0.1:4319", INSTANCE, challenge), want);
  assert.equal(serverProofHex("zz", origin, INSTANCE, challenge), null);
});

test("parseOrigin accepts only literal loopback IP origins", () => {
  assert.equal(parseOrigin("http://127.0.0.1:4318").port, 4318);
  assert.equal(parseOrigin("http://[::1]:4318").host, "::1");
  for (const bad of [
    "http://localhost:4318",
    "https://127.0.0.1:4318",
    "http://127.0.0.1",
    "http://127.0.0.1:0",
    "http://127.0.0.1:04318",
    "http://127.0.0.1:65536",
    "http://127.0.0.1:4318/",
    "http://user@127.0.0.1:4318",
    "http://0.0.0.0:4318",
    "http://[::]:4318",
    "http://10.0.0.1:4318",
    "",
    42,
  ]) {
    assert.equal(
      code(() => parseOrigin(bad)),
      "invalid-origin",
      String(bad),
    );
  }
});

test("credential files: 0700 dirs, 0600 file, no overwrite, no symlink, strict parse", () => {
  const base = tmp();
  try {
    const c = cred("http://127.0.0.1:4318");
    const path = saveCredential(base, c, uid);
    assert.equal(path, credentialPath(base, "demo"));
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(statSync(join(base, "swain", "credentials")).mode & 0o777, 0o700);
    assert.equal(statSync(join(base, "swain")).mode & 0o777, 0o700);
    assert.deepEqual(loadCredential(base, "demo", uid), c);
    // wx: never overwrites
    assert.equal(
      code(() => saveCredential(base, c, uid)),
      "credential-exists",
    );
    // a symlink in the place of the file is refused (O_NOFOLLOW)
    const link = credentialPath(base, "linked");
    const target = join(base, "elsewhere");
    writeFileSync(target, "x");
    symlinkSync(target, link);
    assert.notEqual(
      code(() => saveCredential(base, cred(c.origin, { projectSlug: "linked" }), uid)),
      "none",
    );
    assert.equal(readFileSync(target, "utf8"), "x", "the link target was not written");
    assert.notEqual(
      code(() => loadCredential(base, "linked", uid)),
      "none",
    );
    // a group-readable file is refused
    chmodSync(path, 0o644);
    assert.equal(
      code(() => loadCredential(base, "demo", uid)),
      "credential-unsafe",
    );
    chmodSync(path, 0o600);
    // a missing file
    assert.equal(
      code(() => loadCredential(base, "nothing", uid)),
      "credential-missing",
    );
    // bad slug never reaches the filesystem
    assert.equal(
      code(() => credentialPath(base, "../x")),
      "credential-invalid",
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("parseCredential rejects unknown fields, bad secrets and mismatched key ids", () => {
  const good = cred("http://127.0.0.1:4318");
  assert.deepEqual(parseCredential(JSON.stringify(good)), good);
  for (const bad of [
    { ...good, extra: 1 },
    { ...good, secret: "swn_short" },
    { ...good, keyId: "key_ffffffffffffffff" },
    { ...good, origin: "http://localhost:4318" },
    { ...good, serverProofKey: "zz" },
    { ...good, projectSlug: "Bad Slug" },
    { ...good, format: "other/1" },
  ]) {
    assert.equal(
      code(() => parseCredential(JSON.stringify(bad))),
      bad.origin === "http://localhost:4318" ? "invalid-origin" : "credential-invalid",
    );
  }
  assert.equal(
    code(() => parseCredential("not json")),
    "credential-invalid",
  );
  assert.equal(
    code(() => parseCredential("[]")),
    "credential-invalid",
  );
});

test("origin pinning: a credential is used only for its recorded origin", () => {
  const c = cred("http://127.0.0.1:4318");
  assert.equal(originFor(c, null), c.origin);
  assert.equal(originFor(c, "http://127.0.0.1:4318"), c.origin);
  assert.equal(
    code(() => originFor(c, "http://127.0.0.1:4319")),
    "credential-origin-mismatch",
  );
  assert.equal(
    code(() => originFor(c, "http://[::1]:4318")),
    "credential-origin-mismatch",
  );
});

test("an honest server authenticates, then the key is sent", async () => {
  const f = await fake(true);
  try {
    const c = cred(f.origin);
    assert.equal(await checkHealth(f.origin), true);
    const id = await authenticateServer(c, INSTANCE);
    assert.equal(id.instanceId, INSTANCE);
    const r = await sendOtlpJson(c, "traces", new TextEncoder().encode("{}"), null);
    assert.equal(r.status, 200);
    const postAt0 = f.seen.findIndex((s) => s.path === "/v1/traces");
    const proofAt = f.seen.findLastIndex(
      (s, i) => i < postAt0 && s.path === "/api/v1/server-proof",
    );
    const postAt = f.seen.findIndex((s) => s.path === "/v1/traces");
    assert.ok(proofAt >= 0 && postAt > proofAt, "proof comes before the POST");
    assert.equal(
      f.seen[postAt]?.clientPort,
      f.seen[proofAt]?.clientPort,
      "F3: the key travels on the connection the proof arrived on",
    );
    assert.equal(f.seen[postAt]?.authorization, `Bearer ${c.secret}`);
    // proof requests carry no key
    assert.equal(f.seen[proofAt]?.authorization, undefined);
  } finally {
    await f.close();
  }
});

test("a server that fails the proof never receives an Authorization header (exit 8 class)", async () => {
  const f = await fake(false);
  try {
    const c = cred(f.origin);
    assert.equal(await codeAsync(authenticateServer(c, null)), "server-unauthenticated");
    assert.equal(await codeAsync(fetchStatus(c, null)), "server-unauthenticated");
    assert.equal(
      await codeAsync(sendOtlpJson(c, "logs", new TextEncoder().encode("{}"), null)),
      "server-unauthenticated",
    );
    for (const s of f.seen) assert.equal(s.authorization, undefined, s.path);
    assert.ok(!f.seen.some((s) => s.path === "/v1/logs" || s.path === "/api/v1/status"));
  } finally {
    await f.close();
  }
});

test("a pinned instance mismatch fails even with a valid proof", async () => {
  const f = await fake(true);
  try {
    const c = cred(f.origin);
    assert.equal(await codeAsync(authenticateServer(c, "f".repeat(32))), "server-unauthenticated");
    for (const s of f.seen) assert.equal(s.authorization, undefined);
  } finally {
    await f.close();
  }
});

test("an unreachable server is server-unreachable", async () => {
  const f = await fake(true);
  const origin = f.origin;
  await f.close();
  assert.equal(await codeAsync(checkHealth(origin)), "server-unreachable");
  assert.equal(await codeAsync(authenticateServer(cred(origin), null)), "server-unreachable");
});

test("an existing credentials directory that is group or world writable is refused", () => {
  const base = tmp();
  try {
    const dir = join(base, "swain", "credentials");
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o770);
    assert.equal(
      code(() => saveCredential(base, cred("http://127.0.0.1:4318"), uid)),
      "unsafe-directory",
    );
    assert.equal(existsSync(credentialPath(base, "demo")), false);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("F3: a server that closes the connection after the proof never receives the key", async () => {
  const f = await fake(true, { closeAfterProof: true });
  try {
    const c = cred(f.origin);
    const sent = await codeAsync(sendOtlpJson(c, "traces", new TextEncoder().encode("{}"), null));
    assert.ok(sent === "server-unreachable" || sent === "server-unauthenticated", sent);
    for (const s of f.seen) assert.equal(s.authorization, undefined, s.path);
    assert.ok(!f.seen.some((s) => s.path === "/v1/traces"), "no key request reached the listener");
    const status = await codeAsync(fetchStatus(c, null));
    assert.ok(status === "server-unreachable" || status === "server-unauthenticated", status);
    for (const s of f.seen) assert.equal(s.authorization, undefined, s.path);
  } finally {
    await f.close();
  }
});

test("F3: fetchStatus uses one connection for the proof and the key", async () => {
  const f = await fake(true);
  try {
    await fetchStatus(cred(f.origin), null).catch(() => undefined);
    const proof = f.seen.find((s) => s.path === "/api/v1/server-proof");
    const key = f.seen.find((s) => s.path === "/api/v1/status");
    assert.ok(proof !== undefined && key !== undefined);
    assert.equal(key.clientPort, proof.clientPort);
    assert.ok(key.authorization?.startsWith("Bearer swn_"));
  } finally {
    await f.close();
  }
});

const OWNER_KEY = "cd".repeat(32);

test("B2: authenticateOwner accepts the owner label only, for the dialed origin and pinned instance", async () => {
  const good = await fake(true, { ownerKey: OWNER_KEY });
  try {
    const id = await authenticateOwner(good.origin, OWNER_KEY, INSTANCE);
    assert.equal(id.instanceId, INSTANCE);
    assert.equal(
      await codeAsync(authenticateOwner(good.origin, OWNER_KEY, "f".repeat(32))),
      "server-unauthenticated",
    );
    assert.equal(
      await codeAsync(authenticateOwner(good.origin, "ee".repeat(32), null)),
      "server-unauthenticated",
    );
    assert.equal(
      await codeAsync(authenticateOwner(good.origin, "zz", null)),
      "server-unauthenticated",
    );
  } finally {
    await good.close();
  }
  // a server that signs the owner challenge with the server-proof label (or forges) fails
  const wrongLabel = await fake(true);
  const forged = await fake(false);
  try {
    assert.equal(
      await codeAsync(authenticateOwner(wrongLabel.origin, OWNER_KEY, null)),
      "server-unauthenticated",
    );
    assert.equal(
      await codeAsync(authenticateOwner(forged.origin, OWNER_KEY, null)),
      "server-unauthenticated",
    );
  } finally {
    await wrongLabel.close();
    await forged.close();
  }
});

test("F7: an existing Swain directory with any group or other bit is refused, never loosened; created ones are 0700", () => {
  const base = tmp();
  const oldMask = process.umask(0);
  try {
    // created under umask 0: still 0700
    const made = join(base, "fresh", "swain");
    ensurePrivateDir(made, uid);
    assert.equal(statSync(made).mode & 0o777, 0o700);
    assert.equal(statSync(join(base, "fresh")).mode & 0o777, 0o700);
    for (const bits of [0o755, 0o750, 0o705, 0o701, 0o770]) {
      const d = join(base, `d${bits.toString(8)}`);
      mkdirSync(d);
      chmodSync(d, bits);
      assert.equal(
        code(() => ensurePrivateDir(d, uid)),
        "unsafe-directory",
        bits.toString(8),
      );
      assert.equal(statSync(d).mode & 0o777, bits, "an existing directory is not touched");
    }
    // non-strict (a user-chosen --db directory) tolerates read bits but not write bits
    const shared = join(base, "shared");
    mkdirSync(shared);
    chmodSync(shared, 0o755);
    ensurePrivateDir(shared, uid, false);
    chmodSync(shared, 0o775);
    assert.equal(
      code(() => ensurePrivateDir(shared, uid, false)),
      "unsafe-directory",
    );
  } finally {
    process.umask(oldMask);
    rmSync(base, { recursive: true, force: true });
  }
});

test("F8: the uid probe runs only inside an allowed root; a target above it is refused", () => {
  const base = tmp();
  try {
    const sub = join(base, "home");
    mkdirSync(sub);
    assert.equal(currentUid(join(sub, "a", "b"), [sub]), uid);
    assert.equal(currentUid(sub, [sub]), uid);
    // nearest existing ancestor is `base`, which is above the root `sub/x`
    assert.equal(
      code(() => currentUid(join(base, "other", "x"), [sub])),
      "unsafe-directory",
    );
    assert.equal(
      code(() => currentUid(sub, [])),
      "unsafe-directory",
    );
    assert.equal(
      code(() => currentUid(sub, ["relative"])),
      "unsafe-directory",
    );
    // a sibling with the root as a string prefix is not inside it
    const sib = `${sub}-evil`;
    mkdirSync(sib);
    assert.equal(
      code(() => currentUid(sib, [sub])),
      "unsafe-directory",
    );
    // no probe file was left anywhere
    assert.deepEqual(readdirSync(base).sort(), ["home", "home-evil"]);
    assert.deepEqual(readdirSync(sub), []);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
