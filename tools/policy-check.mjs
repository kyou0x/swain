// Repository policy check (SPEC-001 section 2, C1/C2). Defense in depth, NOT a sandbox.
// Parses every product source file with the pinned TypeScript compiler API and walks the
// full AST; it never pattern-matches on source text.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const BANNED_IDENT = new Set([
  "eval",
  "Function",
  "AsyncFunction",
  "GeneratorFunction",
  "Reflect",
  "Proxy",
  "WebAssembly",
  "fetch",
  "XMLHttpRequest",
  "WebSocket",
  "EventSource",
  "globalThis",
  "global",
  "self",
  "window",
  "require",
  "module",
  "exports",
  "__dirname",
  "__filename",
  "Atomics",
  "SharedArrayBuffer",
  "crypto",
  "performance",
  "Intl",
  "setTimeout",
  "setInterval",
  "setImmediate",
  "queueMicrotask",
  "WeakRef",
  "FinalizationRegistry",
  "localStorage",
  "sessionStorage",
  "navigator",
  "Buffer",
  "Event",
  "EventTarget",
  "PerformanceMark",
  "PerformanceMeasure",
  "PerformanceObserver",
  "PerformanceEntry",
  "BroadcastChannel",
  "MessageChannel",
]);

const BANNED_CTOR = new Set([
  "constructor",
  "__proto__",
  "__defineGetter__",
  "__defineSetter__",
  "__lookupGetter__",
  "__lookupSetter__",
]);

const BANNED_LOCALE = new Set([
  "toLocaleString",
  "toLocaleDateString",
  "toLocaleTimeString",
  "toLocaleUpperCase",
  "toLocaleLowerCase",
  "localeCompare",
]);

/** Local-time and time-zone dependent Date members (P-DATELOCAL). Only getUTC* / toISOString remain. */
const BANNED_DATELOCAL = new Set([
  "getFullYear",
  "getYear",
  "getMonth",
  "getDate",
  "getDay",
  "getHours",
  "getMinutes",
  "getSeconds",
  "getMilliseconds",
  "getTimezoneOffset",
  "setFullYear",
  "setMonth",
  "setDate",
  "setHours",
  "setMinutes",
  "setSeconds",
  "setMilliseconds",
  "toDateString",
  "toTimeString",
]);

/** SQLite extension loading (P-SQL): banned as a member name in every package, no exception. */
const BANNED_SQL_MEMBERS = new Set(["loadExtension", "enableLoadExtension"]);

function memberRule(name) {
  if (BANNED_SQL_MEMBERS.has(name)) return "P-SQL";
  if (BANNED_LOCALE.has(name)) return "P-LOCALE";
  if (BANNED_DATELOCAL.has(name)) return "P-DATELOCAL";
  return undefined;
}

// ---- package rules (SPEC-002 section 2.3) ----------------------------------------------------
/** The P0 packages (SPEC-002 section 2.3). Their profiles may never be widened (SPEC-003 N0). */
export const LEGACY_PACKAGE_NAMES = [
  "core",
  "adapter-claude-code",
  "adapter-codex-cli",
  "adapter-gemini-cli",
  "adapter-opencode",
  "report",
  "store",
  "cli",
];
/** The Swain packages added by SPEC-003 N0 (ADR-0004 section 4). Required: a missing one is P-MISSING. */
export const SWAIN_PACKAGE_NAMES = ["model", "otlp", "db", "server", "client"];
/**
 * Packages with a profile whose directory does not exist yet (`sdk-ts` arrives in N3). They are
 * scanned when present and never reported as missing or as an unlisted directory.
 */
export const DEFERRED_PACKAGE_NAMES = ["sdk-ts"];
/** Every scanned package, in report order. `contract-tests` is deliberately not scanned. */
export const PACKAGE_NAMES = [...LEGACY_PACKAGE_NAMES, ...SWAIN_PACKAGE_NAMES];
const KNOWN_PACKAGE_NAMES = [...PACKAGE_NAMES, ...DEFERRED_PACKAGE_NAMES];
const ADAPTER_NAMES = PACKAGE_NAMES.filter((n) => n.startsWith("adapter-"));
const SCAN_EXCLUDED = new Set(["contract-tests"]);

