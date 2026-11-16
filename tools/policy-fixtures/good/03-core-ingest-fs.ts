// as: packages/core/src/ingest/fs/read.ts
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { constants as zlibConstants, zstdDecompressSync } from "node:zlib";
import type { Bounds } from "../../adapter/contract.js";

export const used = [
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
  zlibConstants,
  zstdDecompressSync,
  createHash,
];
export type B = Bounds;
