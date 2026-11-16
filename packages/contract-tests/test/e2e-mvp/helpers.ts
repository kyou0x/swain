import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { registrations as claudeCode } from "@swain/adapter-claude-code";
import { registrations as codexCli } from "@swain/adapter-codex-cli";
import { registrations as geminiCli } from "@swain/adapter-gemini-cli";
import { registrations as opencode } from "@swain/adapter-opencode";
import { runMain } from "@swain/cli";
import { type AdapterRegistration, escapeControlChars } from "@swain/core";

export const REPO = fileURLToPath(new URL("../../../../../", import.meta.url));
export const PROVIDERS = ["claude-code", "codex-cli", "gemini-cli", "opencode"] as const;

/** Same fixed order as `packages/cli/src/registry.ts`. */
export const REGISTRATIONS: readonly AdapterRegistration[] = [
  ...claudeCode,
  ...codexCli,
  ...geminiCli,
  ...opencode,
];

export const CAPABILITY_MATRIX: unknown = JSON.parse(
  readFileSync(join(REPO, "docs/architecture/capability-matrix.json"), "utf8"),
);

/** Fixture files the detectors are expected to refuse, with the expected selection result. */
export const EXPECTED_REFUSED: Readonly<Record<string, "no-match" | "unsupported">> = {
  "gemini-cli/hostile-legacy-messages-wrong-type.json": "no-match",
  "gemini-cli/hostile-legacy-no-messages.json": "no-match",
  "opencode/hostile-content.json": "no-match",
  "opencode/hostile-messages-wrong-type.json": "no-match",
  "codex-cli/rollout-unsupported-history-mode.jsonl": "unsupported",
};

export interface FixtureFile {
  readonly provider: (typeof PROVIDERS)[number];
  readonly name: string;
  readonly rel: string;
  readonly path: string;
  /** Adapter id declared by FIXTURE.json, or null for files that must be refused. */
  readonly adapter: string | null;
}

interface FixtureMeta {
  readonly files: unknown;
}

/** FIXTURE.json lists files either as `{name: {adapter}}` or as `[{name, sourceKind}]`. */
function declaredAdapters(provider: string): Map<string, string> {
  const meta = JSON.parse(
    readFileSync(join(REPO, "fixtures", provider, "synthetic-mvp", "FIXTURE.json"), "utf8"),
  ) as FixtureMeta;
  const out = new Map<string, string>();
  if (Array.isArray(meta.files)) {
    for (const f of meta.files as { name: string; sourceKind: string }[]) {
      out.set(f.name, f.sourceKind);
    }
  } else {
    for (const [name, f] of Object.entries(meta.files as Record<string, { adapter: string }>)) {
      out.set(name, f.adapter);
    }
  }
  return out;
}

export function fixtureFiles(): FixtureFile[] {
  const out: FixtureFile[] = [];
  for (const provider of PROVIDERS) {
    const dir = join(REPO, "fixtures", provider, "synthetic-mvp");
    const declared = declaredAdapters(provider);
    for (const name of readdirSync(dir).sort()) {
      if (name === "FIXTURE.json") continue;
      const rel = `${provider}/${name}`;
      out.push({
        provider,
        name,
        rel,
        path: join(dir, name),
        adapter: Object.hasOwn(EXPECTED_REFUSED, rel) ? null : (declared.get(name) ?? null),
      });
    }
  }
  return out;
}

export interface Sandbox {
  readonly root: string;
  readonly home: string;
  readonly store: string;
  readonly done: () => void;
}

/** A temp dir under `os.tmpdir()` holding a fake HOME and a store path (not yet created). */
export function sandbox(): Sandbox {
  const root = mkdtempSync(join(tmpdir(), "atm-e2e-"));
  const home = join(root, "home");
  mkdirSync(home);
  return {
    root,
    home,
    store: join(root, "store"),
    done: () => rmSync(root, { recursive: true, force: true }),
  };
}

export interface CliRun {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

export function cli(sb: Sandbox, args: readonly string[], nowMs = 1_700_000_000_000): CliRun {
  let out = "";
  let err = "";
  const code = runMain([...args], {
    stdout: {
      write: (s) => {
        out += s;
      },
    },
    stderr: {
      write: (s) => {
        err += s;
      },
    },
    env: { HOME: sb.home, XDG_DATA_HOME: undefined },
    nowMs: () => nowMs,
  });
  return { code, out, err };
}

/** Raw control bytes that could drive a terminal or hide text. LF is allowed. */
export function rawControls(s: string): string[] {
  const found: string[] = [];
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    if (
      (cp <= 0x1f && cp !== 0x0a) ||
      (cp >= 0x7f && cp <= 0x9f) ||
      cp === 0x61c ||
      cp === 0x200e ||
      cp === 0x200f ||
      (cp >= 0x202a && cp <= 0x202e) ||
      (cp >= 0x2066 && cp <= 0x2069) ||
      cp === 0x2028 ||
      cp === 0x2029 ||
      (cp >= 0xe0000 && cp <= 0xe007f) ||
      (cp >= 0xd800 && cp <= 0xdfff)
    ) {
      found.push(escapeControlChars(ch));
    }
  }
  return found;
}

export function listFilesRecursive(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...listFilesRecursive(p));
    else out.push(p);
  }
  return out.sort();
}

export const SECRETS = [
  "AKIAIOSFODNN7EXAMPLE",
  "ghp_0123456789abcdefghijklmnopqrstuvwxyz",
  "BEGIN PRIVATE KEY",
] as const;