const CRYPTO_RULE = { "node:crypto": ["createHash"] };
const PATH_NAMES = ["join", "resolve", "basename", "dirname", "relative", "isAbsolute", "sep"];
const STORE_FS_NAMES = [
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

/**
 * P-NET: modules that open sockets, spawn processes or threads. A violation in every package
 * unless `PACKAGE_RULES` lists the exact specifier and names (server, client, sdk-ts only).
 */
export const NET_MODULES = new Set([
  "http",
  "https",
  "net",
  "tls",
  "dgram",
  "http2",
  "child_process",
  "worker_threads",
]);
/** P-SQL: the SQLite module; allowed only below `db/src/sqlite/` and only as `DatabaseSync`. */
export const SQL_MODULES = new Set(["sqlite"]);

/** `"node:http"` and the bare `"http"` are the same builtin. */
function builtinName(spec) {
  return spec.startsWith("node:") ? spec.slice("node:".length) : spec;
}

/** The scoped rule a builtin specifier belongs to, in addition to P-IMPORT. */
function builtinClassRule(spec) {
  const n = builtinName(spec);
  if (NET_MODULES.has(n)) return "P-NET";
  if (SQL_MODULES.has(n)) return "P-SQL";
  return undefined;
}

/**
 * package -> [[path prefix below src (posix, trailing slash, "" = whole package), {specifier:
 * allowed named imports}]]. A file may use the union of every entry whose prefix matches.
 */
export const PACKAGE_RULES = {
  core: [
    ["", CRYPTO_RULE],
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
  report: [["", CRYPTO_RULE]],
  store: [
    [
      "",
      {
        ...CRYPTO_RULE,
        "node:fs": STORE_FS_NAMES,
        "node:path": PATH_NAMES,
      },
    ],
  ],
  cli: [],
  ...Object.fromEntries(ADAPTER_NAMES.map((n) => [n, []])),
  // ---- Swain packages (ADR-0004 section 4, SPEC-003 N0) ----
  model: [["", CRYPTO_RULE]],
  otlp: [],
  db: [
    [
      "",
      {
        // randomBytes: key secrets, the server-proof secret and temp names (ADR-0004 r2; G3 F4)
        "node:crypto": ["createHash", "randomBytes"],
        "node:fs": ["lstatSync", "mkdirSync", "constants"],
        "node:path": PATH_NAMES,
      },
    ],
    // G0 F11 / ADR-0004 r2 section 2: the DB file and the backup copy are created `wx | O_NOFOLLOW`
    // 0600 by descriptor below sqlite/ only (open, fstat, read, write, fsync, close, unlink the temp).
    [
      "sqlite/",
      {
        "node:sqlite": ["DatabaseSync"],
        "node:fs": [
          "openSync",
          "closeSync",
          "readSync",
          "writeSync",
          "fstatSync",
          "fsyncSync",
          "unlinkSync",
          // G3 F1/F2/F10: chmod by descriptor, and the backup is published by hard link
          "fchmodSync",
          "chmodSync",
          "linkSync",
        ],
      },
    ],
  ],
  server: [
    [
      "",
      {
        "node:http": ["createServer"],
        "node:zlib": ["gunzipSync", "constants"],
        "node:crypto": ["createHash", "randomBytes", "timingSafeEqual"],
      },
    ],
  ],
  client: [
    [
      "",
      {
        // Agent: one keep-alive connection for the server proof and the key request (G3-auth F3)
        "node:http": ["request", "Agent"],
        "node:https": ["request"],
        "node:fs": STORE_FS_NAMES,
        "node:path": PATH_NAMES,
        "node:crypto": ["createHash", "randomBytes", "randomInt"],
      },
    ],
  ],
  "sdk-ts": [
    [
      "",
      {
        "node:http": ["request"],
        "node:https": ["request"],
        "node:crypto": ["randomBytes"],
      },
    ],
    ["export/", { "node:timers": ["setTimeout", "clearTimeout"] }],
  ],
};

/**
 * P-IDENT exceptions (ADR-0004 section 5): package -> [[path prefix below src, names]]. A name is
 * exempt only in a file below the prefix that imports it from `node:timers`.
 */
export const IDENT_EXCEPTIONS = {
  "sdk-ts": [["export/", ["setTimeout", "clearTimeout"]]],
};

/** package -> {`@swain/*` specifier: true when only `import type` / `export type` is allowed}. */
export const SWAIN_IMPORTS = {
  core: {},
  ...Object.fromEntries(ADAPTER_NAMES.map((n) => [n, { "@swain/core": false }])),
  report: { "@swain/core": false },
  store: { "@swain/core": false, "@swain/report": true },
  // N1.8 (ADR-0004 section 4): the `swain` composition root may import the server, the database and
  // the client. Nothing else is added, and `cli` keeps an EMPTY builtin table: every socket, file
  // and database operation stays inside those three packages.
  cli: Object.fromEntries(
    ["core", ...ADAPTER_NAMES, "report", "store", "server", "db", "client"].map((n) => [
      `@swain/${n}`,
      false,
    ]),
  ),
  model: { "@swain/core": false },
  otlp: { "@swain/core": false, "@swain/model": false },
  db: { "@swain/core": false, "@swain/model": false, "@swain/report": true },
  server: Object.fromEntries(
    ["core", "model", "otlp", "db", "report", "store"].map((n) => [`@swain/${n}`, false]),
  ),
  client: { "@swain/core": false, "@swain/model": false },
  // Self-contained so that it can be published alone: no `@swain/*` import at all.
  "sdk-ts": {},
};

/** package -> {`@swain/*` specifier: the only value names it may import}. Types are unrestricted. */
export const SWAIN_VALUE_NAMES = {
  server: { "@swain/store": ["buildImportRecord", "parseImportRecord"] },
};

/** Packages that may use the fs-touching exports of `@swain/core`. */
const FS_CORE_PACKAGES = new Set(["cli", "store"]);
/** Value exports of `@swain/core` that touch the filesystem. */
export const CORE_FS_EXPORTS = new Set(["readSourceFile", "walkImportPaths"]);

/**
 * True when the declaration `node` (import/export from an `@swain/*` module) could bring a value
 * export for which `isBad(name)` holds into a package that must not use it. Whole-module forms that
 * cannot be verified statically (default, namespace, `export *`, `import =`) are rejected as well.
 */
function bringsValue(node, isBad) {
  if (ts.isImportEqualsDeclaration(node)) return true;
  if (ts.isImportDeclaration(node)) {
    const c = node.importClause;
    if (c === undefined) return false; // side-effect import
    if (c.name !== undefined) return true;
    const nb = c.namedBindings;
    if (nb === undefined) return false;
    if (ts.isNamespaceImport(nb)) return true;
    return nb.elements.some((el) => !el.isTypeOnly && isBad(idText(el.propertyName ?? el.name)));
  }
  if (ts.isExportDeclaration(node)) {
    const c = node.exportClause;
    if (c === undefined || ts.isNamespaceExport(c)) return true;
    return c.elements.some((el) => !el.isTypeOnly && isBad(idText(el.propertyName ?? el.name)));
  }
  return false;
}

/** Filesystem-touching exports of `@swain/core` (see `CORE_FS_EXPORTS`). */
function bringsCoreFs(node) {
  return bringsValue(node, (n) => CORE_FS_EXPORTS.has(n));
}

function builtinAllow(pkgName, relInSrc, spec) {
  const names = new Set();
  let found = false;
  for (const [prefix, table] of PACKAGE_RULES[pkgName] ?? []) {
    if (!relInSrc.startsWith(prefix) || !Object.hasOwn(table, spec)) continue;
    found = true;
    for (const n of table[spec]) names.add(n);
  }
  return found ? names : undefined;
}

/** Local control-character escaper (tools do not import product code). */
export function escapePath(s) {
  let out = "";
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (ch === "\\") out += "\\\\";
    else if (
      cp <= 0x1f ||
      (cp >= 0x7f && cp <= 0x9f) ||
      cp === 0x61c ||
      cp === 0x200e ||
      cp === 0x200f ||
      (cp >= 0x202a && cp <= 0x202e) ||
      (cp >= 0x2066 && cp <= 0x2069) ||
      (cp >= 0xd800 && cp <= 0xdfff)
    ) {
      out += `\\u${cp.toString(16).toUpperCase().padStart(4, "0")}`;
    } else out += ch;
  }
  return out;
}

/** Package rules for a file. `srcRoot` is the repo-relative posix dir the file lives under. */
export function rulesFor(relPath) {
  const m = /^packages\/([^/]+)\/(src|dist\/src)(\/|$)/.exec(relPath);
  if (m === null || !KNOWN_PACKAGE_NAMES.includes(m[1])) return null;
  return { name: m[1], srcRoot: `packages/${m[1]}/${m[2]}` };
}

function idText(node) {
  // Identifiers and string-literal module export names (`import { "x" as y }`).
  return ts.isStringLiteral(node) ? node.text : ts.idText(node);
}

/** Strip parentheses, `as`, `satisfies`, `!` and `<T>` assertions. */
function unwrap(node) {
  let n = node;
  while (
    ts.isParenthesizedExpression(n) ||
    ts.isAsExpression(n) ||
    ts.isSatisfiesExpression(n) ||
    ts.isNonNullExpression(n) ||
    ts.isTypeAssertionExpression(n)
  ) {
    n = n.expression;
  }
  return n;
}

function isTypePosition(node) {
  for (let p = node.parent; p !== undefined; p = p.parent) {
    if (ts.isExpressionWithTypeArguments(p)) {
      // A type only in `implements` clauses and interface heritage. Instantiation expressions
      // (`Function<string>`) and `class X extends Expr` are value positions.
      const h = p.parent;
      if (
        h !== undefined &&
        ts.isHeritageClause(h) &&
        (h.token === ts.SyntaxKind.ImplementsKeyword ||
          (h.parent !== undefined && ts.isInterfaceDeclaration(h.parent)))
      ) {
        return true;
      }
      continue;
    }
    if (ts.isTypeNode(p) || ts.isInterfaceDeclaration(p) || ts.isTypeAliasDeclaration(p)) {
      return true;
    }
  }
  return false;
}

/** True when this identifier names a property/member rather than referencing a binding. */
function isNonReferenceName(node) {
  const p = node.parent;
  if (p === undefined) return false;
  if (ts.isPropertyAccessExpression(p) && p.name === node) return true;
  if (ts.isQualifiedName(p) && p.right === node) return true;
  if (ts.isPropertyAssignment(p) && p.name === node) return true;
  if (ts.isMethodDeclaration(p) && p.name === node) return true;
  if (ts.isPropertyDeclaration(p) && p.name === node) return true;
  if (ts.isGetAccessorDeclaration(p) && p.name === node) return true;
  if (ts.isSetAccessorDeclaration(p) && p.name === node) return true;
  if (ts.isPropertySignature(p) && p.name === node) return true;
  if (ts.isMethodSignature(p) && p.name === node) return true;
  if (ts.isEnumMember(p) && p.name === node) return true;
  if (ts.isBindingElement(p) && p.propertyName === node) return true;
  if ((ts.isImportSpecifier(p) || ts.isExportSpecifier(p)) && p.propertyName === node) return true;
  if ((ts.isLabeledStatement(p) || ts.isBreakOrContinueStatement(p)) && p.label === node) {
    return true;
  }
  return false;
}

function stringLiteralText(node) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return undefined;
}

