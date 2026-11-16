// as: packages/core/src/ingest/fs/read.ts
import { openSync, writeSync } from "node:fs"; // expect: P-IMPORT
import { readFileSync } from "node:fs"; // expect: P-IMPORT
import fs from "node:fs"; // expect: P-IMPORT
import * as fsAll from "node:fs"; // expect: P-IMPORT
import * as p from "node:path"; // expect: P-IMPORT
import pathDefault from "node:path"; // expect: P-IMPORT
import { posix } from "node:path"; // expect: P-IMPORT
import { zstdCompressSync } from "node:zlib"; // expect: P-IMPORT
import { gunzipSync } from "node:zlib"; // expect: P-IMPORT
import { readdir } from "node:fs/promises"; // expect: P-IMPORT
import { randomUUID } from "node:crypto"; // expect: P-RANDOM
import { createHash as h, createHmac } from "node:crypto"; // expect: P-RANDOM
import cryptoDefault from "node:crypto"; // expect: P-IMPORT
import "node:fs"; // expect: P-IMPORT
import { spawn } from "node:child_process"; // expect: P-IMPORT
import { Worker } from "node:worker_threads"; // expect: P-IMPORT
import { runInNewContext } from "node:vm"; // expect: P-IMPORT
import { request } from "node:http"; // expect: P-IMPORT
import { readFileSync as r2 } from "fs"; // expect: P-IMPORT
export * from "node:fs"; // expect: P-IMPORT
export { openSync as o } from "node:fs"; // expect: P-IMPORT
export * from "node:path"; // expect: P-IMPORT
import fsEq = require("node:fs"); // expect: P-IMPORT
export type V = import("node:fs").Stats; // expect: P-IMPORT
import { x } from "@swain/report"; // expect: P-IMPORT
export { fs, fsAll, p, pathDefault, posix, h, createHmac, cryptoDefault, r2, fsEq };
export { writeSync, openSync, readFileSync, zstdCompressSync, gunzipSync, readdir, randomUUID };
export { spawn, Worker, runInNewContext, request, x };
