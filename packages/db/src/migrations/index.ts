/** The migration registry, in order (SPEC-003 section 2.1). Forward only; versions are 1..n without gaps. */
import { migration0001 } from "./0001-initial.js";

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

export const MIGRATIONS: readonly Migration[] = [migration0001];