/**
 * P-RANDOM: any `Math` reference must be the direct object (after unwrapping parentheses,
 * `as`, `satisfies`, `!`, `<T>`) of a property access whose name is not `random`, or of an
 * element access with a string-literal key other than `random`.
 */
function checkMath(node, report) {
  let top = node;
  while (
    top.parent !== undefined &&
    (ts.isParenthesizedExpression(top.parent) ||
      ts.isAsExpression(top.parent) ||
      ts.isSatisfiesExpression(top.parent) ||
      ts.isNonNullExpression(top.parent) ||
      ts.isTypeAssertionExpression(top.parent))
  ) {
    top = top.parent;
  }
  const p = top.parent;
  if (p !== undefined && ts.isPropertyAccessExpression(p) && p.expression === top) {
    if (idText(p.name) === "random") report(p.name, "P-RANDOM");
    return;
  }
  if (p !== undefined && ts.isElementAccessExpression(p) && p.expression === top) {
    const lit = stringLiteralText(unwrap(p.argumentExpression));
    if (lit === undefined || lit === "random") report(p.argumentExpression, "P-RANDOM");
    return;
  }
  report(node, "P-RANDOM");
}

/**
 * `typeOnly` is true for `import type` / `export type` declarations. `importClause` is defined
 * only for import declarations (builtins are allowed nowhere else).
 */
