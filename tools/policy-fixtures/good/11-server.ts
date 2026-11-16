// as: packages/server/src/http.ts
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { constants, gunzipSync } from "node:zlib";
import { escapeControlChars } from "@swain/core";
import type { SwainStore } from "@swain/db";
import { deriveSwainId } from "@swain/model";
import { decodeTraces } from "@swain/otlp";
import { renderRunPage } from "@swain/report";
import { buildImportRecord, type PutMeta } from "@swain/store";

export type S = SwainStore;
export type M = PutMeta;
export const used = [
  createHash,
  randomBytes,
  timingSafeEqual,
  createServer,
  constants,
  gunzipSync,
  escapeControlChars,
  deriveSwainId,
  decodeTraces,
  renderRunPage,
  buildImportRecord,
];
