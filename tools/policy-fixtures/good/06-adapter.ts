// as: packages/adapter-codex-cli/src/index.ts
import type { AdapterRegistration, DraftEvent } from "@swain/core";
import { canonicalJson } from "@swain/core";
import { local } from "./local.js";

export const registrations: readonly AdapterRegistration[] = [];
export const f = (d: DraftEvent): string => canonicalJson(d) + local;
