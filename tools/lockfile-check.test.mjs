import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  checkBiome,
  checkLockfile,
  checkManifests,
  checkNpmrc,
  checkWorkflow,
  computeClosure,
  installScriptEntries,
  runAll,
} from "./lockfile-check.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const realLock = JSON.parse(readFileSync(path.join(repoRoot, "package-lock.json"), "utf8"));
const closure = JSON.parse(
  readFileSync(path.join(repoRoot, "tools/expected-lock-closure.json"), "utf8"),
);

const clone = (v) => JSON.parse(JSON.stringify(v));
const codes = (failures) => failures.map((f) => f.code);

function withEntry(key, entry) {
  const lock = clone(realLock);
  lock.packages[key] = entry;
  return lock;
}
const good = {
  version: "1.0.0",
  resolved: "https://registry.npmjs.org/x/-/x-1.0.0.tgz",
  integrity: "sha512-abc",
};
const closureWith = (extra) => ({ closure: { ...closure.closure, [extra]: "sha512-abc" } });

test("the real lockfile passes, including workspace folder entries without resolved/integrity", () => {
  assert.deepEqual(checkLockfile(realLock, closure), []);
  assert.ok(
    realLock.packages["packages/core"] && realLock.packages["packages/core"].resolved === undefined,
  );
});

test("the real repository passes every check", () => {
  const { failures } = runAll(repoRoot);
  assert.deepEqual(failures, []);
});

test("closure file matches the lockfile", () => {
  assert.deepEqual(computeClosure(realLock), closure.closure);
});

test("lockfileVersion other than 3 fails", () => {
  const l = clone(realLock);
  l.lockfileVersion = 2;
  assert.ok(codes(checkLockfile(l, closure)).includes("L-LOCKVER"));
});

test("git+ dependency fails", () => {
  const e = { ...good, resolved: "git+ssh://git@github.com/x/y.git#abc" };
  const c = codes(checkLockfile(withEntry("node_modules/x", e), closureWith("x@1.0.0")));
  assert.ok(c.includes("L-RESOLVED") && c.includes("L-FORBIDDEN-REF"));
});

test("http: resolved URL fails", () => {
  const e = { ...good, resolved: "http://registry.npmjs.org/x/-/x-1.0.0.tgz" };
  const c = codes(checkLockfile(withEntry("node_modules/x", e), closureWith("x@1.0.0")));
  assert.ok(c.includes("L-RESOLVED") && c.includes("L-FORBIDDEN-REF"));
});

test("non-registry https tarball fails with L-RESOLVED only", () => {
  const e = { ...good, resolved: "https://evil.example/x.tgz" };
  assert.deepEqual(codes(checkLockfile(withEntry("node_modules/x", e), closureWith("x@1.0.0"))), [
    "L-RESOLVED",
  ]);
});

test("sha1 integrity fails with L-INTEGRITY only", () => {
  const e = { ...good, integrity: "sha1-abc" };
  assert.deepEqual(codes(checkLockfile(withEntry("node_modules/x", e), closureWith("x@1.0.0"))), [
    "L-INTEGRITY",
  ]);
});

test("an extra package fails the closure check only", () => {
  assert.deepEqual(codes(checkLockfile(withEntry("node_modules/x", good), closure)), ["L-CLOSURE"]);
  const l = clone(realLock);
  delete l.packages["node_modules/undici-types"];
  assert.deepEqual(codes(checkLockfile(l, closure)), ["L-CLOSURE"]);
});

test("file: dependency fails with L-FORBIDDEN-REF", () => {
  const e = { ...good, dependencies: { y: "file:../y" } };
  assert.ok(
    codes(checkLockfile(withEntry("node_modules/x", e), closureWith("x@1.0.0"))).includes(
      "L-FORBIDDEN-REF",
    ),
  );
  const l = clone(realLock);
  l.packages["packages/core"].dependencies = { y: "github:a/b" };
  assert.ok(codes(checkLockfile(l, closure)).includes("L-FORBIDDEN-REF"));
});

test("link entries outside @swain workspaces fail", () => {
  const e = { resolved: "somewhere", link: true };
  assert.ok(
    codes(checkLockfile(withEntry("node_modules/x", e), closureWith("x@undefined"))).includes(
      "L-LINK",
    ),
  );
});

test("@swain entries must be links to their workspace folder", () => {
  const l1 = clone(realLock);
  delete l1.packages["node_modules/@swain/core"].link;
  assert.deepEqual(codes(checkLockfile(l1, closure)), ["L-SWAIN-LINK"]);
  const l2 = clone(realLock);
  l2.packages["node_modules/@swain/core"].resolved = "packages/cli";
  assert.deepEqual(codes(checkLockfile(l2, closure)), ["L-SWAIN-LINK"]);
  const l3 = withEntry("node_modules/@swain/evil", { resolved: "packages/evil", link: true });
  assert.ok(codes(checkLockfile(l3, closure)).includes("L-SWAIN-LINK"));
  const l4 = withEntry("node_modules/a/node_modules/@swain/core", {
    resolved: "packages/core",
    link: true,
  });
  assert.ok(codes(checkLockfile(l4, closure)).includes("L-SWAIN-LINK"));
});

