// Lockfile and supply-chain check (SPEC-001 section 3, C6/R3). Exits 1 on any failure.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REGISTRY = "https://registry.npmjs.org/";
const ADAPTERS = [
  "adapter-claude-code",
  "adapter-codex-cli",
  "adapter-gemini-cli",
  "adapter-opencode",
];
/** The Swain workspaces added by SPEC-003 N0 (ADR-0004 section 4). */
const SWAIN_WORKSPACES = ["model", "otlp", "db", "server", "client"];
const WORKSPACES = [
  "core",
  ...ADAPTERS,
  "report",
  "store",
  ...SWAIN_WORKSPACES,
  "cli",
  "contract-tests",
];
/**
 * SPEC-002 section 2.1 and ADR-0004 section 4: the only `@swain/*` dependencies each workspace
 * manifest may declare. `sdk-ts` (N3) has a profile but is not yet a workspace: it must stay
 * self-contained, so it may declare none.
 */
export const SWAIN_DEPS = {
  ...Object.fromEntries(ADAPTERS.map((a) => [a, ["core"]])),
  report: ["core"],
  store: ["core", "report"],
  // N1.8 (ADR-0004 section 4): the `swain` bin composes the server, the database and the client.
  cli: ["core", ...ADAPTERS, "report", "store", "server", "db", "client"],
  model: ["core"],
  otlp: ["core", "model"],
  db: ["core", "model", "report"],
  server: ["core", "model", "otlp", "db", "report", "store"],
  client: ["core", "model"],
  "sdk-ts": [],
};
/** npm package names: optional lowercase scope, no leading dot/underscore, no uppercase. */
const NPM_NAME = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;
const WORKSPACE_FOLDERS = new Set(WORKSPACES.map((w) => `packages/${w}`));
const EXPECTED_DEV_DEPS = ["@biomejs/biome", "@types/node", "typescript"];
const EXPECTED_NPMRC = [
  "engine-strict=true",
  "fund=false",
  "audit=false",
  "ignore-scripts=true",
  "save-exact=true",
].sort();
const FORBIDDEN_REF = /^(git\+|git:|github:|file:|link:|http:)/;
const DEP_KINDS = [
  "dependencies",
  "optionalDependencies",
  "peerDependencies",
  "bundleDependencies",
  "bundledDependencies",
];

/** Local control-character escaper (tools do not import product code). */
export function esc(s) {
  let out = "";
  for (const ch of String(s)) {
    const cp = ch.codePointAt(0);
    if (ch === "\\") out += "\\\\";
    else if (
      cp <= 0x1f ||
      (cp >= 0x7f && cp <= 0x9f) ||
      (cp >= 0x202a && cp <= 0x202e) ||
      (cp >= 0x2066 && cp <= 0x2069) ||
      cp === 0x200e ||
      cp === 0x200f ||
      cp === 0x61c ||
      (cp >= 0xd800 && cp <= 0xdfff)
    ) {
      out += `\\u${cp.toString(16).toUpperCase().padStart(4, "0")}`;
    } else out += ch;
  }
  return out;
}

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

function* strings(v) {
  if (typeof v === "string") yield v;
  else if (Array.isArray(v)) for (const x of v) yield* strings(x);
  else if (isObj(v)) for (const x of Object.values(v)) yield* strings(x);
}

function nameFromKey(key) {
  const i = key.lastIndexOf("node_modules/");
  return key.slice(i + "node_modules/".length);
}

/** Map `name@version` -> integrity for every third-party (group c) entry, sorted by key. */
export function computeClosure(lock) {
  const out = {};
  for (const key of Object.keys(lock.packages ?? {}).sort()) {
    const entry = lock.packages[key];
    if (
      key === "" ||
      WORKSPACE_FOLDERS.has(key) ||
      key.includes("/@swain/") ||
      key.startsWith("node_modules/@swain/")
    )
      continue;
    out[`${nameFromKey(key)}@${entry.version}`] = entry.integrity;
  }
  return out;
}

