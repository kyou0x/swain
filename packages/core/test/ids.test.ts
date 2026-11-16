import assert from "node:assert/strict";
import { test } from "node:test";
import { AtmError } from "../src/errors.js";
import { deriveId, sha256Hex } from "../src/ids/index.js";

const enc = new TextEncoder();
const FILE_SHA = "cf515a4acc6e41e0f111f01c78b13ba4253f611de9374474864f01e69a90c08f";
const SRC = "src_20810c77e61076b845483cdd6effd831";

test("sha256Hex vectors (ADR-0002 section 6)", () => {
  assert.equal(
    sha256Hex(enc.encode('{"type":"turn.started"}')),
    "7306b54975174c6eb5111d663a47de795d167520e43cf66ee2923218b19fdb75",
  );
  assert.equal(sha256Hex(enc.encode('{"type":"turn.started"}\n')), FILE_SHA);
});

test("deriveId vectors (ADR-0002 section 6, all rows)", () => {
  assert.equal(deriveId("src", ["codex-cli", "codex-cli.exec-jsonl", `sha256:${FILE_SHA}`]), SRC);
  assert.equal(
    deriveId("evt", ["codex-cli", SRC, "r", 0, 0]),
    "evt_e28e3b07981adc5141264668ec4d699d",
  );
  assert.equal(
    deriveId("evt", ["codex-cli", SRC, "r", 0, 1]),
    "evt_8bb4f1c2c226b6c4edd0c526e291ea9b",
  );
  assert.equal(
    deriveId("evt", ["codex-cli", SRC, "r", 1, 0]),
    "evt_edd241c839d58eacf25615e3da6c3ede",
  );
  assert.equal(
    deriveId("ses", ["claude-code", "native", "00000000-0000-4000-8000-000000000000"]),
    "ses_0456910418276e33cd8c5ce46affbe8d",
  );
  assert.equal(
    deriveId("tc", ["claude-code", SRC, "toolu_é\u{1f600}"]),
    "tc_9df36bfdeb9fd87cd3ea8c32ff21453a",
  );
  assert.equal(deriveId("evt", ["ab", "c"]), "evt_979219cea6e2cbbda23016f9aa5c7ddd");
  assert.equal(deriveId("evt", ["a", "bc"]), "evt_6fb5845637d0f29bf9de939efcc5390a");
});

test("integer component and its decimal string are equivalent (I1)", () => {
  assert.equal(deriveId("evt", ["x", 0]), deriveId("evt", ["x", "0"]));
});

function rejects(components: readonly (string | number)[]): void {
  assert.throws(
    () => deriveId("evt", components),
    (e: unknown) => e instanceof AtmError && e.code === "invalid-id-component",
  );
}

test("deriveId rejections", () => {
  rejects([""]);
  rejects([-1]);
  rejects([1.5]);
  rejects([2 ** 53]);
  rejects(["\ud800"]);
  rejects([]);
  rejects(Array.from({ length: 71 }, () => "a"));
  rejects(["a".repeat(4097)]);
  rejects([Number.NaN]);
  rejects([Number.POSITIVE_INFINITY]);
});

test("deriveId boundary acceptance", () => {
  assert.match(deriveId("evt", ["a".repeat(4096)]), /^evt_[0-9a-f]{32}$/);
  assert.match(
    deriveId(
      "evt",
      Array.from({ length: 70 }, () => "a"),
    ),
    /^evt_[0-9a-f]{32}$/,
  );
  assert.match(deriveId("evt", [Number.MAX_SAFE_INTEGER]), /^evt_[0-9a-f]{32}$/);
});
