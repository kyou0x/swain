// SPEC-003 N0: policy profiles for the Swain packages, P-NET, P-SQL, the sdk-ts timer exception and
// the swain-bin.ts allowance. Fixtures live in tools/policy-fixtures/{good,bad}.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { checkLockfile, checkManifests, SWAIN_DEPS } from "./lockfile-check.mjs";
import {
  BIN_VARIANTS,
  checkFile,
  DEFERRED_PACKAGE_NAMES,
  IDENT_EXCEPTIONS,
  LEGACY_PACKAGE_NAMES,
  NET_MODULES,
  PACKAGE_NAMES,
  PACKAGE_RULES,
  rulesFor,
  SWAIN_IMPORTS,
  SWAIN_PACKAGE_NAMES,
  SWAIN_VALUE_NAMES,
  scanTree,
} from "./policy-check.mjs";

const rulesAt = (file, text) => {
  const pkg = rulesFor(file);
  assert.ok(pkg, `${file}: not under a known package`);
  return checkFile(file, text, pkg).map((f) => f.rule);
};
const src = (pkg, rel = "x.ts") => `packages/${pkg}/src/${rel}`;
const rulesIn = (pkg, text, rel) => rulesAt(src(pkg, rel), text);

const ALL = [...PACKAGE_NAMES, ...DEFERRED_PACKAGE_NAMES];
const NEW = [...SWAIN_PACKAGE_NAMES, ...DEFERRED_PACKAGE_NAMES];

// ---------------------------------------------------------------------------------------------
// Package tables
// ---------------------------------------------------------------------------------------------
test("N0: the five Swain packages and sdk-ts have profiles; sdk-ts is deferred, not required", () => {
  assert.deepEqual(SWAIN_PACKAGE_NAMES, ["model", "otlp", "db", "server", "client"]);
  assert.deepEqual(DEFERRED_PACKAGE_NAMES, ["sdk-ts"]);
  assert.deepEqual(PACKAGE_NAMES, [...LEGACY_PACKAGE_NAMES, ...SWAIN_PACKAGE_NAMES]);
  for (const n of ALL) {
    assert.deepEqual(rulesFor(`packages/${n}/src/a.ts`), { name: n, srcRoot: `packages/${n}/src` });
    assert.deepEqual(rulesFor(`packages/${n}/dist/src/a.js`), {
      name: n,
      srcRoot: `packages/${n}/dist/src`,
    });
    assert.ok(Object.hasOwn(PACKAGE_RULES, n), `${n}: PACKAGE_RULES`);
    assert.ok(Object.hasOwn(SWAIN_IMPORTS, n), `${n}: SWAIN_IMPORTS`);
  }
  assert.equal(rulesFor("packages/sdk-ts/test/a.ts"), null);
  assert.equal(rulesFor("packages/sdk-tsx/src/a.ts"), null);
});

test("N0: ADR-0004 section 4 tables, exactly", () => {
  const sorted = (a) => [...a].sort();
  const pathNames = ["basename", "dirname", "isAbsolute", "join", "relative", "resolve", "sep"];
  const merged = (pkg) => {
    const out = {};
    for (const [prefix, table] of PACKAGE_RULES[pkg]) out[prefix] = table;
    return out;
  };
  assert.deepEqual(merged("model"), { "": { "node:crypto": ["createHash"] } });
  assert.deepEqual(PACKAGE_RULES.otlp, []);
  const db = merged("db");
  assert.deepEqual(Object.keys(db).sort(), ["", "sqlite/"]);
  assert.deepEqual(Object.keys(db[""]).sort(), ["node:crypto", "node:fs", "node:path"]);
  assert.deepEqual(sorted(db[""]["node:crypto"]), ["createHash", "randomBytes"]);
  assert.deepEqual(sorted(db[""]["node:fs"]), ["constants", "lstatSync", "mkdirSync"]);
  assert.deepEqual(sorted(db[""]["node:path"]), pathNames);
  assert.deepEqual(db["sqlite/"], {
    "node:sqlite": ["DatabaseSync"],
    "node:fs": [
      "openSync",
      "closeSync",
      "readSync",
      "writeSync",
      "fstatSync",
      "fsyncSync",
      "unlinkSync",
      "fchmodSync",
      "chmodSync",
      "linkSync",
    ],
  });
  const server = merged("server")[""];
  assert.deepEqual(Object.keys(server).sort(), ["node:crypto", "node:http", "node:zlib"]);
  assert.deepEqual(server["node:http"], ["createServer"]);
  assert.deepEqual(sorted(server["node:zlib"]), ["constants", "gunzipSync"]);
  assert.deepEqual(sorted(server["node:crypto"]), ["createHash", "randomBytes", "timingSafeEqual"]);
  const client = merged("client")[""];
  assert.deepEqual(Object.keys(client).sort(), [
    "node:crypto",
    "node:fs",
    "node:http",
    "node:https",
    "node:path",
  ]);
  assert.deepEqual(sorted(client["node:http"]), ["Agent", "request"]);
  assert.deepEqual(client["node:https"], ["request"]);
  assert.deepEqual(sorted(client["node:crypto"]), ["createHash", "randomBytes", "randomInt"]);
  assert.deepEqual(sorted(client["node:path"]), pathNames);
  assert.deepEqual(
    sorted(client["node:fs"]),
    sorted(Object.fromEntries(PACKAGE_RULES.store)[""]["node:fs"]),
    "client spool names are the store's",
  );
  const sdk = merged("sdk-ts");
  assert.deepEqual(Object.keys(sdk).sort(), ["", "export/"]);
  assert.deepEqual(Object.keys(sdk[""]).sort(), ["node:crypto", "node:http", "node:https"]);
  assert.deepEqual(sdk[""]["node:crypto"], ["randomBytes"]);
  assert.deepEqual(sdk["export/"], { "node:timers": ["setTimeout", "clearTimeout"] });
  assert.deepEqual(IDENT_EXCEPTIONS, { "sdk-ts": [["export/", ["setTimeout", "clearTimeout"]]] });
  assert.deepEqual(SWAIN_IMPORTS.model, { "@swain/core": false });
  assert.deepEqual(SWAIN_IMPORTS.otlp, { "@swain/core": false, "@swain/model": false });
  assert.deepEqual(SWAIN_IMPORTS.db, {
    "@swain/core": false,
    "@swain/model": false,
    "@swain/report": true,
  });
  assert.deepEqual(Object.keys(SWAIN_IMPORTS.server).sort(), [
    "@swain/core",
    "@swain/db",
    "@swain/model",
    "@swain/otlp",
    "@swain/report",
    "@swain/store",
  ]);
  assert.ok(Object.values(SWAIN_IMPORTS.server).every((v) => v === false));
  assert.deepEqual(SWAIN_VALUE_NAMES, {
    server: { "@swain/store": ["buildImportRecord", "parseImportRecord"] },
  });
  assert.deepEqual(SWAIN_IMPORTS.client, { "@swain/core": false, "@swain/model": false });
  assert.deepEqual(SWAIN_IMPORTS["sdk-ts"], {});
});

