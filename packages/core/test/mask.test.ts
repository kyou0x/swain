import assert from "node:assert/strict";
import { test } from "node:test";
import { maskHome } from "../src/index.js";

test("maskHome replaces a leading home directory with ~", () => {
  assert.equal(maskHome("/home/u/.codex/a.jsonl", "/home/u"), "~/.codex/a.jsonl");
  assert.equal(maskHome("/home/u", "/home/u"), "~");
  assert.equal(maskHome("/home/u/", "/home/u"), "~/");
});

test("maskHome tolerates trailing slashes on homeDir", () => {
  assert.equal(maskHome("/home/u/x", "/home/u/"), "~/x");
  assert.equal(maskHome("/home/u/x", "/home/u//"), "~/x");
});

test("maskHome only matches whole path components", () => {
  assert.equal(maskHome("/home/user/x", "/home/u"), "/home/user/x");
  assert.equal(maskHome("/home/u2", "/home/u"), "/home/u2");
});

test("maskHome leaves paths unchanged without a usable home", () => {
  assert.equal(maskHome("/home/u/x", null), "/home/u/x");
  assert.equal(maskHome("/home/u/x", ""), "/home/u/x");
  assert.equal(maskHome("/home/u/x", "home/u"), "/home/u/x");
  assert.equal(maskHome("/etc/passwd", "/"), "/etc/passwd");
  assert.equal(maskHome("/etc/passwd", "//"), "/etc/passwd");
});

test("maskHome is case-sensitive, anchored at the start and idempotent", () => {
  assert.equal(maskHome("/Home/u/x", "/home/u"), "/Home/u/x");
  assert.equal(maskHome("/tmp/home/u/x", "/home/u"), "/tmp/home/u/x");
  assert.equal(maskHome(maskHome("/home/u/x", "/home/u"), "/home/u"), "~/x");
  assert.equal(maskHome("relative/x", "/home/u"), "relative/x");
});
