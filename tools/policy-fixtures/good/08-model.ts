// as: packages/model/src/ids.ts
import { createHash } from "node:crypto";
import { AtmError } from "@swain/core";

export const id = (s: string): string => createHash("sha256").update(s).digest("hex");
export const err = AtmError;
