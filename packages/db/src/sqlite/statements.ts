/**
 * The statement registry (ADR-0007 r2 section 3, SPEC-003 section 2.3): every SQL statement the
 * store runs, except the migration DDL, lives here. Each entry is tagged `tenant: true|false`:
 *
 * - A tenant statement touches a table that has an `org_id` column. The lint (`lint.ts`, run by a
 *   unit test) fails unless every reference to such a table is constrained by `org_id = ?` and,
 *   for project tables, `project_id = ?` (directly or by equality with a constrained alias), and
 *   every INSERT sets both from bound parameters. Parameters are positional, never interpolated.
 * - The few reads that must find a row from a credential alone (an ingest key ID, a login code or a
 *   session token hash, the local org by slug) are tagged `unscoped`; the org-level project
 *   lookups are tagged `orgWide`. Both are pinned by name in the lint test.
 * - `tenant: false` is a closed allowlist (`NON_TENANT_STATEMENTS`): transactions, migrations,
 *   the schema check and `server_secrets`.
 * - No statement updates or deletes an evidence (L0/L1) row: `EVIDENCE_TABLES` below, enforced by a
 *   test. Re-sightings, conflicts and supersessions are new rows; "current" is computed at read time.
 * - `bigints: true` makes the statement read every integer as a `bigint` (nanosecond columns can
 *   exceed 2^53); the row mappers convert the small ones back.
 */
export type UnscopedReason = "auth-lookup" | "bootstrap";

export interface StatementDef {
  readonly tenant: boolean;
  readonly unscoped?: UnscopedReason;
  readonly bigints?: boolean;
  /** Org-level statement (no project in scope); pinned by name in the lint test. */
  readonly orgWide?: true;
  readonly sql: string;
}

const KEY_COLS =
  "key_id, org_id, project_id, label, scopes, agent_name, integration, created_at, created_by, expires_at_ms, revoked_at_ms, last_used_ms";
const PRJ_COLS =
  "org_id, workspace_id, project_id, slug, name, content_policy, max_inline_bytes, raw_retention, created_at";
const RUN_COLS =
  "r.org_id, r.project_id, r.run_id, r.kind, r.primary_agent_id, r.trace_id, r.adr_session_id, r.session_key, r.legacy_import_id, r.derivation, r.first_time_ns, r.last_time_ns, r.first_received_ms, r.last_received_ms, r.end_evidence, r.counts_json, r.flags_json, r.credentials_json";
const BATCH_COLS = "org_id, project_id, batch_id, signal, status, accepted, rejected, result_json";
const AGENT_COLS =
  "org_id, project_id, agent_id, agent_key, key_basis, display_name, first_seen_ms, last_seen_ms";
const SPAN_COLS =
  "s.org_id, s.project_id, s.key_id, s.trace_id, s.span_id, s.run_id, s.parent_span_id, s.name_json, s.kind, s.start_ns, s.end_ns, s.status_code, s.status_message_json, s.trace_state_json, s.flags, s.attributes_json, s.dropped_attributes, s.events_json, s.links_json, s.resource_sha256, s.scope_json, s.agent_id, s.op_class, s.op_json, s.batch_id, s.record_path, s.record_sha256, s.evidence_sha256, s.received_ms, s.late";
const IMPORT_COLS =
  "i.org_id, i.project_id, i.import_id, i.version, i.key_id, i.run_id, i.derivation, i.batch_id, i.received_ms, i.first_valid_time, i.record_json, i.meta_json";
/**
 * The current version of an import, derived at read time (SPEC-003 2.2 notes): the newest
 * server-derived version when one exists, else the newest version. Takes two `org_id` parameters.
 */
const CURRENT_I =
  "i.version = (SELECT MAX(i2.version) FROM imports i2 WHERE i2.org_id = ? AND i2.project_id = i.project_id AND i2.import_id = i.import_id AND (i2.derivation = 'server' OR NOT EXISTS (SELECT 1 FROM imports i3 WHERE i3.org_id = ? AND i3.project_id = i.project_id AND i3.import_id = i.import_id AND i3.derivation = 'server')))";