test("N0: lockfile-check SWAIN_DEPS mirror the policy-check import tables", () => {
  for (const n of [...SWAIN_PACKAGE_NAMES, "sdk-ts"]) {
    assert.deepEqual(
      [...SWAIN_DEPS[n]].sort(),
      Object.keys(SWAIN_IMPORTS[n])
        .map((k) => k.slice("@swain/".length))
        .sort(),
      n,
    );
  }
});

// ---------------------------------------------------------------------------------------------
// One cross-package import and one non-allowlisted builtin per new package
// ---------------------------------------------------------------------------------------------
test("each new package: a cross-package import outside its table and a non-allowlisted builtin are caught", () => {
  for (const pkg of NEW) {
    for (const other of ALL.filter((n) => n !== pkg)) {
      const spec = `@swain/${other}`;
      const text = `import { a } from "${spec}"; export { a };`;
      const rules = rulesIn(pkg, text);
      // `true` marks a type-only allowance: a value import of it is still a violation
      // (`a` is not one of the value names the server may take from @swain/store)
      const ok = SWAIN_IMPORTS[pkg][spec] === false && SWAIN_VALUE_NAMES[pkg]?.[spec] === undefined;
      assert.deepEqual(rules, ok ? [] : ["P-IMPORT"], `${pkg} -> ${spec}`);
    }
    // every package is also barred from importing itself through the package name's siblings
    for (const spec of ["node:os", "node:vm", "node:fs/promises", "node:readline", "node:module"]) {
      assert.ok(
        rulesIn(pkg, `import { a } from "${spec}"; export { a };`).includes("P-IMPORT"),
        `${pkg} ${spec}`,
      );
    }
    assert.ok(
      rulesIn(pkg, 'import { writeFileSync } from "node:fs"; export { writeFileSync };').includes(
        "P-IMPORT",
      ),
      `${pkg} writeFileSync`,
    );
    assert.ok(
      rulesIn(pkg, 'import { rmSync } from "node:fs"; export { rmSync };').includes("P-IMPORT"),
      `${pkg} rmSync`,
    );
  }
});

test("each new package: relative imports may not leave src (P-RELATIVE)", () => {
  for (const pkg of NEW) {
    assert.deepEqual(
      rulesIn(pkg, 'import { a } from "../../core/src/index.js"; export { a };'),
      ["P-RELATIVE"],
      pkg,
    );
  }
});

test("each new package: the global P-* rules apply unchanged", () => {
  const cases = [
    ["export const a = eval('1');", "P-IDENT"],
    ["export const a = fetch;", "P-IDENT"],
    ["export const a = crypto;", "P-IDENT"],
    ["export const a = Buffer;", "P-IDENT"],
    ["export const a = globalThis;", "P-IDENT"],
    ["export const a = Date.now();", "P-DATE"],
    ["export const a = new Date();", "P-DATE"],
    ["export const a = Math.random();", "P-RANDOM"],
    ["export const a = process.env;", "P-PROCESS"],
    ["export const a = import('x');", "P-DYNIMPORT"],
    ["export const a = import.meta;", "P-IMPORTMETA"],
    ["export const a = x.constructor;", "P-CTOR"],
    ["export const a = x.toLocaleString();", "P-LOCALE"],
    ["export const a = x.getHours();", "P-DATELOCAL"],
  ];
  for (const pkg of NEW) {
    for (const [text, rule] of cases) {
      assert.ok(rulesIn(pkg, text).includes(rule), `${pkg}: ${text}`);
    }
  }
});

// ---------------------------------------------------------------------------------------------
// P-NET
// ---------------------------------------------------------------------------------------------
const NET_SPECS = [...NET_MODULES].flatMap((m) => [`node:${m}`, m]);

/** Pairs the tables allow, per package: `spec|name` -> path prefix. */
function allowedNet(pkg) {
  const out = new Map();
  for (const [prefix, table] of PACKAGE_RULES[pkg] ?? []) {
    for (const [spec, names] of Object.entries(table)) {
      if (!NET_MODULES.has(spec.replace(/^node:/, ""))) continue;
      for (const n of names) out.set(`${spec}|${n}`, prefix);
    }
  }
  return out;
}

test("P-NET: the exact allow-list is server {createServer}, client and sdk-ts {request}", () => {
  const all = {};
  for (const pkg of ALL) all[pkg] = [...allowedNet(pkg).keys()].sort();
  for (const pkg of ALL) {
    const want =
      pkg === "server"
        ? ["node:http|createServer"]
        : pkg === "client" || pkg === "sdk-ts"
          ? pkg === "client"
            ? ["node:http|request", "node:http|Agent", "node:https|request"]
            : ["node:http|request", "node:https|request"]
          : [];
    assert.deepEqual(all[pkg], [...want].sort(), pkg);
  }
});

test("P-NET: every network/process/thread module is a violation in every package unless allowed", () => {
  const names = ["createServer", "request", "get", "connect", "spawn", "Worker", "Agent"];
  for (const pkg of ALL) {
    const allow = allowedNet(pkg);
    for (const spec of NET_SPECS) {
      for (const name of names) {
        const text = `import { ${name} } from "${spec}"; export { ${name} };`;
        const rules = rulesIn(pkg, text);
        if (allow.has(`${spec}|${name}`)) {
          assert.deepEqual(rules, [], `${pkg}: ${spec} ${name} is allowed`);
        } else {
          assert.ok(rules.includes("P-NET"), `${pkg}: ${spec} ${name} must be P-NET`);
          assert.ok(rules.includes("P-IMPORT"), `${pkg}: ${spec} ${name} stays P-IMPORT`);
        }
      }
    }
  }
});

test("P-NET: 'http' in report is caught (SPEC-003 N0 acceptance)", () => {
  for (const spec of ["node:http", "http", "node:https", "node:net"]) {
    const rules = rulesIn("report", `import { request } from "${spec}"; export { request };`);
    assert.deepEqual(rules, ["P-IMPORT", "P-NET"], spec);
  }
});

