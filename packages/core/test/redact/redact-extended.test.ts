import assert from "node:assert/strict";
import { test } from "node:test";
import { REDACTION_MARK, redactText, redactTextExtended } from "../../src/content/redact.js";

const M = REDACTION_MARK;
const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpM";

/** One case per ADR-0005 section 6.4 pattern: [name, input, expected output]. */
const CASES: readonly (readonly [string, string, string])[] = [
  ["jwt", `t ${JWT} e`, `t ${M} e`],
  ["basic", "Authorization: Basic dXNlcjpwYXNzd29yZA== x", `Authorization: Basic ${M} x`],
  ["swain key", `k swn_${"0123456789abcdef"}_${"f".repeat(64)} e`, `k ${M} e`],
  [
    "swain key url-encoded bearer",
    `Authorization=Bearer%20swn_0123456789abcdef_${"a".repeat(64)}`,
    `Authorization=Bearer%20${M}`,
  ],
  ["swain key prefix only", "swn_0123456789abcdef_01234567", M],
  ["AIza", `k AIza${"B".repeat(35)} e`, `k ${M} e`],
  ["sk_live", "k sk_live_abcdefghijKLMNOP e", `k ${M} e`],
  ["rk_live", "k rk_live_abcdefghijKLMNOP e", `k ${M} e`],
  ["glpat", `k glpat-${"a1".repeat(10)} e`, `k ${M} e`],
  ["npm", `k npm_${"a1".repeat(18)} e`, `k ${M} e`],
  ["hf", `k hf_${"aB".repeat(15)} e`, `k ${M} e`],
  ["ya29", `k ya29.${"a-B_".repeat(6)} e`, `k ${M} e`],
  ["SG", `k SG.${"a".repeat(22)}.${"b".repeat(22)} e`, `k ${M} e`],
  ["slack webhook", "u https://hooks.slack.com/services/T000/B000/XXXXXXXX e", `u ${M} e`],
  ["discord webhook", "u https://discord.com/api/webhooks/123456789/abcDEF_ghi-JKL e", `u ${M} e`],
  ["userinfo https", "https://user:pw@host.example/p", `https://${M}@host.example/p`],
  ["postgres", "postgres://u:p@h:5432/db", `postgres://${M}@h:5432/db`],
  ["mysql", "mysql://root:hunter2@db/x", `mysql://${M}@db/x`],
  ["mongodb+srv", "mongodb+srv://a:b@c.example/d", `mongodb+srv://${M}@c.example/d`],
  ["redis", "redis://:secretpw@cache:6379", `redis://${M}@cache:6379`],
  ["ADO Pwd", "Server=a;Pwd=hunter2;Db=b", `Server=a;Pwd=${M};Db=b`],
  ["query sig", "https://h/p?a=1&sig=abc123&b=2", `https://h/p?a=1&sig=${M}&b=2`],
  ["query access_token", "https://h/p?access_token=zzz", `https://h/p?access_token=${M}`],
  ["query X-Amz-Signature", "h/p?X-Amz-Signature=deadbeef", `h/p?X-Amz-Signature=${M}`],
  ["query X-Goog-Signature", "h/p?X-Goog-Signature=deadbeef", `h/p?X-Goog-Signature=${M}`],
  ["--password x", "run --password hunter2 now", `run --password ${M} now`],
  ["--token x", "run --token abc123 now", `run --token ${M} now`],
  ["curl -u", "curl -u alice:pw https://h", `curl -u ${M} https://h`],
  ["mysql -p", "mysql -h h -u root -psecretpw db", `mysql -h h -u root -p${M} db`],
  ["psql -p spaced", "psql -h h -p topsecret db", `psql -h h -p ${M} db`],
];

test("each new pattern masks and counts", () => {
  for (const [name, input, expected] of CASES) {
    const r = redactTextExtended(input);
    assert.equal(r.text, expected, name);
    assert.ok(r.count >= 1, name);
  }
});