const RUN_FILTER =
  "r.org_id = ? AND r.project_id = ? AND (? IS NULL OR r.kind = ?) AND (? IS NULL OR EXISTS (SELECT 1 FROM run_agents ra WHERE ra.org_id = ? AND ra.project_id = r.project_id AND ra.run_id = r.run_id AND ra.agent_id = ?))";
const MIN_NS = (c: string) =>
  `CASE WHEN excluded.${c} IS NULL THEN runs.${c} WHEN runs.${c} IS NULL THEN excluded.${c} WHEN excluded.${c} < runs.${c} THEN excluded.${c} ELSE runs.${c} END`;
const MAX_NS = (c: string) =>
  `CASE WHEN excluded.${c} IS NULL THEN runs.${c} WHEN runs.${c} IS NULL THEN excluded.${c} WHEN excluded.${c} > runs.${c} THEN excluded.${c} ELSE runs.${c} END`;
const FLEET_SELECT = `SELECT a.${AGENT_COLS.split(", ").join(", a.")},
 (SELECT COUNT(*) FROM run_agents ra WHERE ra.org_id = ? AND ra.project_id = a.project_id AND ra.agent_id = a.agent_id) AS run_count,
 (SELECT r.run_id FROM runs r WHERE r.org_id = ? AND r.project_id = a.project_id AND r.primary_agent_id = a.agent_id ORDER BY r.last_received_ms DESC, r.run_id LIMIT 1) AS last_run_id
 FROM agents a WHERE a.org_id = ? AND a.project_id = ?`;
const STATUS_COUNT = (status: string) =>
  `(SELECT COUNT(*) FROM ingest_batches b WHERE b.org_id = ? AND b.project_id = p.project_id AND b.status = '${status}' AND b.received_ms >= ?) AS ${status}`;