test("P-NET: bypass attempts, one per route", () => {
  const bypass = [
    // [package, text, rule that must fire]
    ["report", 'import * as h from "node:http"; export { h };', "P-NET"],
    ["report", 'import h from "node:http"; export { h };', "P-NET"],
    ["report", 'import h = require("node:http"); export { h };', "P-NET"],
    ["report", 'export { request } from "node:http";', "P-NET"],
    ["report", 'export * from "node:net";', "P-NET"],
    ["report", 'import "node:http";', "P-NET"],
    ["report", 'import type { Agent } from "node:http"; export type A = Agent;', "P-NET"],
    ["report", 'export const a = import("node:http");', "P-DYNIMPORT"],
    ["report", 'export const a = process.getBuiltinModule("node:http");', "P-PROCESS"],
    [
      "report",
      'import { createRequire } from "node:module"; export const a = createRequire(import.meta.url)("node:http");',
      "P-IMPORTMETA",
    ],
    ["report", 'export const a = require("node:http");', "P-IDENT"],
    ["report", "export const a = fetch('http://x');", "P-IDENT"],
    ["report", "export const a = new WebSocket('ws://x');", "P-IDENT"],
    // inside the allowing packages: a wrong name or an alias must not smuggle another export
    [
      "server",
      'import { request as createServer } from "node:http"; export { createServer };',
      "P-NET",
    ],
    [
      "server",
      'import { createServer, get } from "node:http"; export { createServer, get };',
      "P-NET",
    ],
    ["server", 'import { request } from "node:https"; export { request };', "P-NET"],
    ["server", 'import { createServer } from "node:https"; export { createServer };', "P-NET"],
    ["server", 'import * as h from "node:http"; export { h };', "P-NET"],
    ["client", 'import { createServer } from "node:http"; export { createServer };', "P-NET"],
    ["client", 'import { get } from "node:https"; export { get };', "P-NET"],
    ["client", 'import { Socket } from "node:net"; export { Socket };', "P-NET"],
    ["sdk-ts", 'import { createServer } from "node:http"; export { createServer };', "P-NET"],
    ["db", 'import { spawn } from "node:child_process"; export { spawn };', "P-NET"],
    ["otlp", 'import { Worker } from "node:worker_threads"; export { Worker };', "P-NET"],
    ["model", 'import { connect } from "node:tls"; export { connect };', "P-NET"],
    ["cli", 'import { createSocket } from "node:dgram"; export { createSocket };', "P-NET"],
    ["store", 'import { connect } from "node:http2"; export { connect };', "P-NET"],
  ];
  for (const [pkg, text, rule] of bypass) {
    assert.ok(rulesIn(pkg, text).includes(rule), `${pkg}: ${text}`);
  }
  // the compiled output is scanned with the same rules
  for (const pkg of ["report", "server", "client"]) {
    const f = `packages/${pkg}/dist/src/x.js`;
    assert.ok(
      rulesAt(f, 'import { spawn } from "node:child_process"; export { spawn };').includes("P-NET"),
      f,
    );
  }
});

test("P-NET: the allowances do not leak across packages or to legacy packages", () => {
  for (const pkg of LEGACY_PACKAGE_NAMES) {
    for (const [spec, name] of [
      ["node:http", "createServer"],
      ["node:http", "request"],
      ["node:https", "request"],
    ]) {
      const rules = rulesIn(pkg, `import { ${name} } from "${spec}"; export { ${name} };`);
      assert.deepEqual(rules, ["P-IMPORT", "P-NET"], `${pkg} ${spec} ${name}`);
    }
  }
  for (const pkg of ["model", "otlp", "db"]) {
    assert.deepEqual(
      rulesIn(pkg, 'import { createServer } from "node:http"; export { createServer };'),
      ["P-IMPORT", "P-NET"],
      pkg,
    );
  }
  // server cannot call out; client cannot listen
  assert.deepEqual(rulesIn("server", 'import { request } from "node:http"; export { request };'), [
    "P-IMPORT",
    "P-NET",
  ]);
  assert.deepEqual(
    rulesIn("client", 'import { createServer } from "node:http"; export { createServer };'),
    ["P-IMPORT", "P-NET"],
  );
});

// ---------------------------------------------------------------------------------------------
// P-SQL
// ---------------------------------------------------------------------------------------------
const SQLITE_IMPORT = 'import { DatabaseSync } from "node:sqlite"; export { DatabaseSync };';

test("P-SQL: node:sqlite is allowed only as DatabaseSync below db/src/sqlite/", () => {
  assert.deepEqual(rulesIn("db", SQLITE_IMPORT, "sqlite/open.ts"), []);
  assert.deepEqual(rulesIn("db", SQLITE_IMPORT, "sqlite/deep/open.ts"), []);
  assert.deepEqual(rulesAt("packages/db/dist/src/sqlite/open.js", SQLITE_IMPORT), []);
  // the same import everywhere else
  for (const [pkg, rel] of [
    ["db", "x.ts"],
    ["db", "store/sqlite.ts"],
    ["db", "sqlite2/x.ts"],
    ["db", "sqlitex/x.ts"],
    ["db", "xsqlite/x.ts"],
    ["db", "SQLITE/x.ts"],
    ...PACKAGE_NAMES.filter((n) => n !== "db").map((n) => [n, "sqlite/x.ts"]),
    ["sdk-ts", "sqlite/x.ts"],
  ]) {
    assert.deepEqual(rulesIn(pkg, SQLITE_IMPORT, rel), ["P-IMPORT", "P-SQL"], `${pkg}/${rel}`);
  }
  // `node:sqlite` in the server is the SPEC-003 acceptance case
  assert.ok(rulesIn("server", SQLITE_IMPORT).includes("P-SQL"));
});

test("P-SQL: only the named DatabaseSync, in every other form it is a violation", () => {
  const at = "sqlite/x.ts";
  for (const text of [
    'import { StatementSync } from "node:sqlite"; export { StatementSync };',
    'import { DatabaseSync, backup } from "node:sqlite"; export { DatabaseSync, backup };',
    'import { constants } from "node:sqlite"; export { constants };',
    'import * as s from "node:sqlite"; export { s };',
    'import s from "node:sqlite"; export { s };',
    'import "node:sqlite";',
    'export * from "node:sqlite";',
    'export { DatabaseSync } from "node:sqlite";',
    'import s = require("node:sqlite"); export { s };',
    'import { DatabaseSync } from "sqlite"; export { DatabaseSync };',
  ]) {
    const rules = rulesIn("db", text, at);
    assert.ok(rules.includes("P-SQL"), text);
    assert.ok(rules.includes("P-IMPORT"), text);
  }
  assert.deepEqual(
    rulesIn("db", 'import { DatabaseSync as D } from "node:sqlite"; export { D };', at),
    [],
  );
});

test("P-SQL: loading extensions is banned by member name in every package, with no exception", () => {
  const forms = [
    "export const a = db.loadExtension('x');",
    "export const a = db.enableLoadExtension(true);",
    "export const a = db['loadExtension']('x');",
    "export const a = db[`enableLoadExtension`](true);",
    "export const { loadExtension } = db;",
    "export const { enableLoadExtension: e } = db;",
    "let f; ({ loadExtension: f } = db); export { f };",
    "export const a = db?.loadExtension?.('x');",
  ];
  for (const pkg of ALL) {
    for (const rel of ["x.ts", "sqlite/x.ts", "export/x.ts"]) {
      for (const text of forms) {
        assert.ok(rulesIn(pkg, text, rel).includes("P-SQL"), `${pkg}/${rel}: ${text}`);
      }
    }
  }
  assert.ok(rulesAt("packages/db/dist/src/sqlite/x.js", forms[0]).includes("P-SQL"));
  // unrelated members stay legal
  assert.deepEqual(rulesIn("db", "export const a = db.exec('select 1');", "sqlite/x.ts"), []);
});

