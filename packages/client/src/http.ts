/**
 * One HTTP exchange with a Swain server on a literal loopback IP: a single attempt, a 2 s socket
 * timeout, no redirect following, a response cap, no cookies. `node:http` `request` is the only
 * network primitive the client may use (tools/policy-check.mjs).
 */
import { Agent, request } from "node:http";
import { parseOrigin } from "./credentials.js";
import { ClientError } from "./errors.js";

export const REQUEST_TIMEOUT_MS = 2000;
const MAX_RESPONSE_BYTES = 1_048_576;

export interface HttpResult {
  readonly status: number;
  readonly body: Uint8Array;
}

export interface HttpOptions {
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: Uint8Array;
  readonly timeoutMs?: number;
  /** Run this exchange on the channel's one connection (proof and key share it, G3-auth F3). */
  readonly channel?: Channel;
}

type Connect = (options: unknown, callback?: unknown) => unknown;

/**
 * One TCP connection for a proof-then-key sequence. The agent allows `maxSockets: 1` with
 * keep-alive and refuses to create a second socket, so the request that carries the key can only
 * go out on the very socket the server proved itself on. If that socket was closed in between,
 * the key request fails before any byte is written and the key is never sent elsewhere.
 */
export class Channel {
  readonly agent: Agent;
  /** The local port of the socket every exchange on this channel used; null before the first. */
  localPort: number | null = null;
  constructor() {
    const agent = new Agent({
      keepAlive: true,
      maxSockets: 1,
      maxTotalSockets: 1,
      maxFreeSockets: 1,
    });
    const slot = agent as unknown as { createConnection: Connect };
    const original = slot.createConnection.bind(agent);
    let made = 0;
    slot.createConnection = (options, callback) => {
      made++;
      if (made > 1) {
        // fail the queued request through the agent's own callback: it emits `error` on the
        // request before a single byte is written (a throw here would escape as uncaught)
        if (typeof callback === "function")
          callback(new Error("channel: second connection refused"));
        return undefined;
      }
      return original(options, callback);
    };
    this.agent = agent;
  }
  close(): void {
    this.agent.destroy();
  }
}

/** Network failures and oversize answers are `server-unreachable`; the caller judges the status. */
export function httpExchange(
  origin: string,
  method: "GET" | "POST",
  path: string,
  o: HttpOptions = {},
): Promise<HttpResult> {
  const target = parseOrigin(origin);
  if (!path.startsWith("/") || path.startsWith("//")) throw new ClientError("io");
  return new Promise<HttpResult>((resolve, reject) => {
    let settled = false;
    const done = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      fn();
    };
    const headers: Record<string, string> = {
      Host: target.host === "::1" ? `[::1]:${target.port}` : `127.0.0.1:${target.port}`,
      Accept: "application/json",
      ...o.headers,
    };
    if (o.body !== undefined) headers["Content-Length"] = String(o.body.length);
    let req: ReturnType<typeof request>;
    try {
      req = request(
        {
          agent: o.channel === undefined ? false : o.channel.agent,
          host: target.host,
          port: target.port,
          method,
          path,
          headers,
          timeout: o.timeoutMs ?? REQUEST_TIMEOUT_MS,
          setHost: false,
        },
        (res) => {
          const ch = o.channel;
          if (ch !== undefined) {
            const lp = res.socket.localPort ?? null;
            if (ch.localPort !== null && lp !== ch.localPort) {
              req.destroy();
              done(() => reject(new ClientError("server-unauthenticated")));
              return;
            }
            ch.localPort = lp;
          }
          const chunks: Uint8Array[] = [];
          let total = 0;
          res.on("data", (c: Uint8Array) => {
            total += c.length;
            if (total > MAX_RESPONSE_BYTES) {
              req.destroy();
              done(() => reject(new ClientError("server-unreachable")));
              return;
            }
            chunks.push(c);
          });
          res.on("end", () => {
            const body = new Uint8Array(total);
            let off = 0;
            for (const c of chunks) {
              body.set(c, off);
              off += c.length;
            }
            done(() => resolve({ status: res.statusCode ?? 0, body }));
          });
          res.on("error", () => done(() => reject(new ClientError("server-unreachable"))));
        },
      );
    } catch {
      done(() => reject(new ClientError("server-unreachable")));
      return;
    }
    req.on("timeout", () => {
      req.destroy();
      done(() => reject(new ClientError("server-unreachable")));
    });
    req.on("error", () => done(() => reject(new ClientError("server-unreachable"))));
    req.end(o.body);
  });
}

/** Parse a JSON response body, or `undefined` when it is not valid UTF-8 JSON. */
export function parseJsonBody(body: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    return undefined;
  }
}