/** The only acceptable tarball URL for a registry package. */
export function canonicalTarball(name, version) {
  return `${REGISTRY}${name}/-/${name.slice(name.lastIndexOf("/") + 1)}-${version}.tgz`;
}

/** Returns `[{code, detail}]`; empty when the lockfile is acceptable. */
export function checkLockfile(lock, expectedClosure) {
  const failures = [];
  const fail = (code, detail) => failures.push({ code, detail });
  if (!isObj(lock) || lock.lockfileVersion !== 3) fail("L-LOCKVER", "lockfileVersion must be 3");
  const packages = isObj(lock?.packages) ? lock.packages : {};
  for (const [key, entry] of Object.entries(packages)) {
    if (!isObj(entry)) {
      fail("L-UNCLASSIFIED", `entry is not an object: ${key}`);
      continue;
    }
    for (const s of strings(entry)) {
      if (FORBIDDEN_REF.test(s))
        fail("L-FORBIDDEN-REF", `${key}: forbidden reference ${s.slice(0, 80)}`);
    }
    if (key === "" || WORKSPACE_FOLDERS.has(key)) continue; // group (a)
    if (
      key.startsWith("node_modules/@swain/") &&
      !key.slice("node_modules/@swain/".length).includes("/")
    ) {
      const name = key.slice("node_modules/@swain/".length);
      if (
        !(WORKSPACES.includes(name) && entry.link === true && entry.resolved === `packages/${name}`)
      ) {
        fail("L-SWAIN-LINK", `${key}: must be link:true with resolved packages/${name}`);
      }
      continue; // group (b)
    }
    if (key.includes("/@swain/") || key.startsWith("@swain/")) {
      fail("L-SWAIN-LINK", `${key}: unexpected @swain entry`);
      continue;
    }
    if (!key.startsWith("node_modules/") && !key.includes("/node_modules/")) {
      fail("L-UNCLASSIFIED", `${key}: entry fits no allowed group`);
      continue;
    }
    // group (c)
    if (!NPM_NAME.test(nameFromKey(key))) {
      fail("L-NAME", `${key}: path-derived package name is not a valid npm name`);
    }
    if (entry.link === true)
      fail("L-LINK", `${key}: link entries are only allowed for @swain workspaces`);
    const name = nameFromKey(key);
    if (entry.name !== undefined && entry.name !== name) {
      fail("L-ALIAS", `${key}: name field differs from the path-derived name`);
    }
    if (typeof entry.resolved !== "string" || !entry.resolved.startsWith(REGISTRY)) {
      fail("L-RESOLVED", `${key}: resolved must start with ${REGISTRY}`);
    } else if (entry.resolved !== canonicalTarball(name, entry.version)) {
      fail(
        "L-TARBALL",
        `${key}: resolved is not the canonical registry tarball for ${name}@${entry.version}`,
      );
    }
    if (typeof entry.integrity !== "string" || !entry.integrity.startsWith("sha512-")) {
      fail("L-INTEGRITY", `${key}: integrity must start with sha512-`);
    }
  }
  const actual = computeClosure({ packages });
  const exp = isObj(expectedClosure?.closure) ? expectedClosure.closure : {};
  const extra = Object.keys(actual).filter((x) => !Object.hasOwn(exp, x));
  const missing = Object.keys(exp).filter((x) => !Object.hasOwn(actual, x));
  if (extra.length > 0 || missing.length > 0) {
    fail(
      "L-CLOSURE",
      `closure differs: extra [${extra.join(", ")}] missing [${missing.join(", ")}]`,
    );
  }
  // Integrity is pinned per lockfile path: duplicates of one name@version at different paths are
  // each compared (a name@version map would let the last duplicate mask the others).
  for (const [key, entry] of Object.entries(packages)) {
    if (
      !isObj(entry) ||
      key === "" ||
      WORKSPACE_FOLDERS.has(key) ||
      key.includes("/@swain/") ||
      key.startsWith("node_modules/@swain/") ||
      (!key.startsWith("node_modules/") && !key.includes("/node_modules/"))
    )
      continue;
    const id = `${nameFromKey(key)}@${entry.version}`;
    if (
      Object.hasOwn(exp, id) &&
      typeof entry.integrity === "string" &&
      entry.integrity.startsWith("sha512-") &&
      entry.integrity !== exp[id]
    ) {
      fail("L-INTEGRITY-PIN", `${key}: integrity differs from the pinned value`);
    }
  }
  return failures;
}

