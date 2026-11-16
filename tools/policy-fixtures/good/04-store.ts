// as: packages/store/src/store.ts
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { maskHome } from "@swain/core";
import type { ImportRecord } from "@swain/report";
import { helper } from "./helper.js";

export type { ImportRecord } from "@swain/report";
export type R = import("@swain/report").ImportRecord;
export const used = [
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeSync,
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
  createHash,
  maskHome,
  helper,
];
export type X = ImportRecord;
