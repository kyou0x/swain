// Demo helper: set a project's content policy ("hash-only" or "inline") in the local Swain database.
//
// There is no `swain` subcommand for this yet. This script uses the @swain/db store API directly and
// writes an audit entry for the change. Stop `swain serve` first or run it while the server is up
// (SQLite WAL allows a second connection).
//
// Usage (from the repository root, after `npm run build`):
//   node examples/demo/set-content-policy.mjs <project-slug> <hash-only|inline> [--db PATH]
//
// "inline" stores tool arguments, tool results and model messages as text (masked best-effort).
// Only use it for data you are allowed to keep in clear text.
import { homedir } from "node:os";
import { join } from "node:path";
import { SqliteSwainStore } from "../../packages/db/dist/src/index.js";

const args = process.argv.slice(2);
const dbFlag = args.indexOf("--db");
const dbPath =
  dbFlag >= 0
    ? args[dbFlag + 1]
    : (process.env.SWAIN_DB ??
      join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "swain", "swain.sqlite"));
const [slug, policy] = args.filter((_, i) => dbFlag < 0 || (i !== dbFlag && i !== dbFlag + 1));
if (!slug || (policy !== "hash-only" && policy !== "inline")) {
  console.error("usage: node examples/demo/set-content-policy.mjs <project-slug> <hash-only|inline> [--db PATH]");
  process.exit(2);
}

const now = new Date().toISOString();
const store = SqliteSwainStore.open(dbPath, {
  uid: process.getuid(),
  nowMs: () => Date.now(),
  sessionMode: "local",
});
try {
  store.migrate({ nowIso: () => now });
  const { org } = store.ensureLocalTenancy(now);
  const project = store.listProjects({ orgId: org.orgId }).projects.find((p) => p.slug === slug);
  if (!project) {
    console.error(`no project '${slug}' (create one with: swain keys create --project ${slug} --save)`);
    process.exit(6);
  }
  const updated = store.setProjectPolicy(
    { orgId: org.orgId, projectId: project.projectId },
    { contentPolicy: policy },
    { type: "owner", id: "set-content-policy", at: now },
  );
  console.log(`${slug}: content policy is now ${updated.contentPolicy}`);
} finally {
  store.close();
}
