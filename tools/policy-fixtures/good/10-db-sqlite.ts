// as: packages/db/src/sqlite/open.ts
import { createHash } from "node:crypto";
import { chmodSync, constants, lstatSync, mkdirSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { maskHome } from "@swain/core";
import { deriveSwainId } from "@swain/model";
import type { ImportRecord } from "@swain/report";

export type R = ImportRecord;
export const open = (p: string): DatabaseSync =>
  new DatabaseSync(p, { allowExtension: false, enableForeignKeyConstraints: true });
export const used = [
  chmodSync,
  constants,
  lstatSync,
  mkdirSync,
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
  createHash,
  maskHome,
  deriveSwainId,
];