export function installScriptEntries(lock) {
  return Object.entries(lock?.packages ?? {})
    .filter(([, e]) => isObj(e) && e.hasInstallScript === true)
    .map(([k, e]) => `${k}@${e.version}`);
}

function hasKeys(obj, keys) {
  return keys.filter((k) => isObj(obj) && Object.hasOwn(obj, k));
}

function sameDeps(actual, expected) {
  if (!isObj(actual)) return false;
  const a = Object.entries(actual).sort();
  const e = Object.entries(expected).sort();
  return JSON.stringify(a) === JSON.stringify(e);
}

/** manifests: {root, core, cli, contractTests, packages?: {dir: manifest}} parsed package.json objects. */
export function checkManifests(m) {
  const failures = [];
  const fail = (detail) => failures.push({ code: "L-MANIFEST", detail });
  const devNames = isObj(m.root?.devDependencies) ? Object.keys(m.root.devDependencies).sort() : [];
  if (JSON.stringify(devNames) !== JSON.stringify(EXPECTED_DEV_DEPS)) {
    failures.push({
      code: "L-DEVDEPS",
      detail: `root devDependencies must be exactly ${EXPECTED_DEV_DEPS.join(", ")}`,
    });
  }
  for (const [label, pkg] of [
    ["root", m.root],
    ["packages/core", m.core],
  ]) {
    const bad = hasKeys(pkg, DEP_KINDS);
    if (bad.length > 0) fail(`${label}: forbidden keys ${bad.join(", ")}`);
  }
  const swainDeps = (dir, manifest) => {
    const bad = hasKeys(manifest, [
      ...DEP_KINDS.filter((k) => k !== "dependencies"),
      "devDependencies",
    ]);
    if (bad.length > 0) fail(`packages/${dir}: forbidden keys ${bad.join(", ")}`);
    const deps = manifest?.dependencies;
    const allowed = SWAIN_DEPS[dir].map((n) => `@swain/${n}`);
    const entries = isObj(deps) ? Object.entries(deps) : [];
    const ok =
      allowed.length === 0
        ? deps === undefined || (isObj(deps) && entries.length === 0)
        : isObj(deps) &&
          Object.hasOwn(deps, "@swain/core") &&
          entries.every(([k, v]) => allowed.includes(k) && v === "0.0.0");
    if (!ok) {
      fail(
        allowed.length === 0
          ? `packages/${dir}: must declare no @swain dependencies`
          : `packages/${dir}: dependencies must be a subset of {${allowed.join(", ")}} at 0.0.0, including @swain/core`,
      );
    }
  };
  swainDeps("cli", m.cli);
  for (const [dir, manifest] of Object.entries(m.packages ?? {})) {
    if (!Object.hasOwn(SWAIN_DEPS, dir)) {
      fail(`packages/${dir}: unknown workspace`);
      continue;
    }
    if (manifest?.name !== `@swain/${dir}`) fail(`packages/${dir}: name must be @swain/${dir}`);
    swainDeps(dir, manifest);
  }
  {
    const bad = hasKeys(
      m.contractTests,
      DEP_KINDS.filter((k) => k !== "dependencies"),
    );
    if (bad.length > 0) fail(`packages/contract-tests: forbidden keys ${bad.join(", ")}`);
    const d = m.contractTests?.dependencies;
    const dd = m.contractTests?.devDependencies;
    const want = { "@swain/core": "0.0.0" };
    const ok = (sameDeps(d, want) && dd === undefined) || (sameDeps(dd, want) && d === undefined);
    if (!ok)
      fail(
        'packages/contract-tests: exactly one of dependencies/devDependencies, equal to {"@swain/core":"0.0.0"}',
      );
  }
  return failures;
}

