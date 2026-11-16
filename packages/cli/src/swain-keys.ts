/**
 * `swain keys create | list | revoke` (SPEC-003 section 4): direct DB access, the DB-file holder is
 * the owner. Keys are agent-pinned by default. No command accepts a key in argv: a secret reaches
 * the user only through a credential file (`--save`) or, explicitly, `--show-secret`.
 */
import {
  CREDENTIAL_FORMAT,
  type Credential,
  credentialExists,
  credentialPath,
  SLUG_RE,
  saveCredential,
} from "@swain/client";
import {
  KEY_SCOPES,
  type KeyScope,
  type OrgId,
  type ProjectScope,
  type SwainStore,
} from "@swain/db";
import { locateServer, openLocalStore, requestedOrigin } from "./swain-store.js";
import {
  configBaseOf,
  flagList,
  flagOn,
  flagStr,
  isoOf,
  type Out,
  parseFlags,
  SWAIN_EXIT,
  type SwainIo,
  shown,
} from "./swain-support.js";
import { clip, table } from "./text.js";

const CREATE_FLAGS = {
  "--project": "value",
  "--label": "value",
  "--agent": "value",
  "--no-pin": "bool",
  "--integration": "value",
  "--scope": "multi",
  "--save": "bool",
  "--show-secret": "bool",
  "--server": "value",
  "--db": "value",
} as const;
const LIST_FLAGS = { "--project": "value", "--db": "value" } as const;
const REVOKE_FLAGS = { "--db": "value" } as const;
const KEY_ID = /^key_[0-9a-f]{16}$/;
const NAME_MAX = 128;

function plainName(v: string, max: number): boolean {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the purpose
  return v.length >= 1 && v.length <= max && !/[\u0000-\u001f\u007f-\u009f]/.test(v);
}

function audit(
  store: SwainStore,
  orgId: OrgId,
  at: string,
  action: "key.create" | "key.revoke",
  keyId: string,
  detail: Readonly<Record<string, string | number | boolean | null>>,
): void {
  store.appendAudit(orgId, {
    at,
    actorType: "cli",
    actorId: "local-owner",
    action,
    targetType: "key",
    targetId: keyId,
    detail,
  });
}

export function runKeys(io: SwainIo, args: readonly string[], o: Out): number {
  const [sub, ...rest] = args;
  switch (sub) {
    case "create":
      return keysCreate(io, rest, o);
    case "list":
      return keysList(io, rest, o);
    case "revoke":
      return keysRevoke(io, rest, o);
    default:
      o.err("swain: usage: swain keys create|list|revoke ...\n");
      return SWAIN_EXIT.usage;
  }
}

function keysCreate(io: SwainIo, args: readonly string[], o: Out): number {
  const a = parseFlags(args, CREATE_FLAGS);
  if ("error" in a) {
    o.err(a.error);
    return SWAIN_EXIT.usage;
  }
  if (a.positionals.length > 0) {
    o.err("swain: keys create takes no positional arguments\n");
    return SWAIN_EXIT.usage;
  }
  const slug = flagStr(a, "--project") ?? "default";
  if (!SLUG_RE.test(slug)) {
    o.err(
      "swain: --project must be a slug: lowercase letters, digits and '-', at most 63 characters\n",
    );
    return SWAIN_EXIT.usage;
  }
  const save = flagOn(a, "--save");
  const showSecret = flagOn(a, "--show-secret");
  if (!save && !showSecret) {
    o.err(
      "swain: choose --save (write the credential file, print only its path) or --show-secret (print the secret once)\n",
    );
    return SWAIN_EXIT.usage;
  }
  const label = flagStr(a, "--label") ?? slug;
  const integration = flagStr(a, "--integration");
  const agentFlag = flagStr(a, "--agent");
  if (flagOn(a, "--no-pin") && agentFlag !== undefined) {
    o.err("swain: --agent and --no-pin cannot be combined\n");
    return SWAIN_EXIT.usage;
  }
  for (const [name, v] of [
    ["--label", label],
    ["--agent", agentFlag],
    ["--integration", integration],
  ] as const) {
    if (v !== undefined && !plainName(v, NAME_MAX)) {
      o.err(`swain: ${name} must be 1 to ${NAME_MAX} printable characters\n`);
      return SWAIN_EXIT.usage;
    }
  }
  // Pinned by default (G0 F6): the agent is the integration name, else the label.
  const agentName = flagOn(a, "--no-pin") ? null : (agentFlag ?? integration ?? label);
  const scopeArgs = flagList(a, "--scope");
  const scopes: KeyScope[] = [];
  for (const s of scopeArgs.length === 0 ? ["ingest:otlp"] : scopeArgs) {
    const known = KEY_SCOPES.find((k) => k === s);
    if (known === undefined || scopes.includes(known)) {
      o.err(`swain: --scope must be one of ${KEY_SCOPES.join(", ")} (each at most once)\n`);
      return SWAIN_EXIT.usage;
    }
    scopes.push(known);
  }
  const configBase = configBaseOf(io.env);
  if (configBase === null) {
    o.err("swain: no config location: set HOME or XDG_CONFIG_HOME\n");
    return SWAIN_EXIT.usage;
  }
  const requested = requestedOrigin(flagStr(a, "--server"), io.env);

  const opened = openLocalStore(io, flagStr(a, "--db"));
  try {
    const { store, org, workspace, uid } = opened;
    const located = locateServer(io, requested, uid);
    if (save && credentialExists(configBase, slug)) {
      o.err(
        `swain: a credential file already exists at ${shown(credentialPath(configBase, slug), io.env)}; remove it first or use another --project\n`,
      );
      return SWAIN_EXIT.outputRefused;
    }
    const nowIso = isoOf(io.nowMs());
    let project = store.listProjects({ orgId: org.orgId }).projects.find((p) => p.slug === slug);
    if (project === undefined) {
      project = store.createProject(
        { orgId: org.orgId },
        { workspaceId: workspace.workspaceId, slug, name: slug, createdAt: nowIso },
      );
      o.out(`swain: created project '${slug}'\n`);
    }
    const scope: ProjectScope = { orgId: org.orgId, projectId: project.projectId };
    const made = store.createKey(scope, {
      label,
      scopes,
      agentName,
      integration: integration ?? null,
      createdBy: "cli:local-owner",
      createdAt: nowIso,
    });
    audit(store, org.orgId, nowIso, "key.create", made.key.keyId, {
      project: slug,
      scopes: scopes.join(","),
      pinned: agentName !== null,
    });
    let path: string | null = null;
    if (save) {
      const cred: Credential = {
        format: CREDENTIAL_FORMAT,
        origin: located.origin,
        keyId: made.key.keyId,
        secret: made.secret,
        serverProofKey: made.serverProofKey,
        projectSlug: slug,
        ...(agentName === null ? {} : { agentName }),
        createdAt: nowIso,
      };
      try {
        path = saveCredential(configBase, cred, uid);
      } catch (e) {
        // The secret could not be kept: revoke the key so no orphan credential stays valid.
        store.revokeKey(scope, made.key.keyId, io.nowMs());
        audit(store, org.orgId, nowIso, "key.revoke", made.key.keyId, { reason: "save-failed" });
        throw e;
      }
    }
    o.out(`swain: created key ${made.key.keyId} for project '${slug}'\n`);
    o.out(
      `  agent:   ${agentName === null ? "not pinned (--no-pin)" : `pinned to ${clip(agentName, 128)}`}\n`,
    );
    o.out(`  scopes:  ${scopes.join(", ")}\n`);
    o.out(`  origin:  ${located.origin}\n`);
    if (path !== null) {
      o.out(`  credential file: ${shown(path, io.env)} (mode 0600, bound to this origin)\n`);
      o.out("  the secret is not printed; the file holds it\n");
    }
    if (showSecret) {
      o.out(`  secret:  ${made.secret}\n`);
      o.out(
        "  this is the only time the secret is shown; anyone who reads it can send data as this key\n",
      );
    } else {
      o.out("  secret:  <SWAIN_KEY> (not shown; use --show-secret to print it once)\n");
    }
    return SWAIN_EXIT.ok;
  } finally {
    opened.store.close();
  }
}