test("an entry that fits no group fails", () => {
  const c = codes(checkLockfile(withEntry("packages/evil", { version: "0.0.0" }), closure));
  assert.ok(c.includes("L-UNCLASSIFIED"));
});

test("install-script entries are listed, not failed", () => {
  const l = clone(realLock);
  l.packages["node_modules/typescript"].hasInstallScript = true;
  assert.deepEqual(installScriptEntries(l), ["node_modules/typescript@6.0.3"]);
  assert.deepEqual(checkLockfile(l, closure), []);
  assert.deepEqual(installScriptEntries(realLock), []);
});

const manifests = () => ({
  root: {
    devDependencies: { typescript: "6.0.3", "@types/node": "24.19.2", "@biomejs/biome": "2.6.7" },
  },
  core: {},
  cli: { dependencies: { "@swain/core": "0.0.0" } },
  contractTests: { devDependencies: { "@swain/core": "0.0.0" } },
});

test("manifest rules: good case passes", () => {
  assert.deepEqual(checkManifests(manifests()), []);
});

test("manifest rules: core with a dependencies key fails", () => {
  const m = manifests();
  m.core.dependencies = { left: "1.0.0" };
  assert.deepEqual(codes(checkManifests(m)), ["L-MANIFEST"]);
  const r = manifests();
  r.root.dependencies = {};
  assert.deepEqual(codes(checkManifests(r)), ["L-MANIFEST"]);
});

test("manifest rules: cli and contract-tests dependency sets are exact", () => {
  const a = manifests();
  a.cli.dependencies = { "@swain/core": "0.0.0", extra: "1.0.0" };
  assert.deepEqual(codes(checkManifests(a)), ["L-MANIFEST"]);
  const b = manifests();
  b.contractTests.devDependencies = { "@swain/core": "0.0.0", extra: "1.0.0" };
  assert.deepEqual(codes(checkManifests(b)), ["L-MANIFEST"]);
  const c = manifests();
  c.contractTests = { dependencies: { "@swain/core": "0.0.0" } };
  assert.deepEqual(checkManifests(c), []);
});

test("root devDependencies must be exactly the three tools", () => {
  const m = manifests();
  m.root.devDependencies.leftpad = "1.0.0";
  assert.deepEqual(codes(checkManifests(m)), ["L-DEVDEPS"]);
});

test(".npmrc must be exactly the required key set", () => {
  const ok = "ignore-scripts=true\nengine-strict=true\nsave-exact=true\nfund=false\naudit=false\n";
  assert.deepEqual(checkNpmrc(ok), []);
  assert.deepEqual(codes(checkNpmrc(ok.replace("ignore-scripts=true", "ignore-scripts=false"))), [
    "L-NPMRC",
  ]);
  assert.deepEqual(codes(checkNpmrc(`${ok}registry=https://evil.example/\n`)), ["L-NPMRC"]);
  assert.deepEqual(codes(checkNpmrc("engine-strict=true\n")), ["L-NPMRC"]);
});

test("biome.json with extends fails", () => {
  assert.deepEqual(checkBiome('{"linter":{"enabled":true}}'), []);
  assert.deepEqual(codes(checkBiome('{"extends":["./x.json"]}')), ["L-BIOME-EXTENDS"]);
  assert.deepEqual(codes(checkBiome('{"overrides":[{"extends":"x"}]}')), ["L-BIOME-EXTENDS"]);
});

test("workflow uses must be pinned to 40-hex SHAs", () => {
  const sha = "d23441a48e516b6c34aea4fa41551a30e30af803";
  assert.deepEqual(
    checkWorkflow("w.yml", `steps:\n  - uses: actions/checkout@${sha} # v6.1.0\n`),
    [],
  );
  assert.deepEqual(
    codes(checkWorkflow("w.yml", `steps:\n  - uses: actions/checkout@${"0".repeat(40)}\n`)),
    ["L-USES"],
  );
  assert.deepEqual(codes(checkWorkflow("w.yml", "steps:\n  - uses: actions/checkout@v4\n")), [
    "L-USES",
  ]);
  assert.deepEqual(
    codes(checkWorkflow("w.yml", `steps:\n  - uses: actions/checkout@${"0".repeat(39)}\n`)),
    ["L-USES"],
  );
  assert.deepEqual(
    codes(checkWorkflow("w.yml", `steps:\n  - uses: actions/checkout@${"A".repeat(40)}\n`)),
    ["L-USES"],
  );
  assert.deepEqual(codes(checkWorkflow("w.yml", "on:\n  pull_request_target:\n")), [
    "L-WORKFLOW-FORBIDDEN",
  ]);
});

