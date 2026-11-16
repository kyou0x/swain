import assert from "node:assert/strict";
import { test } from "node:test";
import { PACKAGE_NAME } from "../src/index.js";

test("skeleton builds", () => {
  assert.equal(PACKAGE_NAME, "@swain/server");
});
