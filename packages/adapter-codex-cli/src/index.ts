import type { AdapterRegistration } from "@swain/core";
import { execRegistration } from "./exec.js";
import { rolloutRegistration } from "./rollout.js";

export const registrations: readonly AdapterRegistration[] = [
  rolloutRegistration,
  execRegistration,
];
