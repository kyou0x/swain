/**
 * The runtime file of a running server (ADR-0006 section 8, step 1):
 * `$XDG_STATE_HOME/swain/server-<port>.json`, directory 0700, file `wx | O_NOFOLLOW` 0600, holding
 * `{ origin, instanceId }`. It is removed on clean shutdown; a stale file is detected by the
 * server-proof challenge failing. (The process ID of the spec is not recorded: the `swain` bin may
 * not read it.)
 */
import { join } from "node:path";
import { parseOrigin } from "./credentials.js";
import { ClientError } from "./errors.js";
import {
  ensurePrivateDir,
  listDir,
  readPrivateFile,
  removeFile,
  writeNewPrivateFile,
} from "./fs.js";

export interface RuntimeInfo {
  readonly origin: string;
  readonly instanceId: string;
}

const NAME_RE = /^server-([0-9]{1,5})\.json$/;
const MAX_RUNTIME_BYTES = 1024;

export function runtimeDir(stateBase: string): string {
  return join(stateBase, "swain");
}

function runtimePath(stateBase: string, port: number): string {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new ClientError("io");
  return join(runtimeDir(stateBase), `server-${port}.json`);
}

function parseRuntime(text: string): RuntimeInfo | null {
  try {
    const v: unknown = JSON.parse(text);
    if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
    const o = v as Record<string, unknown>;
    if (Object.keys(o).sort().join(",") !== "instanceId,origin") return null;
    const instanceId = o["instanceId"];
    if (typeof instanceId !== "string" || !/^[0-9a-f]{32}$/.test(instanceId)) return null;
    return { origin: parseOrigin(o["origin"]).origin, instanceId };
  } catch {
    return null;
  }
}

/**
 * Write the runtime file. A file left by a crashed server on the same port is replaced: the port is
 * ours now, so the old file cannot describe a live server.
 */
export function writeRuntimeFile(stateBase: string, info: RuntimeInfo, uid: number): void {
  const { port } = parseOrigin(info.origin);
  ensurePrivateDir(runtimeDir(stateBase), uid);
  const path = runtimePath(stateBase, port);
  const bytes = new TextEncoder().encode(
    `${JSON.stringify({ origin: info.origin, instanceId: info.instanceId })}\n`,
  );
  try {
    writeNewPrivateFile(path, bytes);
  } catch (e) {
    if (!(e instanceof ClientError) || e.code !== "credential-exists") throw e;
    removeFile(path);
    writeNewPrivateFile(path, bytes);
  }
}

export function removeRuntimeFile(stateBase: string, port: number): void {
  removeFile(runtimePath(stateBase, port));
}

/** Every well-formed runtime file in the state directory, sorted by file name. */
export function readRuntimeFiles(stateBase: string, uid: number): readonly RuntimeInfo[] {
  const dir = runtimeDir(stateBase);
  const out: RuntimeInfo[] = [];
  for (const name of listDir(dir)) {
    const m = NAME_RE.exec(name);
    if (m === null) continue;
    let bytes: Uint8Array | null;
    try {
      bytes = readPrivateFile(join(dir, name), uid, MAX_RUNTIME_BYTES);
    } catch {
      continue;
    }
    if (bytes === null) continue;
    const info = parseRuntime(new TextDecoder().decode(bytes));
    if (info !== null && parseOrigin(info.origin).port === Number(m[1])) out.push(info);
  }
  return out;
}