function checkSpecifier(spec, file, pkg, report, node, importClause, typeOnly) {
  // `spec` is the literal text or undefined for non-literal specifiers.
  if (spec === undefined) {
    report(node, "P-IMPORT");
    return;
  }
  if (spec.startsWith("./") || spec.startsWith("../") || spec === "." || spec === "..") {
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(file), spec));
    if (!(resolved === pkg.srcRoot || resolved.startsWith(`${pkg.srcRoot}/`))) {
      report(node, "P-RELATIVE");
    }
    // A test-only module (`.../testing.js`) is never imported by source files; tests are not scanned.
    if (/(^|\/)testing(\.js|\.ts)?$/.test(resolved)) report(node, "P-RELATIVE");
    return;
  }
  const atm = /^(@swain\/[^/]+)(?:\/|$)/.exec(spec);
  if (atm !== null) {
    const table = SWAIN_IMPORTS[pkg.name] ?? {};
    if (!Object.hasOwn(table, atm[1]) || (table[atm[1]] === true && !typeOnly)) {
      report(node, "P-IMPORT");
    } else if (
      atm[1] === "@swain/core" &&
      !typeOnly &&
      !FS_CORE_PACKAGES.has(pkg.name) &&
      bringsCoreFs(node)
    ) {
      report(node, "P-IMPORT");
    } else if (!typeOnly && Object.hasOwn(SWAIN_VALUE_NAMES[pkg.name] ?? {}, atm[1])) {
      const names = SWAIN_VALUE_NAMES[pkg.name][atm[1]];
      if (bringsValue(node, (n) => !names.includes(n))) report(node, "P-IMPORT");
    }
    return;
  }
  const relInSrc = path.posix.normalize(file).slice(pkg.srcRoot.length + 1);
  const allowed = builtinAllow(pkg.name, relInSrc, spec);
  // P-NET / P-SQL are reported in addition to the generic P-IMPORT.
  const scoped = builtinClassRule(spec);
  if (allowed === undefined || importClause === undefined) {
    report(node, "P-IMPORT");
    if (scoped !== undefined) report(node, scoped);
    return;
  }
  const { name, namedBindings } = importClause;
  if (name !== undefined || namedBindings === undefined || ts.isNamespaceImport(namedBindings)) {
    report(node, "P-IMPORT");
    if (scoped !== undefined) report(node, scoped);
    return;
  }
  for (const el of namedBindings.elements) {
    const imported = idText(el.propertyName ?? el.name);
    if (!allowed.has(imported)) {
      report(el, spec === "node:crypto" ? "P-RANDOM" : "P-IMPORT");
      if (scoped !== undefined) report(el, scoped);
    }
  }
}

