import type { AdapterRegistration } from "@swain/core";
import { chatJsonRegistration } from "./json.js";
import { chatJsonlRegistration } from "./jsonl.js";

export const registrations: readonly AdapterRegistration[] = [
  chatJsonlRegistration,
  chatJsonRegistration,
];