test("a purely numeric spaced -p after psql (a port) is kept", () => {
  assert.equal(redactTextExtended("psql -h h -p 5432 db").text, "psql -h h -p 5432 db");
});

test("high-entropy token: masked; UUIDs and 16/32/64 lowercase hex are exempt", () => {
  const secret = "aB3dE5gH7jK9mN1pQ3sT5vW7yZ2bD4fG6hJ8kL0n";
  assert.equal(secret.length, 40);
  const r = redactTextExtended(`x ${secret} y`);
  assert.equal(r.text, `x ${M} y`);
  assert.equal(r.count, 1);
  const exempt = [
    "0af7651916cd43dd8448eb211c80319c",
    "0af7651916cd43dd",
    "0af7651916cd43dd8448eb211c80319c0af7651916cd43dd8448eb211c80319c",
    "123e4567-e89b-42d3-a456-426614174000",
    "123E4567-E89B-42D3-A456-426614174000",
  ];
  for (const e of exempt) {
    assert.equal(redactTextExtended(`id=${e}`).text, `id=${e}`, e);
    assert.equal(redactTextExtended(e).count, 0, e);
  }
});

test("high-entropy heuristic needs length >= 24, three character classes and entropy >= 4.0", () => {
  const short = "aB3dE5gH7jK9mN1pQ3sT5vW"; // 23 characters
  assert.equal(redactTextExtended(short).text, short);
  const oneClass = "abcdefghijklmnopqrstuvwxyz";
  assert.equal(redactTextExtended(oneClass).text, oneClass);
  const lowEntropy = "aA1".repeat(10); // three classes, 1.58 bits per character
  assert.equal(redactTextExtended(lowEntropy).text, lowEntropy);
  const prose = "The quick brown fox jumps over the lazy dog, repeatedly and quietly.";
  assert.equal(redactTextExtended(prose).text, prose);
});

test("negative controls: prose, ordinary URLs, git SHA, paths", () => {
  const same = [
    "see https://example.com/docs?page=2&sort=asc for details",
    "commit 4b825dc642cb6eb9a060e54bf8d69288fbee4904",
    "/usr/local/lib/node_modules/typescript/lib/tsc.js",
    "mailto:alice@example.com",
    "git@github.com:org/repo.git",
    "basic usage",
    "psql -h localhost db",
  ];
  for (const s of same) assert.equal(redactTextExtended(s).text, s, s);
});

test("redactText itself is unchanged: none of the new patterns apply", () => {
  for (const [name, input] of CASES) {
    // Some inputs overlap the legacy `token`/`password` rules; the rest must pass through.
    if (!/password|token|Pwd/i.test(input)) assert.equal(redactText(input).text, input, name);
  }
  assert.equal(redactText(`k ${"a".repeat(30)}Zx1+/9`).count, 0);
});

test("extended output is a superset: base rules still apply", () => {
  const r = redactTextExtended("export API_KEY=hunter2 and Bearer abcdefgh12345");
  assert.equal(r.text, `export API_KEY=${M} and Bearer ${M}`);
  assert.equal(r.count, 2);
});

test("linear time on hostile input", () => {
  const inputs = [
    "a".repeat(200_000),
    "://".repeat(50_000),
    `mysql ${"x ".repeat(50_000)}`,
    "eyJ".repeat(50_000),
    "A1b2".repeat(50_000),
    "-u ".repeat(50_000),
    "Basic ".repeat(30_000),
  ];
  const t0 = process.hrtime.bigint();
  for (const s of inputs) redactTextExtended(s);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(ms < 5000, `took ${ms} ms`);
});

test("a Swain key is masked by the extended rules only, and redactText stays unchanged", () => {
  const key = `swn_0123456789abcdef_${"b".repeat(64)}`;
  assert.equal(redactText(`x ${key}`).text, `x ${key}`);
  assert.equal(redactTextExtended(`x ${key}`).text, `x ${M}`);
  // a short look-alike is not masked
  assert.equal(redactTextExtended("swn_abc").text, "swn_abc");
});
