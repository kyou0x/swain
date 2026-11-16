// as: packages/sdk-ts/src/export/flush.ts
import { randomBytes } from "node:crypto";
import { request } from "node:http";
import { request as secureRequest } from "node:https";
import { clearTimeout, setTimeout } from "node:timers";

export function schedule(f: () => void): () => void {
  const t = setTimeout(f, 1000);
  return () => clearTimeout(t);
}
export const used = [randomBytes, request, secureRequest];
