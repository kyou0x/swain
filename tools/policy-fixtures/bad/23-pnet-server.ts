// as: packages/server/src/x.ts
import { createServer } from "node:http";
import { request } from "node:http"; // expect: P-IMPORT P-NET
import { get } from "node:http"; // expect: P-IMPORT P-NET
import { createServer as cs } from "node:https"; // expect: P-IMPORT P-NET
import * as http from "node:http"; // expect: P-IMPORT P-NET
import h from "node:http"; // expect: P-IMPORT P-NET
import { connect } from "node:net"; // expect: P-IMPORT P-NET
import { Worker } from "node:worker_threads"; // expect: P-IMPORT P-NET
import { spawn } from "node:child_process"; // expect: P-IMPORT P-NET
export { createServer, request, get, cs, http, h, connect, Worker, spawn };
