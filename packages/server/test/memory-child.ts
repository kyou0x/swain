/**
 * Server child for the memory precondition test (`memory.test.ts`). It runs ONLY the server and
 * the store, so its peak RSS (`process.resourceUsage().maxRSS`) is the server's own: the load
 * generator and its bodies live in the parent. Protocol: prints one JSON line with the port and
 * the key secret, then waits for a line on stdin and prints a final JSON line with the numbers.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteSwainStore } from "@swain/db";
import { createSwainServer } from "../src/index.js";

const NOW_ISO = "2026-01-01T00:00:00.000Z";
const MIB = 1024 * 1024;
const dir = mkdtempSync(join(tmpdir(), "swain-mem-"));
const store = SqliteSwainStore.open(join(dir, "swain.sqlite"), {
  sessionMode: "local",
  uid: (process.getuid as () => number)(),
  nowMs: () => Date.now(),
});
store.migrate({ nowIso: () => NOW_ISO });
const { org, project } = store.ensureLocalTenancy(NOW_ISO);
const key = store.createKey(
  { orgId: org.orgId, projectId: project.projectId },
  {
    label: "mem",
    scopes: ["ingest:otlp"],
    agentName: "planner",
    createdBy: "test",
    createdAt: NOW_ISO,
  },
);
const srv = await createSwainServer({
  store,
  nowMs: () => Date.now(),
  port: 0,
  host: "127.0.0.1",
  limits: { keyBurst: 1000, keyBytesPerMinute: 4096 * MIB },
});
const baseline = process.resourceUsage().maxRSS;
process.stdout.write(`${JSON.stringify({ port: srv.port, secret: key.secret, baseline })}\n`);

process.stdin.once("data", async () => {
  const peak = process.resourceUsage().maxRSS;
  const counters = srv.counters();
  await srv.close();
  store.close();
  rmSync(dir, { recursive: true, force: true });
  process.stdout.write(`${JSON.stringify({ baseline, peak, counters })}\n`);
  process.exit(0);
});