test("P-SQL: bypass attempts, one per route", () => {
  const bypass = [
    ["db", "export const a = import('node:sqlite');", "P-DYNIMPORT", "sqlite/x.ts"],
    ["db", "export const a = process.getBuiltinModule('node:sqlite');", "P-PROCESS", "sqlite/x.ts"],
    ["server", "export const a = process.getBuiltinModule('node:sqlite');", "P-PROCESS"],
    ["server", 'export { DatabaseSync } from "node:sqlite";', "P-SQL"],
    ["server", 'import s = require("node:sqlite"); export { s };', "P-SQL"],
    [
      "server",
      'import type { DatabaseSync } from "node:sqlite"; export type D = DatabaseSync;',
      "P-SQL",
    ],
    ["server", 'export type D = import("node:sqlite").DatabaseSync;', "P-IMPORT"],
    ["report", SQLITE_IMPORT, "P-SQL"],
    ["cli", SQLITE_IMPORT, "P-SQL"],
    ["store", SQLITE_IMPORT, "P-SQL"],
    [
      "db",
      'import { DatabaseSync } from "node:sqlite"; export { DatabaseSync };',
      "P-SQL",
      "store.ts",
    ],
    ["db", "export const a = new Function('return 1');", "P-IDENT"],
    ["db", "export const a = Reflect.get(db, 'loadExtension');", "P-IDENT", "sqlite/x.ts"],
  ];
  for (const [pkg, text, rule, rel] of bypass) {
    assert.ok(rulesIn(pkg, text, rel).includes(rule), `${pkg}: ${text}`);
  }
});

test("RESIDUAL (spec-silent): a computed property name is not detected, as for the other member rules", () => {
  const text = "export const a = db['load' + 'Extension']('x');";
  assert.deepEqual(rulesIn("db", text, "sqlite/x.ts"), []);
  // the sandbox for that is the constructor option (allowExtension:false) and the DB layer's test
});

// ---------------------------------------------------------------------------------------------
// sdk-ts timers (scoped P-IDENT exception)
// ---------------------------------------------------------------------------------------------
const TIMER_USE =
  'import { setTimeout } from "node:timers"; export const t = setTimeout(() => 1, 5);';

test("sdk-ts: setTimeout in sdk-ts/src/other.ts is caught (SPEC-003 N0 acceptance)", () => {
  assert.ok(
    rulesIn("sdk-ts", "export const t = setTimeout(() => 1, 5);", "other.ts").includes("P-IDENT"),
  );
  assert.ok(rulesIn("sdk-ts", TIMER_USE, "other.ts").includes("P-IDENT"));
  assert.ok(rulesIn("sdk-ts", TIMER_USE, "other.ts").includes("P-IMPORT"));
});

test("sdk-ts: the exception is exactly src/export/** with an import from node:timers", () => {
  assert.deepEqual(rulesIn("sdk-ts", TIMER_USE, "export/flush.ts"), []);
  assert.deepEqual(rulesIn("sdk-ts", TIMER_USE, "export/deep/flush.ts"), []);
  assert.deepEqual(rulesAt("packages/sdk-ts/dist/src/export/flush.js", TIMER_USE), []);
  assert.deepEqual(
    rulesIn(
      "sdk-ts",
      'import { clearTimeout, setTimeout } from "node:timers"; export const a = [setTimeout, clearTimeout];',
      "export/x.ts",
    ),
    [],
  );
  // not imported: the global is still banned even inside export/
  assert.deepEqual(rulesIn("sdk-ts", "export const t = setTimeout(() => 1, 5);", "export/x.ts"), [
    "P-IDENT",
  ]);
  // other timers and other names stay banned inside export/
  for (const name of ["setInterval", "setImmediate", "queueMicrotask"]) {
    const rules = rulesIn(
      "sdk-ts",
      `import { ${name} } from "node:timers"; export const t = ${name};`,
      "export/x.ts",
    );
    assert.ok(rules.includes("P-IMPORT"), name);
    assert.ok(rules.includes("P-IDENT"), name);
  }
  // an alias does not rename the banned global into a permitted one
  assert.ok(
    rulesIn(
      "sdk-ts",
      'import { setTimeout as setInterval } from "node:timers"; export const t = setInterval;',
      "export/x.ts",
    ).includes("P-IDENT"),
  );
  // lookalike directories
  for (const rel of ["export.ts", "exports/x.ts", "xexport/x.ts", "a/export/x.ts", "Export/x.ts"]) {
    const rules = rulesIn("sdk-ts", TIMER_USE, rel);
    assert.ok(rules.includes("P-IDENT") && rules.includes("P-IMPORT"), rel);
  }
});

test("sdk-ts: the exception does not leak to any other package", () => {
  for (const pkg of ALL.filter((n) => n !== "sdk-ts")) {
    for (const rel of ["export/x.ts", "x.ts"]) {
      const rules = rulesIn(pkg, TIMER_USE, rel);
      assert.ok(rules.includes("P-IDENT"), `${pkg}/${rel}`);
      assert.ok(rules.includes("P-IMPORT"), `${pkg}/${rel}`);
    }
  }
});

test("sdk-ts: self-contained (no @swain import) and uses only named request/randomBytes", () => {
  for (const other of ALL.filter((n) => n !== "sdk-ts")) {
    assert.deepEqual(
      rulesIn("sdk-ts", `import { a } from "@swain/${other}"; export { a };`),
      ["P-IMPORT"],
      other,
    );
  }
  assert.deepEqual(
    rulesIn("sdk-ts", 'import { randomBytes } from "node:crypto"; export { randomBytes };'),
    [],
  );
  assert.ok(
    rulesIn("sdk-ts", 'import { randomUUID } from "node:crypto"; export { randomUUID };').includes(
      "P-RANDOM",
    ),
  );
  assert.ok(
    rulesIn("sdk-ts", 'import { createHash } from "node:crypto"; export { createHash };').includes(
      "P-RANDOM",
    ),
  );
});