test("the real workflow carries the D-23 ls-remote-verified v6 pins", () => {
  const wf = readFileSync(path.join(repoRoot, ".github/workflows/ci.yml"), "utf8");
  assert.ok(wf.includes("actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803 # v6.1.0"));
  assert.ok(wf.includes("actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38 # v6.5.0"));
  assert.equal((wf.match(/uses:/g) ?? []).length, 2);
});

test("RF6: a registry-prefixed but foreign tarball URL fails with L-TARBALL only", () => {
  const e = { ...good, resolved: "https://registry.npmjs.org/evil/-/evil-9.9.9.tgz" };
  assert.deepEqual(codes(checkLockfile(withEntry("node_modules/x", e), closureWith("x@1.0.0"))), [
    "L-TARBALL",
  ]);
});

test("RF6: scoped names use the unscoped basename in the canonical tarball URL", () => {
  const e = {
    version: "1.0.0",
    resolved: "https://registry.npmjs.org/@s/p/-/p-1.0.0.tgz",
    integrity: "sha512-abc",
  };
  assert.deepEqual(checkLockfile(withEntry("node_modules/@s/p", e), closureWith("@s/p@1.0.0")), []);
});

test("RF6: a changed integrity fails with L-INTEGRITY-PIN only", () => {
  const l = clone(realLock);
  l.packages["node_modules/typescript"].integrity = `sha512-${"A".repeat(86)}==`;
  assert.deepEqual(codes(checkLockfile(l, closure)), ["L-INTEGRITY-PIN"]);
});

test("RF6: an alias name field fails with L-ALIAS", () => {
  const l = clone(realLock);
  l.packages["node_modules/typescript"].name = "other-package";
  assert.ok(codes(checkLockfile(l, closure)).includes("L-ALIAS"));
});

test("RF6: expected closure pins sha512 integrity per name@version", () => {
  for (const [k, v] of Object.entries(closure.closure)) {
    assert.match(k, /@\d/);
    assert.ok(v.startsWith("sha512-"));
  }
});

// ---- SPEC-002 section 2.3: npm-name regex, per-path integrity, new workspaces ----------------
test("L-NAME: invalid npm names derived from the path are rejected on every entry", () => {
  for (const name of [
    "Evil",
    ".hidden",
    "_x",
    "a b",
    "@Scope/x",
    "@s/",
    "x\u0000y",
    "a/b",
    "@/x",
  ]) {
    const e = {
      version: "1.0.0",
      resolved: `https://registry.npmjs.org/${name}/-/${name.slice(name.lastIndexOf("/") + 1)}-1.0.0.tgz`,
      integrity: "sha512-abc",
    };
    const c = codes(
      checkLockfile(withEntry(`node_modules/${name}`, e), closureWith(`${name}@1.0.0`)),
    );
    assert.ok(c.includes("L-NAME"), `${JSON.stringify(name)}: ${c}`);
  }
  // nested entries are checked by the name after the last node_modules/
  const nested = withEntry("node_modules/ok/node_modules/Bad", {
    ...good,
    resolved: "https://registry.npmjs.org/Bad/-/Bad-1.0.0.tgz",
  });
  assert.ok(codes(checkLockfile(nested, closureWith("Bad@1.0.0"))).includes("L-NAME"));
  // valid names, scoped and unscoped, produce no L-NAME
  const scoped = withEntry("node_modules/@s/x-y.z", {
    version: "1.0.0",
    resolved: "https://registry.npmjs.org/@s/x-y.z/-/x-y.z-1.0.0.tgz",
    integrity: "sha512-abc",
  });
  assert.deepEqual(codes(checkLockfile(scoped, closureWith("@s/x-y.z@1.0.0"))), []);
});

test("L-INTEGRITY-PIN: duplicate name@version at different paths are each compared", () => {
  const ok = { ...good, integrity: "sha512-abc" };
  const bad = { ...good, integrity: "sha512-evil" };
  const lock = (first, second) => {
    const l = clone(realLock);
    l.packages["node_modules/a/node_modules/x"] = first;
    l.packages["node_modules/x"] = second;
    return l;
  };
  const cl = closureWith("x@1.0.0");
  assert.deepEqual(codes(checkLockfile(lock(ok, ok), cl)), []);
  // whichever sorts last must not mask the other
  for (const [first, second, badKey] of [
    [bad, ok, "node_modules/a/node_modules/x"],
    [ok, bad, "node_modules/x"],
  ]) {
    const f = checkLockfile(lock(first, second), cl);
    assert.deepEqual(codes(f), ["L-INTEGRITY-PIN"]);
    assert.ok(f[0].detail.startsWith(`${badKey}:`), f[0].detail);
  }
  assert.deepEqual(codes(checkLockfile(lock(bad, bad), cl)), [
    "L-INTEGRITY-PIN",
    "L-INTEGRITY-PIN",
  ]);
});

