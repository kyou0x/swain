import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const script = fileURLToPath(new URL("./canary/permission-canary.js", import.meta.url));

// C3 canary: the permission model flags exist under these names in this Node and really
// deny child processes, writes and out-of-root reads. The permission model is NOT claimed
// to block network access in Node 24.
test("node --permission --allow-fs-read denies child, fs.write and outside reads", () => {
  const r = spawnSync(process.execPath, ["--permission", `--allow-fs-read=${root}`, script], {
    encoding: "utf8",
  });
  assert.equal(r.status, 0, `canary exit status (stderr length ${r.stderr.length})`);
  assert.equal(r.stdout, "canary-ok\n");
});

test("canary script fails without the permission model (it is a real check)", () => {
  const r = spawnSync(process.execPath, [script], { encoding: "utf8" });
  assert.notEqual(r.status, 0);
});