/**
 * Binds the bin allowance to the single `<callee>(...)` call (`runMain` in bin.ts, `runSwain` in
 * swain-bin.ts): `call` is that call, or undefined when the file has zero or several (then
 * nothing is allowed).
 */
function binContext(sf, calleeName) {
  const calls = [];
  const find = (n) => {
    if (ts.isCallExpression(n)) {
      const callee = unwrap(n.expression);
      if (ts.isIdentifier(callee) && idText(callee) === calleeName) calls.push(n);
    }
    ts.forEachChild(n, find);
  };
  find(sf);
  const call = calls.length === 1 ? calls[0] : undefined;
  /** True when `node` lies anywhere inside an argument of the bound call. */
  const inArgs = (node) => {
    if (call === undefined) return false;
    for (let n = node; n.parent !== undefined; n = n.parent) {
      if (n.parent === call) return call.arguments.includes(n);
    }
    return false;
  };
  /** True when `node` is a direct argument, or the value of a property of a direct object literal. */
  const isArgSlot = (node) => {
    if (call === undefined) return false;
    const p = node.parent;
    if (p === undefined) return false;
    if (p === call) return call.arguments.includes(node);
    return (
      ts.isPropertyAssignment(p) &&
      p.initializer === node &&
      p.parent !== undefined &&
      ts.isObjectLiteralExpression(p.parent) &&
      p.parent.parent === call &&
      call.arguments.includes(p.parent)
    );
  };
  return { inArgs, isArgSlot };
}

function isWriteTarget(node) {
  const p = node.parent;
  if (p === undefined) return false;
  if (ts.isBinaryExpression(p)) {
    const k = p.operatorToken.kind;
    return (
      k >= ts.SyntaxKind.FirstAssignment && k <= ts.SyntaxKind.LastAssignment && p.left === node
    );
  }
  return (
    ts.isDeleteExpression(p) ||
    ts.isPrefixUnaryExpression(p) ||
    ts.isPostfixUnaryExpression(p) ||
    ts.isForOfStatement(p) ||
    ts.isForInStatement(p)
  );
}

const SWAIN_ENV_KEYS = [
  "HOME",
  "XDG_DATA_HOME",
  "XDG_CONFIG_HOME",
  "XDG_STATE_HOME",
  "SWAIN_SERVER_URL",
  "SWAIN_DB",
];

/**
 * The two entry files of `@swain/cli` (`src/` root only). `bin.ts` is the P0 shape and is frozen;
 * `swain-bin.ts` (ADR-0004 section 5) is bound to a single `runSwain(...)` call and additionally
 * allows more env keys, `process.stdin` as an argument and `process.once("SIGINT"|"SIGTERM", ...)`.
 */
export const BIN_VARIANTS = {
  "bin.ts": { callee: "runMain", swain: false, env: ["HOME", "XDG_DATA_HOME"] },
  "bin.js": { callee: "runMain", swain: false, env: ["HOME", "XDG_DATA_HOME"] },
  "swain-bin.ts": { callee: "runSwain", swain: true, env: SWAIN_ENV_KEYS },
  "swain-bin.js": { callee: "runSwain", swain: true, env: SWAIN_ENV_KEYS },
};
const SWAIN_SIGNALS = new Set(["SIGINT", "SIGTERM"]);

