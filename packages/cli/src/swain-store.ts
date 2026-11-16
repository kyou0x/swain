/**
 * Opening the local database and finding the server origin for the `swain` commands that use direct
 * DB access (`serve`, `keys`, `open`). The open sequence itself (0700 directory, pre-created 0600
 * file, permission checks before any PRAGMA) is `@swain/db`'s; the directory is created and checked
 * here through `@swain/client` first.
 */
import {
  ClientError,
  currentUid,
  ensurePrivateDir,
  parseOrigin,
  type RuntimeInfo,
  readRuntimeFiles,
} from "@swain/client";
import { type Org, type Project, SqliteSwainStore, type Workspace } from "@swain/db";
import {
  dataBaseOf,
  dbPathOf,
  dirOf,
  homeOf,
  isoOf,
  type SwainEnv,
  type SwainIo,
  stateBaseOf,
} from "./swain-support.js";

export interface OpenedStore {
  readonly store: SqliteSwainStore;
  readonly dbPath: string;
  readonly uid: number;
  readonly org: Org;
  readonly workspace: Workspace;
  readonly project: Project;
}

/** Open or create the database, migrate it and ensure the local tenancy. */
export function openLocalStore(io: SwainIo, dbFlag: string | undefined): OpenedStore {
  const dbPath = dbPathOf(dbFlag, io.env);
  if (dbPath === null) throw new ClientError("io");
  const dir = dirOf(dbPath);
  // The default location lives under HOME or the XDG data base and is held to 0700. A path the user
  // chose with --db / SWAIN_DB must already exist (the uid probe runs only inside it) and is held
  // to the weaker "not group/world writable" rule, because it may be a shared directory.
  const custom = dbFlag !== undefined || io.env.SWAIN_DB !== undefined;
  const uid = custom ? currentUid(dir, [dir]) : uidIn(io.env, dir, dataBaseOf(io.env));
  ensurePrivateDir(dir, uid, !custom);
  const store = SqliteSwainStore.open(dbPath, {
    uid,
    nowMs: io.nowMs,
    sessionMode: "local",
  });
  try {
    const nowIso = isoOf(io.nowMs());
    store.migrate({ nowIso: () => nowIso });
    const t = store.ensureLocalTenancy(nowIso);
    return { store, dbPath, uid, org: t.org, workspace: t.workspace, project: t.project };
  } catch (e) {
    store.close();
    throw e;
  }
}

/** The effective uid, learned with a probe file created only inside HOME or the validated base. */
export function uidIn(env: SwainEnv, target: string, base: string | null): number {
  const roots: string[] = [];
  const home = homeOf(env);
  if (home !== null) roots.push(home);
  if (base?.startsWith("/")) roots.push(base);
  return currentUid(target, roots);
}

/** `--server`, else `SWAIN_SERVER_URL`: the origin the user named, validated; `null` when none. */
export function requestedOrigin(flag: string | undefined, env: SwainEnv): string | null {
  const v = flag ?? env.SWAIN_SERVER_URL;
  return v === undefined ? null : parseOrigin(v).origin;
}

export const DEFAULT_ORIGIN = "http://127.0.0.1:4318";

export interface Located {
  readonly origin: string;
  /** The `instanceId` of the runtime file for this origin, when one exists. */
  readonly pin: string | null;
}

/**
 * Where the server is: the requested origin, else the one runtime file in the state directory, else
 * the default port. Several runtime files without a request is ambiguous (usage error).
 */
export function locateServer(io: SwainIo, requested: string | null, uid: number): Located {
  return findServer(io, requested, uid) ?? { origin: DEFAULT_ORIGIN, pin: null };
}

/** Like `locateServer` but without the default-port guess: `null` when nothing names a server. */
export function findServer(io: SwainIo, requested: string | null, uid: number): Located | null {
  const stateBase = stateBaseOf(io.env);
  const files: readonly RuntimeInfo[] = stateBase === null ? [] : readRuntimeFiles(stateBase, uid);
  if (requested !== null) {
    return {
      origin: requested,
      pin: files.find((f) => f.origin === requested)?.instanceId ?? null,
    };
  }
  if (files.length > 1) throw new ClientError("invalid-origin");
  const only = files[0];
  return only === undefined ? null : { origin: only.origin, pin: only.instanceId };
}
