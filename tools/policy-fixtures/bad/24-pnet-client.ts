// as: packages/client/src/x.ts
import { request } from "node:http";
import { request as r2 } from "node:https";
import { createServer } from "node:http"; // expect: P-IMPORT P-NET
import { get } from "node:https"; // expect: P-IMPORT P-NET
import { Server } from "node:net"; // expect: P-IMPORT P-NET
import { spawn } from "node:child_process"; // expect: P-IMPORT P-NET
export { request, r2, createServer, get, Server, spawn };
