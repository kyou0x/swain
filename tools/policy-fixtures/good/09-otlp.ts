// as: packages/otlp/src/decode.ts
import { escapeControlChars } from "@swain/core";
import { deriveSwainId } from "@swain/model";
import { helper } from "./helper.js";

export const decode = (s: string): string => deriveSwainId("run", [escapeControlChars(s)]) + helper;