function checkBinProcess(node, report, bin, variant) {
  // node is the identifier `process`. Allowed in a bin file only as:
  //   process.argv, process.exitCode
  //   process.stdout / process.stderr inside the bound call's arguments, bare as an argument or
  //     object property value, or as `process.stdout.write` / `process.stderr.write`
  //   process.env.<key> for the variant's keys (dotted, read only)
  //   swain-bin only: process.stdin bare as an argument or object property value, and
  //     process.once("SIGINT" | "SIGTERM", ...) called inside the bound call's arguments
  const pa = node.parent;
  if (!(pa !== undefined && ts.isPropertyAccessExpression(pa) && pa.expression === node)) {
    report(node, "P-PROCESS");
    return;
  }
  const prop = idText(pa.name);
  if (prop === "argv" || prop === "exitCode") return;
  if (prop === "stdout" || prop === "stderr") {
    const q = pa.parent;
    const isWrite =
      q !== undefined &&
      ts.isPropertyAccessExpression(q) &&
      q.expression === pa &&
      idText(q.name) === "write";
    if (bin.inArgs(pa) && (bin.isArgSlot(pa) || isWrite)) return;
    report(node, "P-PROCESS");
    return;
  }
  if (variant.swain && prop === "stdin") {
    if (bin.inArgs(pa) && bin.isArgSlot(pa)) return;
    report(node, "P-PROCESS");
    return;
  }
  if (variant.swain && prop === "once") {
    const q = pa.parent;
    const sig =
      q !== undefined && ts.isCallExpression(q) && q.expression === pa && q.arguments.length > 0
        ? stringLiteralText(q.arguments[0])
        : undefined;
    if (sig !== undefined && SWAIN_SIGNALS.has(sig) && bin.inArgs(pa)) return;
    report(node, "P-PROCESS");
    return;
  }
  if (prop === "env") {
    const q = pa.parent;
    if (
      q !== undefined &&
      ts.isPropertyAccessExpression(q) &&
      q.expression === pa &&
      variant.env.includes(idText(q.name)) &&
      !isWriteTarget(q)
    ) {
      return;
    }
  }
  report(node, "P-PROCESS");
}

/** Key text of an object-literal/pattern property name, when statically known. */
function keyText(nameNode) {
  if (ts.isIdentifier(nameNode)) return idText(nameNode);
  if (ts.isComputedPropertyName(nameNode)) return stringLiteralText(unwrap(nameNode.expression));
  return stringLiteralText(nameNode);
}

/** True when this object literal is a destructuring assignment target (`({a: x} = y)`). */
function isAssignmentPattern(literal) {
  let n = literal;
  for (;;) {
    const p = n.parent;
    if (p === undefined) return false;
    if (ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      return p.left === n;
    }
    if (ts.isForOfStatement(p) || ts.isForInStatement(p)) return p.initializer === n;
    if (
      ts.isParenthesizedExpression(p) ||
      ts.isArrayLiteralExpression(p) ||
      ts.isSpreadElement(p) ||
      ts.isObjectLiteralExpression(p) ||
      (ts.isPropertyAssignment(p) && p.initializer === n)
    ) {
      n = p;
      continue;
    }
    return false;
  }
}

/**
 * Check one file. `file` is the repo-relative posix path (used for the rule set, relative-import
 * resolution and the bin.ts allowance). Returns findings `{file, line, col, rule}`.
 */