export function checkNpmrc(text) {
  const lines = text
    .split("\n")
    .filter((l) => l !== "")
    .sort();
  const ok = JSON.stringify(lines) === JSON.stringify(EXPECTED_NPMRC) && text.endsWith("\n");
  return ok ? [] : [{ code: "L-NPMRC", detail: ".npmrc is not exactly the required key set" }];
}

function hasKeyDeep(v, key) {
  if (Array.isArray(v)) return v.some((x) => hasKeyDeep(x, key));
  if (isObj(v))
    return Object.keys(v).includes(key) || Object.values(v).some((x) => hasKeyDeep(x, key));
  return false;
}

export function checkBiome(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [{ code: "L-BIOME-EXTENDS", detail: "biome.json is not parseable strict JSON" }];
  }
  return hasKeyDeep(parsed, "extends")
    ? [{ code: "L-BIOME-EXTENDS", detail: "biome.json must not contain extends" }]
    : [];
}

export function checkWorkflow(name, text) {
  const failures = [];
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    const m = /^\s*(?:-\s*)?uses:\s*(\S+)/.exec(line);
    if (m && (!/@[0-9a-f]{40}$/.test(m[1]) || /@0{40}$/.test(m[1]))) {
      failures.push({
        code: "L-USES",
        detail: `${name}:${i + 1}: uses must be pinned to a 40-hex commit SHA`,
      });
    }
    const body = line.replace(/#.*$/, "");
    if (
      /secrets\.|pull_request_target|workflow_run|upload-artifact|download-artifact|actions\/cache|^\s*cache:/.test(
        body,
      )
    ) {
      failures.push({
        code: "L-WORKFLOW-FORBIDDEN",
        detail: `${name}:${i + 1}: forbidden workflow construct`,
      });
    }
  });
  return failures;
}

/** Check every file in `.github/workflows`: `*.yml`/`*.yaml` are checked, anything else fails. */
export function checkWorkflowDir(repoRoot) {
  const failures = [];
  const wfDir = path.join(repoRoot, ".github/workflows");
  for (const ent of readdirSync(wfDir, { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  )) {
    const rel = `.github/workflows/${ent.name}`;
    if (ent.isFile() && /\.ya?ml$/.test(ent.name)) {
      failures.push(...checkWorkflow(rel, readFileSync(path.join(repoRoot, rel), "utf8")));
    } else {
      failures.push({
        code: "L-WORKFLOW-FILE",
        detail: `${esc(rel)}: only regular *.yml / *.yaml files are allowed in .github/workflows`,
      });
    }
  }
  return failures;
}

export function runAll(repoRoot) {
  const read = (p) => readFileSync(path.join(repoRoot, p), "utf8");
  const json = (p) => JSON.parse(read(p));
  const lock = json("package-lock.json");
  const failures = [
    ...checkLockfile(lock, json("tools/expected-lock-closure.json")),
    ...checkManifests({
      root: json("package.json"),
      core: json("packages/core/package.json"),
      cli: json("packages/cli/package.json"),
      packages: Object.fromEntries(
        WORKSPACES.filter((w) => w !== "core" && w !== "cli" && w !== "contract-tests").map((w) => [
          w,
          json(`packages/${w}/package.json`),
        ]),
      ),
      contractTests: json("packages/contract-tests/package.json"),
    }),
    ...checkNpmrc(read(".npmrc")),
    ...checkBiome(read("biome.json")),
  ];
  failures.push(...checkWorkflowDir(repoRoot));
  return { failures, installScripts: installScriptEntries(lock) };
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const { failures, installScripts } = runAll(repoRoot);
  process.stdout.write(
    `lockfile-check: entries with hasInstallScript: ${installScripts.length === 0 ? "none" : installScripts.map(esc).join(", ")}\n`,
  );
  for (const f of failures) process.stdout.write(`${f.code}: ${esc(f.detail)}\n`);
  if (failures.length > 0) process.exitCode = 1;
  else process.stdout.write("lockfile-check: ok\n");
}
