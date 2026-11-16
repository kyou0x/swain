// Run only by canary.permission.test.ts, under `node --permission --allow-fs-read=<repo root>`.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const permission = process.permission;
assert.ok(permission !== undefined, "process.permission must exist under --permission");
assert.equal(permission.has("child"), false);
assert.equal(permission.has("fs.write"), false);
assert.equal(permission.has("worker"), false);

let code: unknown;
try {
  readFileSync("/etc/passwd");
} catch (e) {
  code = (e as { code?: unknown }).code;
}
assert.equal(code, "ERR_ACCESS_DENIED");
process.stdout.write("canary-ok\n");
