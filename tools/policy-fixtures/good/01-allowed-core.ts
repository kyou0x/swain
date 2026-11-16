// as: packages/core/src/x.ts
import { createHash } from "node:crypto";
import type { Y } from "./y.js";
import { z } from "./sub/z.js";

const t = Date.UTC(2026, 0, 1);
const d = new Date(t);

export class Box {
  constructor(readonly v: number) {}
}

let g: typeof globalThis | undefined;
type Ctor = { constructor: Function };
interface Env {
  process: string;
  global: number;
}
export function h(b: Uint8Array): string {
  return createHash("sha256").update(b).digest("hex") + String(d.getTime()) + String(g);
}
export type { Y, Ctor, Env };
export { z };
