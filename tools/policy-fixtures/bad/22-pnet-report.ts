// as: packages/report/src/x.ts
import { request } from "node:http"; // expect: P-IMPORT P-NET
import { request as r2 } from "node:https"; // expect: P-IMPORT P-NET
import { connect } from "node:net"; // expect: P-IMPORT P-NET
import { connect as c2 } from "node:tls"; // expect: P-IMPORT P-NET
import { createSocket } from "node:dgram"; // expect: P-IMPORT P-NET
import { connect as c3 } from "node:http2"; // expect: P-IMPORT P-NET
import { spawn } from "node:child_process"; // expect: P-IMPORT P-NET
import { Worker } from "node:worker_threads"; // expect: P-IMPORT P-NET
import bare from "http"; // expect: P-IMPORT P-NET
import cp = require("child_process"); // expect: P-IMPORT P-NET
import "node:net"; // expect: P-IMPORT P-NET
export * from "node:http"; // expect: P-IMPORT P-NET
export { request, r2, connect, c2, createSocket, c3, spawn, Worker, bare, cp };