export function checkFile(file, text, pkg) {
  const findings = [];
  const ext = path.posix.extname(file);
  const isDist = pkg.srcRoot.includes("/dist/");
  if (!isDist && (ext !== ".ts" || file.endsWith(".d.ts"))) {
    findings.push({ file, line: 1, col: 1, rule: "P-EXT" });
    return findings;
  }
  const kind =
    ext === ".ts" || ext === ".mts" || ext === ".cts" ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  const binVariant =
    pkg.name === "cli" && path.posix.dirname(file) === pkg.srcRoot
      ? BIN_VARIANTS[path.posix.basename(file)]
      : undefined;
  const bin = binVariant !== undefined ? binContext(sf, binVariant.callee) : undefined;

  // P-IDENT exceptions are scoped to a package, a path prefix and an import from `node:timers`.
  const identExempt = new Set();
  const relFile = path.posix.normalize(file).slice(pkg.srcRoot.length + 1);
  for (const [prefix, names] of IDENT_EXCEPTIONS[pkg.name] ?? []) {
    if (!relFile.startsWith(prefix)) continue;
    for (const st of sf.statements) {
      if (
        ts.isImportDeclaration(st) &&
        stringLiteralText(st.moduleSpecifier) === "node:timers" &&
        st.importClause?.namedBindings !== undefined &&
        ts.isNamedImports(st.importClause.namedBindings)
      ) {
        for (const el of st.importClause.namedBindings.elements) {
          const imported = idText(el.propertyName ?? el.name);
          if (names.includes(imported) && idText(el.name) === imported) identExempt.add(imported);
        }
      }
    }
  }

  const report = (node, rule) => {
    const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    findings.push({ file, line: line + 1, col: character + 1, rule });
  };

  const visit = (node) => {
    // ---- module specifiers
    if (ts.isImportDeclaration(node)) {
      checkSpecifier(
        stringLiteralText(node.moduleSpecifier),
        file,
        pkg,
        report,
        node,
        node.importClause,
        node.importClause?.isTypeOnly === true,
      );
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined) {
      const spec = stringLiteralText(node.moduleSpecifier);
      checkSpecifier(spec, file, pkg, report, node, undefined, node.isTypeOnly);
    } else if (ts.isImportEqualsDeclaration(node)) {
      const ref = node.moduleReference;
      if (ts.isExternalModuleReference(ref)) {
        const spec = stringLiteralText(ref.expression);
        checkSpecifier(spec, file, pkg, report, node, undefined, node.isTypeOnly);
      }
    } else if (ts.isImportTypeNode(node)) {
      const lit = ts.isLiteralTypeNode(node.argument) ? node.argument.literal : undefined;
      const spec = lit !== undefined ? stringLiteralText(lit) : undefined;
      checkSpecifier(spec, file, pkg, report, node, undefined, true);
    }

    // ---- dynamic import / import.meta
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      report(node, "P-DYNIMPORT");
    }
    if (ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword) {
      report(node, "P-IMPORTMETA");
    }

    // ---- identifiers
    if (ts.isIdentifier(node) && !isNonReferenceName(node) && !isTypePosition(node)) {
      const name = idText(node);
      if (BANNED_IDENT.has(name) && !identExempt.has(name)) report(node, "P-IDENT");
      if (name === "process") {
        if (bin !== undefined) checkBinProcess(node, report, bin, binVariant);
        else report(node, "P-PROCESS");
      }
      if (name === "Math") checkMath(node, report);
      if (name === "Date") {
        const p = node.parent;
        const okUtc =
          p !== undefined &&
          ts.isPropertyAccessExpression(p) &&
          p.expression === node &&
          idText(p.name) === "UTC" &&
          p.parent !== undefined &&
          ts.isCallExpression(p.parent) &&
          p.parent.expression === p;
        const okNew =
          p !== undefined &&
          ts.isNewExpression(p) &&
          p.expression === node &&
          p.arguments !== undefined &&
          p.arguments.length === 1 &&
          !ts.isSpreadElement(p.arguments[0]);
        // bin.ts may hand `Date.now` (a reference, never a call) to runMain.
        const okNow =
          bin !== undefined &&
          p !== undefined &&
          ts.isPropertyAccessExpression(p) &&
          p.expression === node &&
          idText(p.name) === "now" &&
          bin.isArgSlot(p);
        if (!okUtc && !okNew && !okNow) report(node, "P-DATE");
      }
    }

    // ---- constructor / prototype access
    if (ts.isPropertyAccessExpression(node)) {
      const name = idText(node.name);
      if (BANNED_CTOR.has(name) && !isTypePosition(node)) report(node.name, "P-CTOR");
      const rule = memberRule(name);
      if (rule !== undefined) report(node.name, rule);
    }
    if (ts.isElementAccessExpression(node)) {
      const lit = stringLiteralText(unwrap(node.argumentExpression));
      const rule = lit === undefined ? undefined : memberRule(lit);
      if (rule !== undefined) report(node.argumentExpression, rule);
    }
    if (ts.isBindingElement(node)) {
      const key = node.propertyName ?? node.name;
      const text =
        ts.isIdentifier(key) || ts.isStringLiteral(key) || ts.isComputedPropertyName(key)
          ? keyText(key)
          : undefined;
      const rule = text === undefined ? undefined : memberRule(text);
      if (rule !== undefined && !isTypePosition(node)) report(key, rule);
      if (ts.isIdentifier(key) && BANNED_CTOR.has(idText(key)) && !isTypePosition(node)) {
        report(key, "P-CTOR");
      }
    }
    if (
      (ts.isShorthandPropertyAssignment(node) || ts.isPropertyAssignment(node)) &&
      ts.isObjectLiteralExpression(node.parent) &&
      isAssignmentPattern(node.parent)
    ) {
      const text = keyText(node.name);
      const rule = text === undefined ? undefined : memberRule(text);
      if (rule !== undefined) report(node.name, rule);
    }
    if (ts.isShorthandPropertyAssignment(node) && BANNED_CTOR.has(idText(node.name))) {
      report(node.name, "P-CTOR");
    }
    if (
      (ts.isPropertyAssignment(node) || ts.isMethodDeclaration(node)) &&
      ts.isIdentifier(node.name) &&
      BANNED_CTOR.has(idText(node.name))
    ) {
      report(node.name, "P-CTOR");
    }
    // N5: banned names as string or substitution-free template literals anywhere.
    const lit = stringLiteralText(node);
    if (lit !== undefined && BANNED_CTOR.has(lit) && !isTypePosition(node)) report(node, "P-CTOR");

    ts.forEachChild(node, visit);
  };
  visit(sf);
  return findings;
}