// ---------------------------------------------------------------------------------------------
// server: value imports from @swain/store
// ---------------------------------------------------------------------------------------------
test("server: only buildImportRecord and parseImportRecord may be imported as values from @swain/store", () => {
  assert.deepEqual(
    rulesIn(
      "server",
      'import { buildImportRecord, parseImportRecord } from "@swain/store"; export { buildImportRecord, parseImportRecord };',
    ),
    [],
  );
  assert.deepEqual(
    rulesIn(
      "server",
      'import { type Store, buildImportRecord } from "@swain/store"; export { buildImportRecord }; export type S = Store;',
    ),
    [],
  );
  assert.deepEqual(
    rulesIn("server", 'import type { Store } from "@swain/store"; export type S = Store;'),
    [],
  );
  for (const text of [
    'import { openStore } from "@swain/store"; export { openStore };',
    'import { buildImportRecord, openStore } from "@swain/store"; export { buildImportRecord, openStore };',
    'import { writeOutputFile as buildImportRecord } from "@swain/store"; export { buildImportRecord };',
    'import * as s from "@swain/store"; export { s };',
    'import s from "@swain/store"; export { s };',
    'export * from "@swain/store";',
    'export { openStore } from "@swain/store";',
    'import s = require("@swain/store"); export { s };',
  ]) {
    assert.deepEqual(rulesIn("server", text), ["P-IMPORT"], text);
  }
  // fs-touching core exports stay barred outside cli and store
  assert.deepEqual(
    rulesIn("server", 'import { readSourceFile } from "@swain/core"; export { readSourceFile };'),
    ["P-IMPORT"],
  );
  assert.deepEqual(
    rulesIn(
      "server",
      'import { sourceFromBuffer } from "@swain/core"; export { sourceFromBuffer };',
    ),
    [],
  );
  // the restriction is the server's alone: db is type-only for report, nobody else sees store
  for (const pkg of ["model", "otlp", "db", "client", "sdk-ts"]) {
    assert.deepEqual(
      rulesIn(
        pkg,
        'import { buildImportRecord } from "@swain/store"; export { buildImportRecord };',
      ),
      ["P-IMPORT"],
      pkg,
    );
  }
  assert.deepEqual(
    rulesIn("db", 'import { r } from "@swain/report"; export { r };'),
    ["P-IMPORT"],
    "db may use @swain/report only as a type",
  );
  assert.deepEqual(rulesIn("db", 'import type { R } from "@swain/report"; export type X = R;'), []);
});

// ---------------------------------------------------------------------------------------------
// swain-bin.ts
// ---------------------------------------------------------------------------------------------
const SWAIN = "packages/cli/src/swain-bin.ts";
const SWAIN_JS = "packages/cli/dist/src/swain-bin.js";
const swainRules = (text, file = SWAIN) => rulesAt(file, text);

const SWAIN_OK =
  'runSwain({ argv: process.argv.slice(2), stdout: (s) => process.stdout.write(s), stderr: process.stderr, stdin: process.stdin, env: { HOME: process.env.HOME, XDG_DATA_HOME: process.env.XDG_DATA_HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, XDG_STATE_HOME: process.env.XDG_STATE_HOME, SWAIN_SERVER_URL: process.env.SWAIN_SERVER_URL, SWAIN_DB: process.env.SWAIN_DB }, nowMs: Date.now, onSignal: (cb) => { process.once("SIGINT", cb); process.once("SIGTERM", cb); } }).then((c) => { process.exitCode = c; });';

test("swain-bin: the allowed shape passes (src and compiled), and each deviation is a finding", () => {
  assert.deepEqual(swainRules(SWAIN_OK), []);
  assert.deepEqual(swainRules(SWAIN_OK, SWAIN_JS), []);
  const dev = (a, b) => swainRules(SWAIN_OK.replace(a, b));
  assert.deepEqual(dev("process.env.SWAIN_DB", "process.env.SWAIN_TOKEN"), ["P-PROCESS"]);
  assert.deepEqual(dev("process.env.HOME", "process.env.PATH"), ["P-PROCESS"]);
  assert.deepEqual(dev("process.env.HOME", "process.env['HOME']"), ["P-PROCESS"]);
  assert.deepEqual(dev("nowMs: Date.now", "nowMs: Date.now()"), ["P-DATE"]);
  assert.deepEqual(dev("nowMs: Date.now", "nowMs: () => Date.now"), ["P-DATE"]);
  assert.deepEqual(dev('process.once("SIGINT", cb)', 'process.once("SIGHUP", cb)'), ["P-PROCESS"]);
  assert.deepEqual(dev('process.once("SIGINT", cb)', "process.once(sig, cb)"), ["P-PROCESS"]);
  assert.deepEqual(dev('process.once("SIGINT", cb)', "process.on('SIGINT', cb)"), ["P-PROCESS"]);
  assert.deepEqual(dev('process.once("SIGINT", cb)', "process.exit(1)"), ["P-PROCESS"]);
  assert.deepEqual(dev("stdin: process.stdin", "stdin: process.stdin.on"), ["P-PROCESS"]);
  assert.deepEqual(dev("stdin: process.stdin", "stdin: (() => process.stdin)()"), ["P-PROCESS"]);
  assert.deepEqual(dev("stderr: process.stderr", "stderr: process.stdout"), []);
  assert.deepEqual(dev("process.exitCode = c", "process.exitCode = c; process.stdout.write('x')"), [
    "P-PROCESS",
  ]);
  assert.ok(swainRules(`${SWAIN_OK}\n${SWAIN_OK}`).length > 0, "two runSwain calls allow nothing");
  assert.ok(swainRules(SWAIN_OK.replace("runSwain", "runMain")).includes("P-PROCESS"));
  assert.ok(swainRules(SWAIN_OK.replace("runSwain", "otherMain")).includes("P-PROCESS"));
});

test("swain-bin: process.once and process.stdin are bound to the runSwain arguments", () => {
  assert.deepEqual(
    swainRules('process.once("SIGINT", () => 1); runSwain({});'),
    ["P-PROCESS"],
    "process.once outside the call",
  );
  assert.deepEqual(swainRules("const s = process.stdin; runSwain({ s });"), ["P-PROCESS"]);
  assert.deepEqual(swainRules('runSwain({ s: process.once("SIGINT", () => 1) });'), []);
  assert.deepEqual(swainRules("runSwain({ s: process.once });"), ["P-PROCESS"]);
  assert.deepEqual(swainRules("runSwain({ s: { t: process.stdin } });"), ["P-PROCESS"]);
  assert.deepEqual(swainRules("runSwain(process.stdin);"), []);
});

test("swain-bin: the allowance applies to swain-bin only, not to bin or any other file", () => {
  const text = SWAIN_OK;
  for (const file of [
    "packages/cli/src/bin.ts",
    "packages/cli/dist/src/bin.js",
    "packages/cli/src/main.ts",
    "packages/cli/src/swain.ts",
    "packages/cli/src/sub/swain-bin.ts",
    "packages/cli/src/Swain-bin.ts",
    "packages/cli/dist/src/sub/swain-bin.js",
    "packages/store/src/swain-bin.ts",
    "packages/report/src/swain-bin.ts",
    "packages/core/src/swain-bin.ts",
    "packages/server/src/swain-bin.ts",
    "packages/client/src/swain-bin.ts",
    "packages/sdk-ts/src/swain-bin.ts",
    "packages/adapter-opencode/src/swain-bin.ts",
  ]) {
    const rules = rulesAt(
      file,
      text.replace(/runSwain/g, file.includes("bin.") ? "runMain" : "runSwain"),
    );
    assert.ok(rules.includes("P-PROCESS"), file);
  }
  // a non-.ts entry file in src is P-EXT before any allowance is considered
  assert.deepEqual(rulesAt("packages/cli/src/swain-bin.mts", SWAIN_OK), ["P-EXT"]);
  // and the other way round: bin.ts does not gain a runSwain binding
  assert.ok(rulesAt("packages/cli/src/bin.ts", SWAIN_OK).includes("P-PROCESS"));
});