test("every SPEC-002 workspace has a link entry, and unlisted @swain names fail", () => {
  for (const n of [
    "adapter-claude-code",
    "adapter-codex-cli",
    "adapter-gemini-cli",
    "adapter-opencode",
    "report",
    "store",
  ]) {
    assert.deepEqual(realLock.packages[`node_modules/@swain/${n}`], {
      resolved: `packages/${n}`,
      link: true,
    });
  }
  const evil = withEntry("node_modules/@swain/adapter-evil", {
    resolved: "packages/adapter-evil",
    link: true,
  });
  assert.ok(codes(checkLockfile(evil, closure)).includes("L-SWAIN-LINK"));
});

const pkgManifests = () => ({
  ...manifests(),
  packages: {
    "adapter-claude-code": {
      name: "@swain/adapter-claude-code",
      dependencies: { "@swain/core": "0.0.0" },
    },
    "adapter-codex-cli": {
      name: "@swain/adapter-codex-cli",
      dependencies: { "@swain/core": "0.0.0" },
    },
    "adapter-gemini-cli": {
      name: "@swain/adapter-gemini-cli",
      dependencies: { "@swain/core": "0.0.0" },
    },
    "adapter-opencode": {
      name: "@swain/adapter-opencode",
      dependencies: { "@swain/core": "0.0.0" },
    },
    report: { name: "@swain/report", dependencies: { "@swain/core": "0.0.0" } },
    store: {
      name: "@swain/store",
      dependencies: { "@swain/core": "0.0.0", "@swain/report": "0.0.0" },
    },
  },
});

test("manifest rules: new workspaces and the SPEC-002 cli dependency set", () => {
  assert.deepEqual(checkManifests(pkgManifests()), []);
  const c = pkgManifests();
  c.cli.dependencies = {
    "@swain/core": "0.0.0",
    "@swain/adapter-claude-code": "0.0.0",
    "@swain/adapter-codex-cli": "0.0.0",
    "@swain/adapter-gemini-cli": "0.0.0",
    "@swain/adapter-opencode": "0.0.0",
    "@swain/report": "0.0.0",
    "@swain/store": "0.0.0",
  };
  assert.deepEqual(checkManifests(c), []);
});

test("manifest rules: adapter isolation and third-party bans are enforced on manifests", () => {
  const bad = (mutate) => {
    const m = pkgManifests();
    mutate(m);
    return codes(checkManifests(m));
  };
  // an adapter depending on another adapter, report or store
  for (const dep of ["@swain/adapter-opencode", "@swain/report", "@swain/store", "@swain/cli"]) {
    assert.deepEqual(
      bad((m) => {
        m.packages["adapter-claude-code"].dependencies[dep] = "0.0.0";
      }),
      ["L-MANIFEST"],
      dep,
    );
  }
  // report must not depend on store (cycle), store may depend on report
  assert.deepEqual(
    bad((m) => {
      m.packages.report.dependencies["@swain/store"] = "0.0.0";
    }),
    ["L-MANIFEST"],
  );
  // third-party, wrong version, missing core, other dependency kinds, wrong name, unknown dir
  assert.deepEqual(
    bad((m) => {
      m.packages.store.dependencies.left = "1.0.0";
    }),
    ["L-MANIFEST"],
  );
  assert.deepEqual(
    bad((m) => {
      m.packages.store.dependencies["@swain/report"] = "^0.0.0";
    }),
    ["L-MANIFEST"],
  );
  assert.deepEqual(
    bad((m) => {
      delete m.packages.report.dependencies["@swain/core"];
    }),
    ["L-MANIFEST"],
  );
  assert.deepEqual(
    bad((m) => {
      m.packages.report.devDependencies = { "@swain/core": "0.0.0" };
    }),
    ["L-MANIFEST"],
  );
  assert.deepEqual(
    bad((m) => {
      m.packages.report.optionalDependencies = { left: "1.0.0" };
    }),
    ["L-MANIFEST"],
  );
  assert.deepEqual(
    bad((m) => {
      m.packages.report.name = "@swain/store";
    }),
    ["L-MANIFEST"],
  );
  assert.deepEqual(
    bad((m) => {
      m.packages.rogue = { name: "@swain/rogue", dependencies: { "@swain/core": "0.0.0" } };
    }),
    ["L-MANIFEST"],
  );
  assert.deepEqual(
    bad((m) => {
      m.cli.dependencies["@swain/contract-tests"] = "0.0.0";
    }),
    ["L-MANIFEST"],
  );
});