function keysList(io: SwainIo, args: readonly string[], o: Out): number {
  const a = parseFlags(args, LIST_FLAGS);
  if ("error" in a) {
    o.err(a.error);
    return SWAIN_EXIT.usage;
  }
  if (a.positionals.length > 0) {
    o.err("swain: keys list takes no positional arguments\n");
    return SWAIN_EXIT.usage;
  }
  const only = flagStr(a, "--project");
  if (only !== undefined && !SLUG_RE.test(only)) {
    o.err("swain: --project must be a slug\n");
    return SWAIN_EXIT.usage;
  }
  const opened = openLocalStore(io, flagStr(a, "--db"));
  try {
    const { store, org } = opened;
    const now = io.nowMs();
    const rows: string[][] = [];
    for (const p of store.listProjects({ orgId: org.orgId }).projects) {
      if (only !== undefined && p.slug !== only) continue;
      for (const k of store.listKeys({ orgId: org.orgId, projectId: p.projectId }).keys) {
        const state =
          k.revokedAtMs !== null
            ? "revoked"
            : k.expiresAtMs !== null && k.expiresAtMs <= now
              ? "expired"
              : "active";
        rows.push([
          k.keyId,
          clip(p.slug, 63),
          clip(k.label, 40),
          k.agentName === null ? "(not pinned)" : clip(k.agentName, 40),
          k.scopes.join(","),
          state,
          clip(k.createdAt, 24),
        ]);
      }
    }
    if (rows.length === 0) o.out("no keys\n");
    else {
      o.out(table(["KEY", "PROJECT", "LABEL", "AGENT", "SCOPES", "STATE", "CREATED"], rows));
    }
    return SWAIN_EXIT.ok;
  } finally {
    opened.store.close();
  }
}

function keysRevoke(io: SwainIo, args: readonly string[], o: Out): number {
  const a = parseFlags(args, REVOKE_FLAGS);
  if ("error" in a) {
    o.err(a.error);
    return SWAIN_EXIT.usage;
  }
  const id = a.positionals[0];
  if (a.positionals.length !== 1 || id === undefined || !KEY_ID.test(id)) {
    o.err("swain: usage: swain keys revoke key_<16 hex>\n");
    return SWAIN_EXIT.usage;
  }
  const opened = openLocalStore(io, flagStr(a, "--db"));
  try {
    const { store, org } = opened;
    const found = store.findKey(id);
    if (found === null || found.orgId !== org.orgId) {
      o.err("swain: no such key\n");
      return SWAIN_EXIT.notFound;
    }
    const nowMs = io.nowMs();
    const changed = store.revokeKey({ orgId: found.orgId, projectId: found.projectId }, id, nowMs);
    if (changed) audit(store, org.orgId, isoOf(nowMs), "key.revoke", id, { reason: "cli" });
    o.out(changed ? `swain: revoked ${id}\n` : `swain: ${id} was already revoked\n`);
    return SWAIN_EXIT.ok;
  } finally {
    opened.store.close();
  }
}