test("swain-bin: BIN_VARIANTS has exactly the four entry files", () => {
  assert.deepEqual(Object.keys(BIN_VARIANTS).sort(), [
    "bin.js",
    "bin.ts",
    "swain-bin.js",
    "swain-bin.ts",
  ]);
  assert.deepEqual(BIN_VARIANTS["swain-bin.ts"].env, [
    "HOME",
    "XDG_DATA_HOME",
    "XDG_CONFIG_HOME",
    "XDG_STATE_HOME",
    "SWAIN_SERVER_URL",
    "SWAIN_DB",
  ]);
});

// ---------------------------------------------------------------------------------------------
// No existing profile may be widened (SPEC-003 N0 security focus)
// ---------------------------------------------------------------------------------------------
const PATH_NAMES = ["join", "resolve", "basename", "dirname", "relative", "isAbsolute", "sep"];
const FROZEN_STORE_FS = [
  "openSync",
  "closeSync",
  "readSync",
  "writeSync",
  "fstatSync",
  "lstatSync",
  "fsyncSync",
  "renameSync",
  "mkdirSync",
  "readdirSync",
  "rmdirSync",
  "unlinkSync",
  "realpathSync",
  "constants",
];
/** The P0 tables, frozen at the state before SPEC-003 N0 (SPEC-002 section 2.3). */
const FROZEN_RULES = {
  core: [
    ["", { "node:crypto": ["createHash"] }],
    [
      "ingest/fs/",
      {
        "node:fs": [
          "openSync",
          "closeSync",
          "readSync",
          "fstatSync",
          "lstatSync",
          "readdirSync",
          "realpathSync",
          "constants",
        ],
        "node:zlib": ["zstdDecompressSync", "constants"],
        "node:path": PATH_NAMES,
      },
    ],
  ],
  report: [["", { "node:crypto": ["createHash"] }]],
  store: [
    [
      "",
      {
        "node:crypto": ["createHash"],
        "node:fs": FROZEN_STORE_FS,
        "node:path": PATH_NAMES,
      },
    ],
  ],
  cli: [],
  "adapter-claude-code": [],
  "adapter-codex-cli": [],
  "adapter-gemini-cli": [],
  "adapter-opencode": [],
};
const ADAPTERS = LEGACY_PACKAGE_NAMES.filter((n) => n.startsWith("adapter-"));
const FROZEN_IMPORTS = {
  core: {},
  ...Object.fromEntries(ADAPTERS.map((n) => [n, { "@swain/core": false }])),
  report: { "@swain/core": false },
  store: { "@swain/core": false, "@swain/report": true },
  cli: Object.fromEntries(
    ["core", ...ADAPTERS, "report", "store", "server", "db", "client"].map((n) => [
      `@swain/${n}`,
      false,
    ]),
  ),
};
const FROZEN_DEPS = {
  ...Object.fromEntries(ADAPTERS.map((n) => [n, ["core"]])),
  report: ["core"],
  store: ["core", "report"],
  cli: ["core", ...ADAPTERS, "report", "store", "server", "db", "client"],
};

test("no existing package's builtin table was widened (frozen P0 snapshot)", () => {
  assert.deepEqual(LEGACY_PACKAGE_NAMES, [
    "core",
    "adapter-claude-code",
    "adapter-codex-cli",
    "adapter-gemini-cli",
    "adapter-opencode",
    "report",
    "store",
    "cli",
  ]);
  for (const pkg of LEGACY_PACKAGE_NAMES) {
    assert.deepEqual(PACKAGE_RULES[pkg], FROZEN_RULES[pkg], pkg);
  }
});

test("no existing package's @swain import table or manifest dependency set was widened", () => {
  for (const pkg of LEGACY_PACKAGE_NAMES) {
    assert.deepEqual(SWAIN_IMPORTS[pkg], FROZEN_IMPORTS[pkg], pkg);
    if (pkg !== "core") assert.deepEqual(SWAIN_DEPS[pkg], FROZEN_DEPS[pkg], `deps ${pkg}`);
  }
  assert.equal(Object.hasOwn(SWAIN_VALUE_NAMES, "cli"), false);
  assert.deepEqual(Object.keys(SWAIN_VALUE_NAMES), ["server"]);
  assert.deepEqual(Object.keys(IDENT_EXCEPTIONS), ["sdk-ts"]);
});

test("no existing package may import a new package, and no new allowance reaches an old one", () => {
  for (const pkg of LEGACY_PACKAGE_NAMES) {
    for (const n of [...SWAIN_PACKAGE_NAMES, "sdk-ts"]) {
      // N1.8: the cli (and only the cli) may import the server, db and client packages
      if (pkg === "cli" && ["server", "db", "client"].includes(n)) continue;
      assert.deepEqual(
        rulesIn(pkg, `import { a } from "@swain/${n}"; export { a };`),
        ["P-IMPORT"],
        `${pkg} -> ${n}`,
      );
    }
    // every (spec, name) any new profile allows is still rejected for the old package unless the
    // frozen P0 table allowed it already
    const frozen = new Set();
    for (const [, table] of FROZEN_RULES[pkg]) {
      for (const [spec, names] of Object.entries(table))
        for (const x of names) frozen.add(`${spec}|${x}`);
    }
    for (const n of [...SWAIN_PACKAGE_NAMES, "sdk-ts"]) {
      for (const [, table] of PACKAGE_RULES[n]) {
        for (const [spec, names] of Object.entries(table)) {
          for (const x of names) {
            if (frozen.has(`${spec}|${x}`)) continue;
            const rules = rulesIn(pkg, `import { ${x} } from "${spec}"; export { ${x} };`);
            assert.ok(
              rules.includes("P-IMPORT") || rules.includes("P-RANDOM"),
              `${pkg} must not allow ${spec} ${x} (granted to ${n})`,
            );
          }
        }
      }
    }
    // the new global rules and the timer exception bind the old packages as well
    assert.ok(rulesIn(pkg, "export const a = db.loadExtension('x');").includes("P-SQL"), pkg);
    assert.ok(rulesIn(pkg, "export const t = setTimeout(() => 1, 5);").includes("P-IDENT"), pkg);
    assert.ok(rulesIn(pkg, TIMER_USE, "export/x.ts").includes("P-IDENT"), pkg);
  }
});

