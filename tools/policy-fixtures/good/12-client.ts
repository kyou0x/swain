// as: packages/client/src/send.ts
import { createHash, randomBytes, randomInt } from "node:crypto";
import { closeSync, constants, openSync, renameSync, writeSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { join } from "node:path";
import { escapeControlChars } from "@swain/core";
import { deriveSwainId } from "@swain/model";

export const used = [
  createHash,
  randomBytes,
  randomInt,
  closeSync,
  constants,
  openSync,
  renameSync,
  writeSync,
  httpRequest,
  httpsRequest,
  join,
  escapeControlChars,
  deriveSwainId,
];
