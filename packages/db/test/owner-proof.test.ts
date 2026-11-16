/** G3-auth B2: the owner proof key and the server's answer to an owner challenge. */
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { NOW_ISO, openStore, tempDir } from "./helpers.js";

function lp(s: string): Buffer {
  const b = Buffer.from(s, "utf8");
  return Buffer.concat([Buffer.from(`${b.length}:`, "ascii"), b]);
}

const ORIGIN = "http://127.0.0.1:4318";
const INSTANCE = "0123456789abcdef0123456789abcdef";
const CHALLENGE = "ab".repeat(32);

test("ownerProof is null until the server secret exists, then matches the documented HMAC", () => {
  const t = tempDir();
  try {
    const store = openStore(t.dir);
    store.migrate({ nowIso: () => NOW_ISO });
    assert.equal(store.ownerProof(ORIGIN, INSTANCE, CHALLENGE), null);
    const key = store.ownerProofKey(NOW_ISO);
    assert.match(key, /^[0-9a-f]{64}$/);
    assert.equal(store.ownerProofKey(NOW_ISO), key, "stable");
    const want = createHmac("sha256", Buffer.from(key, "hex"))
      .update(Buffer.concat([lp("swain:v1:owner-proof"), lp(ORIGIN), lp(INSTANCE), lp(CHALLENGE)]))
      .digest("hex");
    assert.equal(store.ownerProof(ORIGIN, INSTANCE, CHALLENGE), want);
    // bound to the origin, the instance and the challenge
    assert.notEqual(store.ownerProof("http://127.0.0.1:4319", INSTANCE, CHALLENGE), want);
    assert.notEqual(store.ownerProof(ORIGIN, "f".repeat(32), CHALLENGE), want);
    assert.notEqual(store.ownerProof(ORIGIN, INSTANCE, "cd".repeat(32)), want);
    // malformed input is a null, not an exception
    assert.equal(store.ownerProof(ORIGIN, "zz", CHALLENGE), null);
    assert.equal(store.ownerProof(ORIGIN, INSTANCE, "zz"), null);
    store.close();
  } finally {
    t.done();
  }
});

test("the owner key is domain-separated from every key's server-proof key", () => {
  const t = tempDir();
  try {
    const store = openStore(t.dir);
    store.migrate({ nowIso: () => NOW_ISO });
    const { project, org } = store.ensureLocalTenancy(NOW_ISO);
    const made = store.createKey(
      { orgId: org.orgId, projectId: project.projectId },
      { label: "k", scopes: ["ingest:otlp"], createdBy: "test", createdAt: NOW_ISO },
    );
    const owner = store.ownerProofKey(NOW_ISO);
    assert.notEqual(owner, made.serverProofKey);
    // a key holder's proof key cannot answer an owner challenge
    const forged = createHmac("sha256", Buffer.from(made.serverProofKey, "hex"))
      .update(Buffer.concat([lp("swain:v1:owner-proof"), lp(ORIGIN), lp(INSTANCE), lp(CHALLENGE)]))
      .digest("hex");
    assert.notEqual(store.ownerProof(ORIGIN, INSTANCE, CHALLENGE), forged);
    store.close();
  } finally {
    t.done();
  }
});
