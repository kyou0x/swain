import assert from "node:assert/strict";
import { test } from "node:test";
import { REDACTION_MARK, redactText } from "../../src/content/redact.js";

const GHP = `ghp_${"a1B2c3D4e5".repeat(4).slice(0, 36)}`;
const PEM =
  "-----BEGIN RSA PRIVATE KEY-----\nMIIEvQIBADANBgkq\nabcdef\n-----END RSA PRIVATE KEY-----";

test("each documented secret class is masked and counted", () => {
  const cases: [string, string][] = [
    ["AKIAIOSFODNN7EXAMPLE", "id"],
    ["ASIAIOSFODNN7EXAMPLE", "sts"],
    [GHP, "ghp"],
    ["gho_abcdefghijklmnopqrstuvwxyz0123456789", "gho"],
    [`github_pat_${"A1b2C3d4E5".repeat(4)}`, "pat"],
    ["sk-abcdefghijklmnopqrstuvwxyz0123", "sk"],
    ["sk-ant-api03-abcdefghijklmnopqrstu", "sk-ant"],
    ["xoxb-1234567890-abcdefghij", "slack"],
  ];
  for (const [secret, name] of cases) {
    const r = redactText(`before ${secret} after`);
    assert.equal(r.text, `before ${REDACTION_MARK} after`, name);
    assert.equal(r.count, 1, name);
  }
});

test("PEM private key blocks, including unterminated ones", () => {
  const r = redactText(`x\n${PEM}\ny`);
  assert.equal(r.text, `x\n${REDACTION_MARK}\ny`);
  assert.equal(r.count, 1);
  const cut = redactText("a -----BEGIN PRIVATE KEY-----\nMIIEv");
  assert.equal(cut.text, `a ${REDACTION_MARK}`);
  assert.equal(cut.count, 1);
});

test("Bearer tokens keep the scheme word", () => {
  const r = redactText("Authorization: Bearer abcdefghijklmnop1234");
  assert.equal(r.text, `Authorization: Bearer ${REDACTION_MARK}`);
  assert.equal(r.count, 1);
  assert.equal(redactText("bearer short").count, 0);
});

test("password, secret and token assignments keep the key", () => {
  const cases: [string, string][] = [
    ["password=hunter2", `password=${REDACTION_MARK}`],
    ["PASSWORD: hunter2", `PASSWORD: ${REDACTION_MARK}`],
    ['{"secret":"s3cr3t value"}', `{"secret":${REDACTION_MARK}}`],
    ["export GITHUB_TOKEN=abc123", `export GITHUB_TOKEN=${REDACTION_MARK}`],
    ["client_secret = 'q w e'", `client_secret = ${REDACTION_MARK}`],
    ["api_key=zzz;", `api_key=${REDACTION_MARK};`],
  ];
  for (const [input, out] of cases) {
    const r = redactText(input);
    assert.equal(r.text, out, input);
    assert.equal(r.count, 1, input);
  }
});

test("text without secrets is unchanged and not counted", () => {
  const plain = "tokenize the passwords list; secretary of state; sk-short";
  assert.deepEqual(redactText(plain), { text: plain, count: 0 });
});

test("masking is idempotent and counts every span", () => {
  const input = `a ${GHP} b AKIAIOSFODNN7EXAMPLE c password=x1`;
  const once = redactText(input);
  assert.equal(once.count, 3);
  assert.deepEqual(redactText(once.text), { text: once.text, count: 0 });
});

test("hostile input stays linear (no catastrophic backtracking)", () => {
  const started = Date.now();
  redactText("a".repeat(1_000_000));
  redactText("password".repeat(100_000));
  redactText(`${"-----BEGIN PRIVATE KEY-----".repeat(5000)}`);
  redactText("Bearer ".repeat(100_000));
  redactText(`${"a=".repeat(200_000)}token`);
  assert.ok(Date.now() - started < 10_000);
});
