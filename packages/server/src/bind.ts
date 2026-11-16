/**
 * Loopback bind (ADR-0007 section 1, SPEC-003 section 3.1).
 *
 * Only the literal addresses `127.0.0.1` and `::1` are accepted, before any socket is opened.
 * After `listen`, `server.address()` is asserted to be exactly the requested literal and port.
 * Without a `host`, both families are bound, so that no other local process can take the other
 * family's port and receive keys from exporters configured with `localhost`.
 */
import { SwainServerError } from "./errors.js";
import type { HttpServer } from "./http.js";

export type LoopbackHost = "127.0.0.1" | "::1";

export function isLoopbackLiteral(v: unknown): v is LoopbackHost {
  return v === "127.0.0.1" || v === "::1";
}

/** The assertion after `listen`: not a pipe, the literal address, and (when requested) the port. */
export function assertBoundAddress(
  addr: ReturnType<HttpServer["address"]>,
  host: LoopbackHost,
  requestedPort: number,
): number {
  if (addr === null || typeof addr === "string")
    throw new SwainServerError("bind-address-mismatch");
  if (addr.address !== host) throw new SwainServerError("bind-address-mismatch");
  if (!Number.isInteger(addr.port) || addr.port < 1)
    throw new SwainServerError("bind-address-mismatch");
  if (requestedPort !== 0 && addr.port !== requestedPort) {
    throw new SwainServerError("bind-address-mismatch");
  }
  return addr.port;
}

type NodeError = { readonly code?: unknown };

/** Listen on one literal; rejects with a static `SwainServerError` for the failure class. */
export function listenOn(server: HttpServer, host: LoopbackHost, port: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onError = (e: unknown): void => {
      server.off("listening", onListening);
      const code = (e as NodeError | null)?.code;
      if (code === "EADDRINUSE") reject(new SwainServerError("port-held", host));
      else if (code === "EADDRNOTAVAIL" || code === "EAFNOSUPPORT") {
        reject(new SwainServerError("address-unavailable", host));
      } else reject(new SwainServerError("bind-failed", host));
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({ host, port, exclusive: true });
  });
}