export const STATEMENTS = {
  // ---- transactions, migrations, schema check, server secrets (tenant: false) --------------------
  "tx.begin": { tenant: false, sql: "BEGIN IMMEDIATE" },
  "tx.commit": { tenant: false, sql: "COMMIT" },
  "tx.rollback": { tenant: false, sql: "ROLLBACK" },
  "mig.hasTable": {
    tenant: false,
    sql: "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
  },
  "mig.userTables": {
    tenant: false,
    sql: "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
  },
  "mig.applied": {
    tenant: false,
    sql: "SELECT version, name, sha256 FROM schema_migrations ORDER BY version",
  },
  "mig.insert": {
    tenant: false,
    sql: "INSERT INTO schema_migrations (version, name, sha256, applied_at) VALUES (?, ?, ?, ?)",
  },
  "mig.backup": { tenant: false, sql: "VACUUM INTO ?" },
  "mig.schemaVersion": {
    tenant: false,
    sql: "SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations",
  },
  "schema.objects": {
    tenant: false,
    sql: "SELECT type, name, sql FROM sqlite_schema ORDER BY type, name",
  },
  "secret.get": { tenant: false, sql: "SELECT value FROM server_secrets WHERE name = ?" },
  "secret.insert": {
    tenant: false,
    sql: "INSERT INTO server_secrets (name, value, created_at) VALUES (?, ?, ?) ON CONFLICT (name) DO NOTHING",
  },

  // ---- tenancy ----------------------------------------------------------------------------------
  "org.insert": {
    tenant: true,
    sql: "INSERT INTO orgs (org_id, slug, name, created_at) VALUES (?, ?, ?, ?)",
  },
  "org.bySlug": {
    tenant: true,
    unscoped: "bootstrap",
    sql: "SELECT org_id, slug, name, created_at FROM orgs WHERE slug = ?",
  },
  "wsp.insert": {
    tenant: true,
    sql: "INSERT INTO workspaces (org_id, workspace_id, slug, name, created_at) VALUES (?, ?, ?, ?, ?)",
  },
  "wsp.bySlug": {
    tenant: true,
    sql: "SELECT org_id, workspace_id, slug, name, created_at FROM workspaces WHERE org_id = ? AND slug = ?",
  },
  "prj.insert": {
    tenant: true,
    sql: "INSERT INTO projects (org_id, workspace_id, project_id, slug, name, content_policy, max_inline_bytes, raw_retention, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  },
  "prj.byId": {
    tenant: true,
    sql: `SELECT ${PRJ_COLS} FROM projects WHERE org_id = ? AND project_id = ?`,
  },
  "prj.bySlug": {
    tenant: true,
    orgWide: true,
    sql: `SELECT ${PRJ_COLS} FROM projects WHERE org_id = ? AND workspace_id = ? AND slug = ?`,
  },
  "prj.list": {
    tenant: true,
    orgWide: true,
    sql: `SELECT ${PRJ_COLS} FROM projects WHERE org_id = ? ORDER BY created_at, project_id LIMIT ?`,
  },
  "prj.setPolicy": {
    tenant: true,
    sql: "UPDATE projects SET content_policy = ?, max_inline_bytes = ?, raw_retention = ? WHERE org_id = ? AND project_id = ?",
  },

  // ---- keys -------------------------------------------------------------------------------------
  "key.insert": {
    tenant: true,
    sql: "INSERT INTO ingest_keys (key_id, org_id, project_id, secret_sha256, label, scopes, agent_name, integration, created_at, created_by, expires_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  },
  "key.byId": {
    tenant: true,
    unscoped: "auth-lookup",
    sql: `SELECT ${KEY_COLS}, secret_sha256 FROM ingest_keys WHERE key_id = ?`,
  },
  "key.revoke": {
    tenant: true,
    sql: "UPDATE ingest_keys SET revoked_at_ms = ? WHERE org_id = ? AND project_id = ? AND key_id = ? AND revoked_at_ms IS NULL",
  },
  "key.list": {
    tenant: true,
    sql: `SELECT ${KEY_COLS} FROM ingest_keys WHERE org_id = ? AND project_id = ? ORDER BY created_at, key_id LIMIT ?`,
  },

  // ---- batches and idempotency ------------------------------------------------------------------
  "batch.insert": {
    tenant: true,
    sql: "INSERT INTO ingest_batches (org_id, project_id, batch_id, signal, encoding, content_encoding, body_sha256, body_bytes, decoded_sha256, decoded_bytes, key_id, received_ms, status, accepted, rejected, result_json, raw, raw_codec) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (org_id, project_id, key_id, signal, decoded_sha256) DO NOTHING",
  },
  "batch.bySignalSha": {
    tenant: true,
    sql: `SELECT ${BATCH_COLS} FROM ingest_batches WHERE org_id = ? AND project_id = ? AND key_id = ? AND signal = ? AND decoded_sha256 = ?`,
  },
  "batch.byId": {
    tenant: true,
    sql: `SELECT ${BATCH_COLS} FROM ingest_batches WHERE org_id = ? AND project_id = ? AND batch_id = ?`,
  },
  "batch.keyById": {
    tenant: true,
    sql: "SELECT org_id, project_id, key_id FROM ingest_batches WHERE org_id = ? AND project_id = ? AND batch_id = ?",
  },
  "idem.get": {
    tenant: true,
    sql: "SELECT org_id, project_id, body_sha256, batch_id, created_ms FROM idempotency_keys WHERE org_id = ? AND project_id = ? AND key_id = ? AND route = ? AND idem_key = ?",
  },
  "idem.put": {
    tenant: true,
    sql: "INSERT INTO idempotency_keys (org_id, project_id, key_id, route, idem_key, body_sha256, batch_id, created_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (org_id, project_id, key_id, route, idem_key) DO NOTHING",
  },
  "res.insert": {
    tenant: true,
    sql: "INSERT INTO resources (org_id, project_id, resource_sha256, attributes_json, schema_url) VALUES (?, ?, ?, ?, ?) ON CONFLICT (org_id, project_id, resource_sha256) DO NOTHING",
  },

  // ---- agents and runs (L2: rebuildable) -------------------------------------------------------
  "agent.upsert": {
    tenant: true,
    sql: "INSERT INTO agents (org_id, project_id, agent_id, agent_key, key_basis, display_name, first_seen_ms, last_seen_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (org_id, project_id, agent_id) DO UPDATE SET first_seen_ms = MIN(agents.first_seen_ms, excluded.first_seen_ms), last_seen_ms = MAX(agents.last_seen_ms, excluded.last_seen_ms)",
  },
  "agent.get": {
    tenant: true,
    sql: `SELECT ${AGENT_COLS} FROM agents WHERE org_id = ? AND project_id = ? AND agent_id = ?`,
  },
  "agent.runCount": {
    tenant: true,
    sql: "SELECT COUNT(*) AS n FROM run_agents WHERE org_id = ? AND project_id = ? AND agent_id = ?",
  },
  "fleet.listRecent": {
    tenant: true,
    sql: `${FLEET_SELECT} ORDER BY a.last_seen_ms DESC, a.agent_id LIMIT ? OFFSET ?`,
  },
  "fleet.listName": {
    tenant: true,
    sql: `${FLEET_SELECT} ORDER BY a.display_name, a.agent_id LIMIT ? OFFSET ?`,
  },
  "fleet.count": {
    tenant: true,
    sql: "SELECT COUNT(*) AS n FROM agents a WHERE a.org_id = ? AND a.project_id = ?",
  },
  "run.upsert": {
    tenant: true,
    sql: `INSERT INTO runs (org_id, project_id, run_id, kind, primary_agent_id, trace_id, adr_session_id, session_key, legacy_import_id, derivation, first_time_ns, last_time_ns, first_received_ms, last_received_ms, end_evidence, counts_json, flags_json, credentials_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, '{}', '{}', '[]') ON CONFLICT (org_id, project_id, run_id) DO UPDATE SET first_time_ns = ${MIN_NS("first_time_ns")}, last_time_ns = ${MAX_NS("last_time_ns")}, first_received_ms = MIN(runs.first_received_ms, excluded.first_received_ms), last_received_ms = MAX(runs.last_received_ms, excluded.last_received_ms)`,
  },
  "run.refresh": {
    tenant: true,
    sql: "UPDATE runs SET counts_json = ?, flags_json = ?, credentials_json = ?, end_evidence = ? WHERE org_id = ? AND project_id = ? AND run_id = ?",
  },
  "run.link": {
    tenant: true,
    sql: "INSERT INTO run_agents (org_id, project_id, run_id, agent_id) VALUES (?, ?, ?, ?) ON CONFLICT (org_id, project_id, run_id, agent_id) DO NOTHING",
  },
  "run.get": {
    tenant: true,
    bigints: true,
    sql: `SELECT ${RUN_COLS} FROM runs r WHERE r.org_id = ? AND r.project_id = ? AND r.run_id = ?`,
  },
  "run.list": {
    tenant: true,
    bigints: true,
    sql: `SELECT ${RUN_COLS} FROM runs r WHERE ${RUN_FILTER} ORDER BY r.last_received_ms DESC, r.run_id LIMIT ? OFFSET ?`,
  },
  "run.count": {
    tenant: true,
    sql: `SELECT COUNT(*) AS n FROM runs r WHERE ${RUN_FILTER}`,
  },
  "run.agents": {
    tenant: true,
    sql: "SELECT org_id, project_id, agent_id FROM run_agents WHERE org_id = ? AND project_id = ? AND run_id = ? ORDER BY agent_id LIMIT ?",
  },
  "run.spanAgg": {
    tenant: true,
    sql: "SELECT COUNT(*) AS spans, COALESCE(SUM(CASE WHEN parent_span_id IS NULL THEN 1 ELSE 0 END), 0) AS roots, COALESCE(SUM(CASE WHEN parent_span_id IS NULL AND end_ns IS NOT NULL THEN 1 ELSE 0 END), 0) AS ended_roots, COALESCE(SUM(CASE WHEN status_code = 2 THEN 1 ELSE 0 END), 0) AS errors, COALESCE(SUM(late), 0) AS late FROM spans WHERE org_id = ? AND project_id = ? AND run_id = ?",
  },
  "run.conflictCount": {
    tenant: true,
    sql: "SELECT COUNT(*) AS n FROM span_conflicts c JOIN spans s ON s.org_id = c.org_id AND s.project_id = c.project_id AND s.trace_id = c.trace_id AND s.span_id = c.span_id WHERE c.org_id = ? AND s.org_id = ? AND s.project_id = ? AND s.run_id = ? AND c.relation = 'conflicting'",
  },
  "run.logCount": {
    tenant: true,
    sql: "SELECT COUNT(*) AS n FROM log_records WHERE org_id = ? AND project_id = ? AND run_id = ?",
  },
  "run.eventAgg": {
    tenant: true,
    sql: `SELECT COUNT(DISTINCT i.import_id) AS imports, COUNT(e.ord) AS events FROM imports i LEFT JOIN events e ON e.org_id = ? AND e.project_id = i.project_id AND e.import_id = i.import_id AND e.version = i.version WHERE i.org_id = ? AND i.project_id = ? AND i.run_id = ? AND ${CURRENT_I}`,
  },
  "run.endEvents": {
    tenant: true,
    sql: `SELECT COUNT(*) AS n FROM events e JOIN imports i ON i.org_id = ? AND i.project_id = e.project_id AND i.import_id = e.import_id AND i.version = e.version WHERE e.org_id = ? AND e.project_id = ? AND i.run_id = ? AND e.kind = 'session.ended' AND ${CURRENT_I}`,
  },
  "run.credSpans": {
    tenant: true,
    sql: "SELECT org_id, project_id, key_id, COUNT(*) AS n FROM spans WHERE org_id = ? AND project_id = ? AND run_id = ? GROUP BY key_id ORDER BY key_id",
  },
  "run.credLogs": {
    tenant: true,
    sql: "SELECT org_id, project_id, key_id, COUNT(*) AS n FROM log_records WHERE org_id = ? AND project_id = ? AND run_id = ? GROUP BY key_id ORDER BY key_id",
  },
  "run.credImports": {
    tenant: true,
    sql: `SELECT i.org_id, i.project_id, i.key_id, COUNT(*) AS n FROM imports i WHERE i.org_id = ? AND i.project_id = ? AND i.run_id = ? AND ${CURRENT_I} GROUP BY i.key_id ORDER BY i.key_id`,
  },

  // ---- spans, conflicts, logs (L1: insert only) -------------------------------------------------
  "span.insert": {
    tenant: true,
    sql: "INSERT INTO spans (org_id, project_id, trace_id, span_id, run_id, parent_span_id, name_json, kind, start_ns, end_ns, status_code, status_message_json, trace_state_json, flags, attributes_json, dropped_attributes, events_json, links_json, resource_sha256, scope_json, agent_id, op_class, op_json, batch_id, key_id, record_path, record_sha256, evidence_sha256, received_ms, late) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (org_id, project_id, trace_id, span_id) DO NOTHING",
  },
  "span.sha": {
    tenant: true,
    sql: "SELECT org_id, project_id, evidence_sha256, key_id FROM spans WHERE org_id = ? AND project_id = ? AND trace_id = ? AND span_id = ?",
  },
  "span.conflictInsert": {
    tenant: true,
    sql: "INSERT INTO span_conflicts (org_id, project_id, trace_id, span_id, record_sha256, evidence_sha256, key_id, relation, batch_id, record_path, received_ms, record_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (org_id, project_id, trace_id, span_id, evidence_sha256, key_id) DO NOTHING",
  },
  "span.byRun": {
    tenant: true,
    bigints: true,
    sql: `SELECT ${SPAN_COLS}, EXISTS (SELECT 1 FROM span_conflicts c WHERE c.org_id = ? AND c.project_id = s.project_id AND c.trace_id = s.trace_id AND c.span_id = s.span_id AND c.relation = 'conflicting' AND c.key_id <> s.key_id) AS cross_key_conflict FROM spans s WHERE s.org_id = ? AND s.project_id = ? AND s.run_id = ? ORDER BY s.start_ns IS NULL, s.start_ns, s.received_ms, s.trace_id, s.span_id LIMIT ?`,
  },
  "span.conflictsByRun": {
    tenant: true,
    sql: "SELECT c.org_id, c.project_id, c.trace_id, c.span_id, c.record_sha256, c.key_id, c.relation, s.key_id AS canonical_key_id, c.batch_id, c.record_path, c.received_ms, c.record_json FROM span_conflicts c JOIN spans s ON s.org_id = c.org_id AND s.project_id = c.project_id AND s.trace_id = c.trace_id AND s.span_id = c.span_id WHERE c.org_id = ? AND s.org_id = ? AND s.project_id = ? AND s.run_id = ? ORDER BY c.received_ms, c.trace_id, c.span_id, c.record_sha256, c.key_id LIMIT 1001",
  },
  "log.insert": {
    tenant: true,
    sql: "INSERT INTO log_records (org_id, project_id, log_id, run_id, time_ns, observed_ns, severity_number, severity_text_json, event_name_json, body_json, attributes_json, trace_id, span_id, resource_sha256, scope_json, batch_id, record_path, record_sha256, evidence_sha256, occurrence, dup_of, projected_import_id, received_ms, key_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (org_id, project_id, log_id) DO NOTHING",
  },
  "log.keyById": {
    tenant: true,
    sql: "SELECT org_id, project_id, key_id FROM log_records WHERE org_id = ? AND project_id = ? AND log_id = ?",
  },

  // ---- imports and events (L1: insert only, versioned) ------------------------------------------
  "import.summary": {
    tenant: true,
    sql: "SELECT COUNT(*) AS n, COALESCE(MAX(version), 0) AS max_version, COALESCE(SUM(CASE WHEN derivation = 'server' THEN 1 ELSE 0 END), 0) AS servers, COALESCE(SUM(CASE WHEN derivation = 'client' THEN 1 ELSE 0 END), 0) AS clients FROM imports WHERE org_id = ? AND project_id = ? AND import_id = ?",
  },
  "import.latest": {
    tenant: true,
    sql: "SELECT org_id, project_id, import_id, version, run_id, adapter_version FROM imports WHERE org_id = ? AND project_id = ? AND import_id = ? ORDER BY CASE WHEN derivation = 'server' THEN 1 ELSE 0 END DESC, version DESC LIMIT 1",
  },
  "import.insert": {
    tenant: true,
    sql: "INSERT INTO imports (org_id, project_id, import_id, version, run_id, adr_session_id, provider, source_kind, adapter_id, adapter_version, record_json, meta_json, derivation, batch_id, received_ms, key_id, first_valid_time) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  },
  "event.insert": {
    tenant: true,
    sql: "INSERT INTO events (org_id, project_id, import_id, version, ord, event_id, kind, event_json, key_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  },
  "import.byRun": {
    tenant: true,
    sql: `SELECT ${IMPORT_COLS} FROM imports i WHERE i.org_id = ? AND i.project_id = ? AND i.run_id = ? AND ${CURRENT_I} ORDER BY i.first_valid_time IS NULL, i.first_valid_time, i.received_ms, i.import_id LIMIT ?`,
  },
  "event.byImport": {
    tenant: true,
    sql: "SELECT org_id, project_id, ord, event_json FROM events WHERE org_id = ? AND project_id = ? AND import_id = ? AND version = ? ORDER BY ord LIMIT ?",
  },

  // ---- ID resolution (prefix match without LIKE, so `%`, `_` and `\` are never wildcards) --------
  "resolve.runPrefix": {
    tenant: true,
    sql: "SELECT org_id, project_id, run_id FROM runs WHERE org_id = ? AND project_id = ? AND substr(run_id, 1, ?) = ? ORDER BY run_id LIMIT 20",
  },
  "resolve.runByTrace": {
    tenant: true,
    sql: "SELECT org_id, project_id, run_id FROM runs WHERE org_id = ? AND project_id = ? AND trace_id = ? ORDER BY run_id LIMIT 20",
  },
  "resolve.runBySession": {
    tenant: true,
    sql: "SELECT org_id, project_id, run_id FROM runs WHERE org_id = ? AND project_id = ? AND adr_session_id = ? ORDER BY run_id LIMIT 20",
  },
  "resolve.agentPrefix": {
    tenant: true,
    sql: "SELECT org_id, project_id, agent_id FROM agents WHERE org_id = ? AND project_id = ? AND substr(agent_id, 1, ?) = ? ORDER BY agent_id LIMIT 20",
  },
  "resolve.importPrefix": {
    tenant: true,
    sql: `SELECT i.org_id, i.project_id, i.import_id, i.run_id FROM imports i WHERE i.org_id = ? AND i.project_id = ? AND substr(i.import_id, 1, ?) = ? AND ${CURRENT_I} ORDER BY i.import_id LIMIT 20`,
  },
  "resolve.eventPrefix": {
    tenant: true,
    sql: `SELECT DISTINCT e.org_id, e.project_id, e.event_id, i.run_id FROM events e JOIN imports i ON i.org_id = ? AND i.project_id = e.project_id AND i.import_id = e.import_id AND i.version = e.version WHERE e.org_id = ? AND e.project_id = ? AND substr(e.event_id, 1, ?) = ? AND ${CURRENT_I} ORDER BY e.event_id, i.run_id LIMIT 20`,
  },
  "resolve.spanById": {
    tenant: true,
    sql: "SELECT org_id, project_id, span_id, run_id FROM spans WHERE org_id = ? AND project_id = ? AND span_id = ? ORDER BY run_id, trace_id LIMIT 20",
  },

  // ---- status -----------------------------------------------------------------------------------
  "status.project": {
    tenant: true,
    sql: `SELECT p.org_id, p.project_id, p.slug, p.content_policy, p.raw_retention,
 (SELECT COUNT(*) FROM agents a WHERE a.org_id = ? AND a.project_id = p.project_id) AS agents,
 (SELECT COUNT(*) FROM runs r WHERE r.org_id = ? AND r.project_id = p.project_id) AS runs,
 (SELECT MAX(b.received_ms) FROM ingest_batches b WHERE b.org_id = ? AND b.project_id = p.project_id) AS last_ingest_ms,
 ${STATUS_COUNT("accepted")}, ${STATUS_COUNT("partial")}, ${STATUS_COUNT("rejected")}
 FROM projects p WHERE p.org_id = ? AND p.project_id = ?`,
  },

  // ---- login codes and sessions -----------------------------------------------------------------
  "login.insert": {
    tenant: true,
    sql: "INSERT INTO login_codes (code_sha256, org_id, next_path, expires_at_ms) VALUES (?, ?, ?, ?)",
  },
  "login.consume": {
    tenant: true,
    unscoped: "auth-lookup",
    sql: "UPDATE login_codes SET used_at_ms = ? WHERE code_sha256 = ? AND used_at_ms IS NULL AND expires_at_ms > ? RETURNING org_id, next_path",
  },
  "session.insert": {
    tenant: true,
    sql: "INSERT INTO web_sessions (token_sha256, org_id, principal, created_ms, last_seen_ms) VALUES (?, ?, ?, ?, ?)",
  },
  "session.touch": {
    tenant: true,
    unscoped: "auth-lookup",
    sql: "UPDATE web_sessions SET last_seen_ms = ? WHERE token_sha256 = ? AND revoked_ms IS NULL AND ? - last_seen_ms <= ? AND ? - created_ms <= ? RETURNING org_id, principal, created_ms, last_seen_ms",
  },
  "session.revoke": {
    tenant: true,
    unscoped: "auth-lookup",
    sql: "UPDATE web_sessions SET revoked_ms = ? WHERE token_sha256 = ? AND revoked_ms IS NULL",
  },

  // ---- audit log --------------------------------------------------------------------------------
  "audit.last": {
    tenant: true,
    sql: "SELECT org_id, seq, hash FROM audit_log WHERE org_id = ? ORDER BY seq DESC LIMIT 1",
  },
  "audit.insert": {
    tenant: true,
    sql: "INSERT INTO audit_log (org_id, seq, at, actor_type, actor_id, action, target_type, target_id, detail_json, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  },
  "audit.page": {
    tenant: true,
    sql: "SELECT org_id, seq, at, actor_type, actor_id, action, target_type, target_id, detail_json, prev_hash, hash FROM audit_log WHERE org_id = ? AND seq > ? ORDER BY seq LIMIT ?",
  },
} as const satisfies Record<string, StatementDef>;

export type StatementName = keyof typeof STATEMENTS;

/** Every table with an `org_id` column in migration 0001. A unit test checks this against the DDL. */
export const TENANT_TABLES: readonly string[] = [
  "orgs",
  "workspaces",
  "projects",
  "ingest_keys",
  "login_codes",
  "web_sessions",
  "ingest_batches",
  "idempotency_keys",
  "resources",
  "agents",
  "runs",
  "run_agents",
  "spans",
  "span_conflicts",
  "log_records",
  "imports",
  "events",
  "operations",
  "usage",
  "edges",
  "audit_log",
];

/**
 * L0/L1 evidence tables: rows are inserted, never updated or deleted (SPEC-003 2.2 notes, F4).
 * A test asserts that no registered `UPDATE`, `DELETE` or `DO UPDATE` targets one.
 */
export const EVIDENCE_TABLES: readonly string[] = [
  "ingest_batches",
  "idempotency_keys",
  "resources",
  "spans",
  "span_conflicts",
  "log_records",
  "imports",
  "events",
  "audit_log",
];

/**
 * Tenant SELECTs that return no row of a tenant table, only a COUNT or other aggregate, and so
 * carry no `org_id` column for `assertRowScope`. Every other tenant read selects `org_id` (and
 * `project_id` where the table has it) and the store checks each returned row (G3 C7). A test
 * pins this list and checks the columns of every registered statement.
 */
export const AGGREGATE_STATEMENTS: readonly StatementName[] = [
  "agent.runCount",
  "fleet.count",
  "import.summary",
  "run.conflictCount",
  "run.count",
  "run.endEvents",
  "run.eventAgg",
  "run.logCount",
  "run.spanAgg",
];

/** The statements allowed to skip `org_id = ?`, pinned by name (ADR-0007 section 3). */
export const UNSCOPED_STATEMENTS: readonly StatementName[] = [
  "key.byId",
  "login.consume",
  "org.bySlug",
  "session.revoke",
  "session.touch",
];

/** Statements tagged `orgWide` (no project in scope), pinned by name. */
export const ORG_WIDE_STATEMENTS: readonly StatementName[] = ["prj.bySlug", "prj.list"];

/**
 * The closed allowlist of `tenant: false` statements (ADR-0007 r2 section 3): transactions,
 * migrations, the schema check and `server_secrets`. Everything that reads tenant data is tagged
 * `tenant: true`.
 */
export const NON_TENANT_STATEMENTS: readonly StatementName[] = [
  "tx.begin",
  "tx.commit",
  "tx.rollback",
  "mig.hasTable",
  "mig.userTables",
  "mig.applied",
  "mig.insert",
  "mig.backup",
  "mig.schemaVersion",
  "schema.objects",
  "secret.get",
  "secret.insert",
];
