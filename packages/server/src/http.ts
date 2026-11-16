/**
 * Small HTTP helpers: header access, the Host allowlist and the body reader with a running cap.
 *
 * The package may import only `createServer` from `node:http` (tools/policy-check.mjs), so the
 * request and response types are derived from it instead of imported by name.
 */
import type { createServer } from "node:http";

export type HttpServer = ReturnType<typeof createServer>;
type Listener = NonNullable<Parameters<typeof createServer>[1]>;
export type Req = Parameters<Listener>[0];
export type Res = Parameters<Listener>[1];

/** How many header fields named `name` the request carried (`rawHeaders`, ASCII case-insensitive). */
export function countHeader(req: Req, name: string): number {
  let n = 0;
  const raw = req.rawHeaders;
  for (let i = 0; i < raw.length; i += 2) {
    if (raw[i]?.toLowerCase() === name) n++;
  }
  return n;
}

/**
 * Exact, case-insensitive Host match against the literal allowlist (ADR-0007 section 1). A missing
 * or duplicated Host, a trailing dot, a missing port or any other spelling does not match.
 */
export function hostAllowed(req: Req, port: number, bound: ReadonlySet<string>): boolean {
  if (countHeader(req, "host") !== 1) return false;
  const h = req.headers.host;
  if (typeof h !== "string") return false;
  const v = h.toLowerCase();
  // Only the families this server really listens on: a squatter on the other family must not be
  // able to relay requests that this server would accept (G3-auth B1).
  if (v === `127.0.0.1:${port}`) return bound.has("127.0.0.1");
  if (v === `[::1]:${port}`) return bound.has("::1");
  return v === `localhost:${port}` && bound.size > 0;
}

/**
 * The literal-IP origin of the socket that accepted this request (`localAddress` and `localPort`),
 * never the Host header. `null` for anything that is not one of the two loopback literals.
 */
export function socketOrigin(req: Req): string | null {
  const a = req.socket.localAddress;
  const p = req.socket.localPort;
  if (p === undefined || !Number.isInteger(p) || p < 1 || p > 65_535) return null;
  if (a === "127.0.0.1") return `http://127.0.0.1:${p}`;
  if (a === "::1") return `http://[::1]:${p}`;
  return null;
}

/** Path and query of a request target that starts with `/`. */
export function splitTarget(url: string): { path: string; query: string } {
  const q = url.indexOf("?");
  return q < 0 ? { path: url, query: "" } : { path: url.slice(0, q), query: url.slice(q + 1) };
}

/** True when the query string has a parameter named `key` (decoded). */
export function queryHasKey(query: string): boolean {
  if (query === "") return false;
  try {
    return new URLSearchParams(query).has("key");
  } catch {
    return true;
  }
}

export type BodyResult =
  | { readonly kind: "ok"; readonly body: Uint8Array }
  | { readonly kind: "too-large" }
  | { readonly kind: "aborted" };

/** Strict `Content-Length`: digits only, a safe integer. `null` when absent, `NaN` when malformed. */
export function declaredLength(req: Req): number | null {
  const v = req.headers["content-length"];
  if (v === undefined) return null;
  return /^[0-9]{1,15}$/.test(v) ? Number(v) : Number.NaN;
}

/**
 * Read the request body with a running byte counter. A declared length over `cap` is refused
 * before a single byte is read; otherwise reading stops the moment the counter passes `cap`, and
 * nothing larger than `cap` is ever buffered. The caller destroys the connection on `too-large`.
 * `onBytes` sees every chunk size (for the server's own accounting).
 */
export function readBody(req: Req, cap: number, onBytes: (n: number) => void): Promise<BodyResult> {
  const declared = declaredLength(req);
  if (declared !== null && (Number.isNaN(declared) || declared > cap)) {
    return Promise.resolve({ kind: "too-large" });
  }
  return new Promise<BodyResult>((resolve) => {
    const chunks: Uint8Array[] = [];
    let total = 0;
    let done = false;
    const finish = (r: BodyResult): void => {
      if (done) return;
      done = true;
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onAbort);
      req.off("close", onAbort);
      req.off("aborted", onAbort);
      if (r.kind !== "ok") req.pause();
      resolve(r);
    };
    const onData = (chunk: Uint8Array): void => {
      total += chunk.length;
      onBytes(chunk.length);
      if (total > cap) {
        finish({ kind: "too-large" });
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = (): void => {
      const out = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) {
        out.set(c, off);
        off += c.length;
      }
      finish({ kind: "ok", body: out });
    };
    const onAbort = (): void => finish({ kind: "aborted" });
    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onAbort);
    req.on("close", onAbort);
    req.on("aborted", onAbort);
  });
}
