import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { AtmError, deriveId } from "@swain/core";
import { deriveSwainId, PACKAGE_NAME, SWAIN_ID_TYPES, type SwainIdType } from "../src/index.js";

test("skeleton builds", () => {
  assert.equal(PACKAGE_NAME, "@swain/model");
});

const PRJ = "prj_00000000000000000000000000000001";

/**
 * Committed normative vectors (SPEC-003 N0). Computed once with a separate script that uses
 * `createHash` and `Buffer` directly; the test below recomputes every one of them the same way.
 */
const VECTORS: readonly {
  readonly type: SwainIdType;
  readonly components: readonly (string | number)[];
  readonly id: string;
}[] = [
  {
    type: "agt",
    components: [PRJ, "adr0002:claude-code"],
    id: "agt_1f589285ede4ae978cf308e47a14efaa",
  },
  {
    type: "agt",
    components: [PRJ, "attr:gen_ai.agent.id|planner"],
    id: "agt_5b534ed6caef89f3ac6fd429f3686989",
  },
  {
    type: "run",
    components: ["trace", PRJ, "0af7651916cd43dd8448eb211c80319c"],
    id: "run_7b1ff1b975cbf85d88a2b2a739d81243",
  },
  {
    type: "run",
    components: ["session", PRJ, "ses_0456910418276e33cd8c5ce46affbe8d"],
    id: "run_6560105431d8728e5b3462e9642c42a6",
  },
  {
    type: "run",
    components: ["import", PRJ, "imp_0456910418276e33cd8c5ce46affbe8d"],
    id: "run_4dc01344a21ba787989de4d92a45e9c5",
  },
  {
    type: "sess",
    components: [PRJ, "session.id", "toolu_é😀"],
    id: "sess_05d7535ed8dfd2a84634066eb050f076",
  },
  {
    type: "edg",
    components: [PRJ, "spawned", "agt_a", "agt_b", "otel.parent", "e1"],
    id: "edg_59e1cd1bd56b449e8e89f3e80f30f669",
  },
  { type: "agt", components: ["ab", "c"], id: "agt_8abbf5a2388220442f94b9306f1d75d0" },
  { type: "agt", components: ["a", "bc"], id: "agt_415195e37d72c0317edb950ee7870d9b" },
  { type: "run", components: ["x", 0], id: "run_652a11c027d241a814133ab888865582" },
  { type: "run", components: ["x", "0"], id: "run_652a11c027d241a814133ab888865582" },
];

/** Independent recomputation: no shared code with the implementation. */
function recompute(type: string, components: readonly (string | number)[], domain = "swain:v1:") {
  let buf = Buffer.from(`${domain}${type}\n`, "utf8");
  for (const c of components) {
    const body = Buffer.from(String(c), "utf8");
    buf = Buffer.concat([buf, Buffer.from(`${body.length}:`, "ascii"), body]);
  }
  return `${type}_${createHash("sha256").update(buf).digest("hex").slice(0, 32)}`;
}

test("committed vectors match the implementation and an independent recomputation", () => {
  for (const v of VECTORS) {
    assert.equal(deriveSwainId(v.type, v.components), v.id, JSON.stringify(v));
    assert.equal(recompute(v.type, v.components), v.id, JSON.stringify(v));
    assert.match(v.id, /^(agt|run|sess|edg)_[0-9a-f]{32}$/);
  }
});

test("length prefixes prevent concatenation ambiguity; integer and decimal string agree", () => {
  assert.notEqual(deriveSwainId("agt", ["ab", "c"]), deriveSwainId("agt", ["a", "bc"]));
  assert.equal(deriveSwainId("run", ["x", 0]), deriveSwainId("run", ["x", "0"]));
  assert.equal(deriveSwainId("agt", ["é"]), recompute("agt", ["é"]));
});

test("domain separation: nothing collides with ADR-0002 deriveId, and the type is part of the input", () => {
  const same = ["prj", "key"];
  assert.equal(recompute("evt", same, "atm:v0:"), deriveId("evt", same));
  assert.notEqual(deriveSwainId("agt", same).slice(4), deriveId("evt", same).slice(4));
  assert.notEqual(deriveSwainId("agt", same).slice(4), deriveSwainId("run", same).slice(4));
  assert.deepEqual([...SWAIN_ID_TYPES], ["agt", "run", "sess", "edg"]);
  // ADR-0002 vectors are untouched.
  assert.equal(
    deriveId("ses", ["claude-code", "native", "00000000-0000-4000-8000-000000000000"]),
    "ses_0456910418276e33cd8c5ce46affbe8d",
  );
});

test("invalid inputs throw invalid-id-component", () => {
  const bad: [unknown, unknown][] = [
    ["org", ["a"]],
    ["", ["a"]],
    ["agt", []],
    ["agt", "a"],
    ["agt", [""]],
    ["agt", [-1]],
    ["agt", [1.5]],
    ["agt", [Number.MAX_SAFE_INTEGER + 1]],
    ["agt", [Number.NaN]],
    ["agt", ["\ud800"]],
    ["agt", [null]],
    ["agt", [{}]],
    ["agt", ["x".repeat(4097)]],
    ["agt", ["é".repeat(2049)]],
    ["agt", Array.from({ length: 71 }, () => "a")],
  ];
  for (const [t, c] of bad) {
    assert.throws(
      () => deriveSwainId(t as SwainIdType, c as string[]),
      (e: unknown) => e instanceof AtmError && e.code === "invalid-id-component",
      JSON.stringify([t, c]),
    );
  }
  // Boundaries accepted.
  assert.match(deriveSwainId("agt", ["x".repeat(4096)]), /^agt_[0-9a-f]{32}$/);
  assert.match(deriveSwainId("agt", ["é".repeat(2048)]), /^agt_[0-9a-f]{32}$/);
  assert.match(
    deriveSwainId(
      "agt",
      Array.from({ length: 70 }, () => "a"),
    ),
    /^agt_[0-9a-f]{32}$/,
  );
});