/** Returns the file list, or `undefined` when the directory does not exist (ENOENT). */
function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    if (e?.code === "ENOENT") return undefined;
    throw e;
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

function toPosix(p) {
  return p.split(path.sep).join("/");
}

/** Scan `packages/<pkg>/src/**` and `packages/<pkg>/dist/src/**` under `repoRoot`. */
export function scanTree(repoRoot) {
  const findings = [];
  // Unlisted package directories fail closed (contract-tests is the one exclusion).
  const pkgRoot = path.join(repoRoot, "packages");
  let present;
  try {
    present = readdirSync(pkgRoot, { withFileTypes: true });
  } catch (e) {
    if (e?.code !== "ENOENT") throw e;
    present = [];
  }
  for (const e of present.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    if (!e.isFile() && !KNOWN_PACKAGE_NAMES.includes(e.name) && !SCAN_EXCLUDED.has(e.name)) {
      findings.push({ file: `packages/${e.name}`, line: 1, col: 1, rule: "P-PACKAGE" });
    }
  }
  for (const name of KNOWN_PACKAGE_NAMES) {
    // A deferred package (sdk-ts before N3) is scanned only once its directory exists.
    if (DEFERRED_PACKAGE_NAMES.includes(name) && !present.some((e) => e.name === name)) continue;
    const srcDir = path.join(repoRoot, "packages", name, "src");
    const distDir = path.join(repoRoot, "packages", name, "dist", "src");
    const srcFiles = walk(srcDir);
    if (srcFiles === undefined || srcFiles.length === 0) {
      findings.push({
        file: toPosix(path.relative(repoRoot, srcDir)),
        line: 1,
        col: 1,
        rule: "P-MISSING",
      });
    }
    for (const full of srcFiles ?? []) {
      const rel = toPosix(path.relative(repoRoot, full));
      const pkg = rulesFor(rel);
      if (path.extname(full) !== ".ts" || full.endsWith(".d.ts")) {
        findings.push({ file: rel, line: 1, col: 1, rule: "P-EXT" });
        continue;
      }
      findings.push(...checkFile(rel, readFileSync(full, "utf8"), pkg));
    }
    const distFiles = walk(distDir);
    if (distFiles === undefined || !distFiles.some((f) => f.endsWith(".js"))) {
      findings.push({
        file: toPosix(path.relative(repoRoot, distDir)),
        line: 1,
        col: 1,
        rule: "P-MISSING",
      });
    }
    for (const full of distFiles ?? []) {
      const rel = toPosix(path.relative(repoRoot, full));
      const pkg = rulesFor(rel);
      const inner = path.relative(distDir, full);
      let sourceTwin;
      let scan = false;
      if (inner.endsWith(".d.ts.map")) sourceTwin = inner.slice(0, -".d.ts.map".length);
      else if (inner.endsWith(".d.ts")) sourceTwin = inner.slice(0, -".d.ts".length);
      else if (inner.endsWith(".js.map")) sourceTwin = inner.slice(0, -".js.map".length);
      else if (inner.endsWith(".js")) {
        sourceTwin = inner.slice(0, -".js".length);
        scan = true;
      }
      if (sourceTwin === undefined || !statExists(path.join(srcDir, `${sourceTwin}.ts`))) {
        findings.push({ file: rel, line: 1, col: 1, rule: "P-EXT" });
        continue;
      }
      if (scan) findings.push(...checkFile(rel, readFileSync(full, "utf8"), pkg));
    }
  }
  return findings;
}

function statExists(p) {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

export function formatFinding(f) {
  return `${escapePath(f.file)}:${f.line}:${f.col}:${f.rule}`;
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const findings = scanTree(repoRoot);
  for (const f of findings) process.stdout.write(`${formatFinding(f)}\n`);
  if (findings.length > 0) process.exitCode = 1;
  else process.stdout.write("policy-check: ok\n");
}
