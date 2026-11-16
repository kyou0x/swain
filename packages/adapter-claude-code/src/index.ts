import type { AdapterRegistration } from "@swain/core";
import { streamJsonRegistration } from "./stream-json.js";
import { transcriptRegistration } from "./transcript.js";

export const registrations: readonly AdapterRegistration[] = [
  streamJsonRegistration,
  transcriptRegistration,
];