test("bin.ts is not widened: the Swain env keys, stdin and process.once stay forbidden there", () => {
  const BIN = "packages/cli/src/bin.ts";
  const ok =
    "process.exitCode = runMain({ argv: process.argv.slice(2), stdout: (s) => process.stdout.write(s), stderr: process.stderr, env: { HOME: process.env.HOME, XDG_DATA_HOME: process.env.XDG_DATA_HOME }, nowMs: Date.now });";
  assert.deepEqual(rulesAt(BIN, ok), []);
  for (const extra of [
    "process.env.XDG_CONFIG_HOME",
    "process.env.XDG_STATE_HOME",
    "process.env.SWAIN_SERVER_URL",
    "process.env.SWAIN_DB",
  ]) {
    assert.deepEqual(rulesAt(BIN, ok.replace("process.env.HOME", extra)), ["P-PROCESS"], extra);
  }
  assert.deepEqual(rulesAt(BIN, ok.replace("process.stderr", "process.stdin")), ["P-PROCESS"]);
  assert.deepEqual(rulesAt(BIN, ok.replace("process.stderr", 'process.once("SIGINT", () => 1)')), [
    "P-PROCESS",
  ]);
  assert.deepEqual(BIN_VARIANTS["bin.ts"].env, ["HOME", "XDG_DATA_HOME"]);
  assert.deepEqual(BIN_VARIANTS["bin.js"].env, ["HOME", "XDG_DATA_HOME"]);
  assert.equal(BIN_VARIANTS["bin.ts"].swain, false);
  assert.equal(BIN_VARIANTS["bin.ts"].callee, "runMain");
});

// ---------------------------------------------------------------------------------------------
// scanTree: deferred sdk-ts
// ---------------------------------------------------------------------------------------------
function fullTree(root, extra) {
  for (const p of PACKAGE_NAMES) {
    mkdirSync(path.join(root, `packages/${p}/src`), { recursive: true });
    mkdirSync(path.join(root, `packages/${p}/dist/src`), { recursive: true });
    writeFileSync(path.join(root, `packages/${p}/src/a.ts`), "export const a = 1;\n");
    writeFileSync(path.join(root, `packages/${p}/dist/src/a.js`), "export const a = 1;\n");
  }
  extra?.();
}

test("scanTree: sdk-ts is optional (absent is fine) and scanned with its profile once present", () => {
  const root = mkdtempSync(path.join(tmpdir(), "swain-n0-"));
  try {
    fullTree(root);
    assert.deepEqual(scanTree(root), [], "absent sdk-ts: no P-MISSING, no P-PACKAGE");
    const dir = path.join(root, "packages/sdk-ts");
    mkdirSync(path.join(dir, "src/export"), { recursive: true });
    mkdirSync(path.join(dir, "dist/src/export"), { recursive: true });
    writeFileSync(path.join(dir, "src/index.ts"), "export const a = 1;\n");
    writeFileSync(path.join(dir, "dist/src/index.js"), "export const a = 1;\n");
    writeFileSync(path.join(dir, "src/export/ok.ts"), `${TIMER_USE}\n`);
    writeFileSync(path.join(dir, "dist/src/export/ok.js"), `${TIMER_USE}\n`);
    assert.deepEqual(scanTree(root), []);
    writeFileSync(path.join(dir, "src/other.ts"), "export const t = setTimeout(() => 1, 5);\n");
    assert.deepEqual(
      scanTree(root).map((f) => [f.file, f.rule]),
      [["packages/sdk-ts/src/other.ts", "P-IDENT"]],
    );
    rmSync(path.join(dir, "src/other.ts"));
    rmSync(path.join(dir, "dist/src/index.js"));
    rmSync(path.join(dir, "dist/src/export/ok.js"));
    assert.ok(
      scanTree(root).some((f) => f.file === "packages/sdk-ts/dist/src" && f.rule === "P-MISSING"),
      "a present sdk-ts without compiled output is P-MISSING",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("scanTree: a hostile file in each Swain package's src and dist is found, and a missing one is P-MISSING", () => {
  for (const n of SWAIN_PACKAGE_NAMES) {
    const root = mkdtempSync(path.join(tmpdir(), "swain-n0-"));
    try {
      fullTree(root);
      writeFileSync(path.join(root, `packages/${n}/src/b.ts`), "export const a = eval('1');\n");
      assert.deepEqual(
        scanTree(root).map((f) => [f.file, f.rule]),
        [[`packages/${n}/src/b.ts`, "P-IDENT"]],
        n,
      );
      writeFileSync(path.join(root, `packages/${n}/src/b.ts`), "export const b = 1;\n");
      rmSync(path.join(root, `packages/${n}/src`), { recursive: true });
      rmSync(path.join(root, `packages/${n}/dist`), { recursive: true });
      assert.deepEqual(
        scanTree(root).map((f) => [f.file, f.rule]),
        [
          [`packages/${n}/src`, "P-MISSING"],
          [`packages/${n}/dist/src`, "P-MISSING"],
        ],
        n,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

// ---------------------------------------------------------------------------------------------
// lockfile-check manifests for the new packages
// ---------------------------------------------------------------------------------------------
const baseManifests = () => ({
  root: {
    devDependencies: { typescript: "6.0.3", "@types/node": "24.19.2", "@biomejs/biome": "2.6.7" },
  },
  core: {},
  cli: { dependencies: { "@swain/core": "0.0.0" } },
  contractTests: { devDependencies: { "@swain/core": "0.0.0" } },
  packages: {},
});
const dep = (...names) => ({
  dependencies: Object.fromEntries(names.map((n) => [`@swain/${n}`, "0.0.0"])),
});
const GOOD_NEW = {
  model: { name: "@swain/model", ...dep("core") },
  otlp: { name: "@swain/otlp", ...dep("core", "model") },
  db: { name: "@swain/db", ...dep("core", "model", "report") },
  server: { name: "@swain/server", ...dep("core", "model", "otlp", "db", "report", "store") },
  client: { name: "@swain/client", ...dep("core", "model") },
};

test("manifests: the Swain packages' dependency sets are exact and enforced", () => {
  const m = baseManifests();
  m.packages = structuredClone(GOOD_NEW);
  assert.deepEqual(checkManifests(m), []);
  const codes = (mutate) => {
    const x = baseManifests();
    x.packages = structuredClone(GOOD_NEW);
    mutate(x.packages);
    return checkManifests(x).map((f) => f.code);
  };
  // one forbidden cross-package dependency per new package
  assert.deepEqual(
    codes((p) => (p.model.dependencies["@swain/db"] = "0.0.0")),
    ["L-MANIFEST"],
  );
  assert.deepEqual(
    codes((p) => (p.otlp.dependencies["@swain/db"] = "0.0.0")),
    ["L-MANIFEST"],
  );
  assert.deepEqual(
    codes((p) => (p.db.dependencies["@swain/server"] = "0.0.0")),
    ["L-MANIFEST"],
  );
  assert.deepEqual(
    codes((p) => (p.db.dependencies["@swain/store"] = "0.0.0")),
    ["L-MANIFEST"],
  );
  assert.deepEqual(
    codes((p) => (p.server.dependencies["@swain/client"] = "0.0.0")),
    ["L-MANIFEST"],
  );
  assert.deepEqual(
    codes((p) => (p.server.dependencies["@swain/cli"] = "0.0.0")),
    ["L-MANIFEST"],
  );
  assert.deepEqual(
    codes((p) => (p.client.dependencies["@swain/server"] = "0.0.0")),
    ["L-MANIFEST"],
  );
  assert.deepEqual(
    codes((p) => (p.client.dependencies["@swain/store"] = "0.0.0")),
    ["L-MANIFEST"],
  );
  // third-party, wrong version, missing core, other dependency kinds, wrong name
  for (const n of SWAIN_PACKAGE_NAMES) {
    assert.deepEqual(
      codes((p) => (p[n].dependencies.left = "1.0.0")),
      ["L-MANIFEST"],
      n,
    );
    assert.deepEqual(
      codes((p) => (p[n].dependencies["@swain/core"] = "^0.0.0")),
      ["L-MANIFEST"],
      n,
    );
    assert.deepEqual(
      codes((p) => delete p[n].dependencies["@swain/core"]),
      ["L-MANIFEST"],
      n,
    );
    assert.deepEqual(
      codes((p) => (p[n].devDependencies = { left: "1.0.0" })),
      ["L-MANIFEST"],
      n,
    );
    assert.deepEqual(
      codes((p) => (p[n].optionalDependencies = {})),
      ["L-MANIFEST"],
      n,
    );
    assert.deepEqual(
      codes((p) => (p[n].name = "@swain/other")),
      ["L-MANIFEST"],
      n,
    );
  }
  // no existing package may gain a new dependency
  for (const [pkg, existing] of Object.entries({
    report: ["core"],
    store: ["core", "report"],
    "adapter-opencode": ["core"],
  })) {
    for (const n of ["model", "otlp", "db", "server", "client"]) {
      const x = baseManifests();
      x.packages[pkg] = { name: `@swain/${pkg}`, ...dep(...existing, n) };
      assert.deepEqual(
        checkManifests(x).map((f) => f.code),
        ["L-MANIFEST"],
        `${pkg} + ${n}`,
      );
    }
  }
  const cli = baseManifests();
  cli.cli.dependencies["@swain/model"] = "0.0.0";
  assert.deepEqual(
    checkManifests(cli).map((f) => f.code),
    ["L-MANIFEST"],
    "cli may not gain model",
  );
});

test("manifests: sdk-ts must stay self-contained (no @swain dependency at all)", () => {
  const x = baseManifests();
  x.packages["sdk-ts"] = { name: "@swain/sdk-ts" };
  assert.deepEqual(checkManifests(x), []);
  x.packages["sdk-ts"] = { name: "@swain/sdk-ts", dependencies: {} };
  assert.deepEqual(checkManifests(x), []);
  x.packages["sdk-ts"] = { name: "@swain/sdk-ts", ...dep("core") };
  assert.deepEqual(
    checkManifests(x).map((f) => f.code),
    ["L-MANIFEST"],
  );
  x.packages["sdk-ts"] = { name: "@swain/sdk-ts", dependencies: { left: "1.0.0" } };
  assert.deepEqual(
    checkManifests(x).map((f) => f.code),
    ["L-MANIFEST"],
  );
});

test("lockfile: the five Swain workspaces are links in the real lockfile; sdk-ts and unlisted names are not accepted", () => {
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
  const lock = JSON.parse(readFileSync(path.join(root, "package-lock.json"), "utf8"));
  const closure = JSON.parse(
    readFileSync(path.join(root, "tools/expected-lock-closure.json"), "utf8"),
  );
  assert.deepEqual(checkLockfile(lock, closure), []);
  for (const n of SWAIN_PACKAGE_NAMES) {
    assert.deepEqual(lock.packages[`node_modules/@swain/${n}`], {
      resolved: `packages/${n}`,
      link: true,
    });
    assert.equal(lock.packages[`packages/${n}`].name, `@swain/${n}`);
    assert.ok(lock.packages[""].workspaces.includes(`packages/${n}`));
  }
  for (const n of ["sdk-ts", "evil"]) {
    const l = structuredClone(lock);
    l.packages[`node_modules/@swain/${n}`] = { resolved: `packages/${n}`, link: true };
    assert.ok(
      checkLockfile(l, closure).some((f) => f.code === "L-SWAIN-LINK"),
      n,
    );
  }
  const bad = structuredClone(lock);
  bad.packages["node_modules/@swain/model"] = { resolved: "packages/core", link: true };
  assert.ok(checkLockfile(bad, closure).some((f) => f.code === "L-SWAIN-LINK"));
});

test("G0 F11: the descriptor-level fs functions are allowed only in db/src/sqlite/, not anywhere else", () => {
  const OPEN = 'import { openSync, closeSync } from "node:fs"; export { openSync, closeSync };';
  assert.deepEqual(rulesIn("db", OPEN, "sqlite/open.ts"), []);
  assert.deepEqual(rulesAt("packages/db/dist/src/sqlite/open.js", OPEN), []);
  const COPY =
    'import { readSync, writeSync, fstatSync, fsyncSync, unlinkSync } from "node:fs"; export { readSync, writeSync, fstatSync, fsyncSync, unlinkSync };';
  assert.deepEqual(rulesIn("db", COPY, "sqlite/open.ts"), []);
  // G3 F1/F2/F10: chmod, fchmod and the hard link are allowed below sqlite/ only
  const PERMS =
    'import { chmodSync, fchmodSync, linkSync } from "node:fs"; export { chmodSync, fchmodSync, linkSync };';
  assert.deepEqual(rulesIn("db", PERMS, "sqlite/open.ts"), []);
  for (const [pkg, rel] of [
    ["db", "x.ts"],
    ["db", "migrations/x.ts"],
    ["db", "sqlite2/x.ts"],
  ]) {
    assert.ok(rulesIn(pkg, PERMS, rel).includes("P-IMPORT"), `${pkg}/${rel}`);
  }
  for (const [pkg, rel] of [
    ["db", "x.ts"],
    ["db", "migrations/x.ts"],
    ["db", "sqlite2/x.ts"],
  ]) {
    assert.ok(rulesIn(pkg, COPY, rel).includes("P-IMPORT"), `${pkg}/${rel}`);
  }
  for (const [pkg, rel] of [
    ["db", "x.ts"],
    ["db", "store/x.ts"],
    ["db", "sqlite2/x.ts"],
    ["db", "migrations/x.ts"],
    // store and client legitimately hold openSync in their own profiles
    ...PACKAGE_NAMES.filter((n) => !["db", "store", "client"].includes(n)).map((n) => [
      n,
      "sqlite/x.ts",
    ]),
  ]) {
    assert.ok(rulesIn(pkg, OPEN, rel).includes("P-IMPORT"), `${pkg}/${rel}`);
  }
  // the allowance names exactly seven functions: path-based writers and renames stay banned
  for (const name of [
    "writeFileSync",
    "readFileSync",
    "renameSync",
    "rmSync",
    "copyFileSync",
    "appendFileSync",
  ]) {
    const text = `import { ${name} } from "node:fs"; export { ${name} };`;
    assert.ok(rulesIn("db", text, "sqlite/open.ts").includes("P-IMPORT"), name);
  }
});
