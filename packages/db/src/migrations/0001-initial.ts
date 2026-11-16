/**
 * Migration 0001 (SPEC-003 section 2.2), copied verbatim. All tables are STRICT. Never edit: the
 * sha256 of this text is pinned in `schema_migrations`; add a new migration instead.
 */
export const migration0001 = {
  version: 1,
  name: "initial",
  sql: `CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, sha256 TEXT NOT NULL, applied_at TEXT NOT NULL) STRICT;
CREATE TABLE server_secrets (name TEXT PRIMARY KEY, value BLOB NOT NULL, created_at TEXT NOT NULL) STRICT;

CREATE TABLE orgs (org_id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL, created_at TEXT NOT NULL) STRICT;
CREATE TABLE workspaces (org_id TEXT NOT NULL REFERENCES orgs(org_id), workspace_id TEXT NOT NULL, slug TEXT NOT NULL,
  name TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (org_id, workspace_id), UNIQUE (org_id, slug)) STRICT;
CREATE TABLE projects (org_id TEXT NOT NULL, workspace_id TEXT NOT NULL, project_id TEXT NOT NULL, slug TEXT NOT NULL,
  name TEXT NOT NULL,
  content_policy TEXT NOT NULL DEFAULT 'hash-only' CHECK (content_policy IN ('hash-only','inline')),
  max_inline_bytes INTEGER NOT NULL DEFAULT 65536 CHECK (max_inline_bytes BETWEEN 0 AND 1048576),
  raw_retention TEXT NOT NULL DEFAULT 'hash-only' CHECK (raw_retention IN ('hash-only','full')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (org_id, project_id), UNIQUE (org_id, workspace_id, slug),
  FOREIGN KEY (org_id, workspace_id) REFERENCES workspaces(org_id, workspace_id)) STRICT;

CREATE TABLE ingest_keys (key_id TEXT PRIMARY KEY, org_id TEXT NOT NULL, project_id TEXT NOT NULL,
  secret_sha256 TEXT NOT NULL, label TEXT NOT NULL, scopes TEXT NOT NULL /* JSON array, closed set */,
  /* scopes: closed set ingest:otlp, ingest:native, ingest:hooks, ingest:replace, read:status (r2 F4/F22) */
  agent_name TEXT, integration TEXT, created_at TEXT NOT NULL, created_by TEXT NOT NULL,
  expires_at_ms INTEGER, revoked_at_ms INTEGER, last_used_ms INTEGER,
  FOREIGN KEY (org_id, project_id) REFERENCES projects(org_id, project_id)) STRICT;
CREATE INDEX ingest_keys_project ON ingest_keys (org_id, project_id);

CREATE TABLE login_codes (code_sha256 TEXT PRIMARY KEY, org_id TEXT NOT NULL, next_path TEXT NOT NULL,
  expires_at_ms INTEGER NOT NULL, used_at_ms INTEGER) STRICT;
CREATE TABLE web_sessions (token_sha256 TEXT PRIMARY KEY, org_id TEXT NOT NULL, principal TEXT NOT NULL,
  created_ms INTEGER NOT NULL, last_seen_ms INTEGER NOT NULL, revoked_ms INTEGER) STRICT;

CREATE TABLE ingest_batches (org_id TEXT NOT NULL, project_id TEXT NOT NULL, batch_id TEXT NOT NULL,
  signal TEXT NOT NULL CHECK (signal IN ('traces','logs','source','events','hooks')),
  encoding TEXT NOT NULL CHECK (encoding IN ('json','protobuf','octet','ndjson')),
  content_encoding TEXT NOT NULL CHECK (content_encoding IN ('identity','gzip')),
  body_sha256 TEXT NOT NULL, body_bytes INTEGER NOT NULL, decoded_sha256 TEXT NOT NULL, decoded_bytes INTEGER NOT NULL,
  key_id TEXT NOT NULL, received_ms INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('accepted','partial','rejected')),
  accepted INTEGER NOT NULL, rejected INTEGER NOT NULL, result_json TEXT NOT NULL,
  raw BLOB, raw_codec TEXT CHECK (raw_codec IS NULL OR raw_codec = 'deflate'),
  PRIMARY KEY (org_id, project_id, batch_id), UNIQUE (org_id, project_id, key_id, signal, decoded_sha256)) STRICT;  /* r2 F6 */
CREATE INDEX ingest_batches_key ON ingest_batches (org_id, project_id, key_id);
CREATE TABLE idempotency_keys (org_id TEXT NOT NULL, project_id TEXT NOT NULL, key_id TEXT NOT NULL, route TEXT NOT NULL,
  idem_key TEXT NOT NULL, body_sha256 TEXT NOT NULL, batch_id TEXT NOT NULL, created_ms INTEGER NOT NULL,
  PRIMARY KEY (org_id, project_id, key_id, route, idem_key)) STRICT;  /* conflict window 24 h by created_ms; no server deletion (r2 F22) */

CREATE TABLE resources (org_id TEXT NOT NULL, project_id TEXT NOT NULL, resource_sha256 TEXT NOT NULL,
  attributes_json TEXT NOT NULL, schema_url TEXT, PRIMARY KEY (org_id, project_id, resource_sha256)) STRICT;

CREATE TABLE agents (org_id TEXT NOT NULL, project_id TEXT NOT NULL, agent_id TEXT NOT NULL, agent_key TEXT NOT NULL,
  key_basis TEXT NOT NULL, display_name TEXT NOT NULL, first_seen_ms INTEGER NOT NULL, last_seen_ms INTEGER NOT NULL,
  PRIMARY KEY (org_id, project_id, agent_id), UNIQUE (org_id, project_id, agent_key)) STRICT;

CREATE TABLE runs (org_id TEXT NOT NULL, project_id TEXT NOT NULL, run_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('trace','session','import','logs')),
  primary_agent_id TEXT NOT NULL, trace_id TEXT, adr_session_id TEXT, session_key TEXT, legacy_import_id TEXT,
  derivation TEXT NOT NULL CHECK (derivation IN ('server','client','migrated')),
  first_time_ns INTEGER, last_time_ns INTEGER, first_received_ms INTEGER NOT NULL, last_received_ms INTEGER NOT NULL,
  end_evidence INTEGER NOT NULL DEFAULT 0, counts_json TEXT NOT NULL, flags_json TEXT NOT NULL,
  credentials_json TEXT NOT NULL /* L2 cache: [{keyId, records}] (r2 F6) */,
  PRIMARY KEY (org_id, project_id, run_id)) STRICT;
CREATE INDEX runs_agent_recent ON runs (org_id, project_id, primary_agent_id, last_received_ms);
CREATE INDEX runs_trace ON runs (org_id, project_id, trace_id);
CREATE INDEX runs_session ON runs (org_id, project_id, adr_session_id);
CREATE INDEX runs_legacy ON runs (org_id, project_id, legacy_import_id);
CREATE TABLE run_agents (org_id TEXT NOT NULL, project_id TEXT NOT NULL, run_id TEXT NOT NULL, agent_id TEXT NOT NULL,
  PRIMARY KEY (org_id, project_id, run_id, agent_id)) STRICT;

CREATE TABLE spans (org_id TEXT NOT NULL, project_id TEXT NOT NULL, trace_id TEXT NOT NULL, span_id TEXT NOT NULL,
  run_id TEXT NOT NULL, parent_span_id TEXT, name_json TEXT NOT NULL /* metadata string or ContentRef */,
  kind INTEGER NOT NULL, start_ns INTEGER, end_ns INTEGER, status_code INTEGER NOT NULL, status_message_json TEXT,
  trace_state_json TEXT /* PolicyText JSON */, flags INTEGER, attributes_json TEXT NOT NULL, dropped_attributes INTEGER NOT NULL,
  events_json TEXT NOT NULL, links_json TEXT NOT NULL, resource_sha256 TEXT NOT NULL, scope_json TEXT NOT NULL,
  agent_id TEXT NOT NULL, op_class TEXT NOT NULL, op_json TEXT NOT NULL,
  batch_id TEXT NOT NULL, record_path TEXT NOT NULL,
  record_sha256 TEXT NOT NULL /* bare SPEC-003 3.4 record hash */,
  evidence_sha256 TEXT NOT NULL /* dedup digest over record, resource, scope and RECEIVED schema URLs (N1.5 G3 F5) */,
  received_ms INTEGER NOT NULL,
  key_id TEXT NOT NULL /* r2 F6 */, late INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (org_id, project_id, trace_id, span_id)) STRICT;
CREATE INDEX spans_run ON spans (org_id, project_id, run_id, start_ns);
CREATE INDEX spans_key ON spans (org_id, project_id, key_id);
CREATE INDEX spans_evidence ON spans (org_id, project_id, evidence_sha256);
CREATE TABLE span_conflicts (org_id TEXT NOT NULL, project_id TEXT NOT NULL, trace_id TEXT NOT NULL, span_id TEXT NOT NULL,
  record_sha256 TEXT NOT NULL, evidence_sha256 TEXT NOT NULL, key_id TEXT NOT NULL,
  relation TEXT NOT NULL CHECK (relation IN ('identical-same-key','identical-other-key','conflicting')),
  batch_id TEXT NOT NULL, record_path TEXT NOT NULL, received_ms INTEGER NOT NULL,
  record_json TEXT NOT NULL /* POST-content-policy form (r2 F2) */,
  PRIMARY KEY (org_id, project_id, trace_id, span_id, evidence_sha256, key_id)) STRICT;
CREATE INDEX span_conflicts_key ON span_conflicts (org_id, project_id, key_id);
CREATE INDEX span_conflicts_evidence ON span_conflicts (org_id, project_id, evidence_sha256);

CREATE TABLE log_records (org_id TEXT NOT NULL, project_id TEXT NOT NULL, log_id TEXT NOT NULL, run_id TEXT,
  time_ns INTEGER, observed_ns INTEGER, severity_number INTEGER, severity_text_json TEXT, event_name_json TEXT /* PolicyText JSON */,
  body_json TEXT, attributes_json TEXT NOT NULL, trace_id TEXT, span_id TEXT, resource_sha256 TEXT NOT NULL,
  scope_json TEXT NOT NULL, batch_id TEXT NOT NULL, record_path TEXT NOT NULL, record_sha256 TEXT NOT NULL,
  evidence_sha256 TEXT NOT NULL /* digest over record, resource, scope, RECEIVED schema URLs and occurrence */,
  occurrence INTEGER NOT NULL, dup_of TEXT, projected_import_id TEXT, received_ms INTEGER NOT NULL,
  key_id TEXT NOT NULL /* r2 F6 */,
  PRIMARY KEY (org_id, project_id, log_id)) STRICT;
CREATE INDEX log_records_run ON log_records (org_id, project_id, run_id, time_ns);
CREATE INDEX log_records_key ON log_records (org_id, project_id, key_id);
CREATE INDEX log_records_evidence ON log_records (org_id, project_id, evidence_sha256);

CREATE TABLE imports (org_id TEXT NOT NULL, project_id TEXT NOT NULL, import_id TEXT NOT NULL,
  version INTEGER NOT NULL /* 1.. ; append-only; the current version is MAX(version) (r2 F4) */,
  run_id TEXT NOT NULL,
  adr_session_id TEXT NOT NULL, provider TEXT NOT NULL, source_kind TEXT NOT NULL, adapter_id TEXT NOT NULL,
  adapter_version TEXT NOT NULL, record_json TEXT NOT NULL /* ImportRecord */, meta_json TEXT NOT NULL /* source, warnings, stats, outcome, contentDowngraded */,
  derivation TEXT NOT NULL CHECK (derivation IN ('server','client','migrated')), batch_id TEXT, received_ms INTEGER NOT NULL,
  key_id TEXT NOT NULL /* r2 F6; 'local-cli' for migrated imports */, first_valid_time TEXT,
  PRIMARY KEY (org_id, project_id, import_id, version)) STRICT;
CREATE INDEX imports_run ON imports (org_id, project_id, run_id, first_valid_time, received_ms);
CREATE INDEX imports_key ON imports (org_id, project_id, key_id);
CREATE TABLE events (org_id TEXT NOT NULL, project_id TEXT NOT NULL, import_id TEXT NOT NULL, version INTEGER NOT NULL,
  ord INTEGER NOT NULL, event_id TEXT NOT NULL, kind TEXT NOT NULL,
  event_json TEXT NOT NULL /* canonicalJson(CanonicalEvent), post content policy (r2 F3) */,
  key_id TEXT NOT NULL /* r2 F6 */,
  PRIMARY KEY (org_id, project_id, import_id, version, ord)) STRICT;
CREATE INDEX events_id ON events (org_id, project_id, event_id);
CREATE INDEX events_key ON events (org_id, project_id, key_id);

CREATE TABLE operations (org_id TEXT NOT NULL, project_id TEXT NOT NULL, run_id TEXT NOT NULL, op_ref TEXT NOT NULL,
  op_class TEXT NOT NULL CHECK (op_class IN ('llm','tool','agent','handoff','workflow','generic')),
  agent_id TEXT NOT NULL, name TEXT, status TEXT NOT NULL, duration_ms INTEGER, started_ns INTEGER, norm_basis TEXT NOT NULL,
  PRIMARY KEY (org_id, project_id, run_id, op_ref)) STRICT;
CREATE INDEX operations_agent ON operations (org_id, project_id, agent_id, op_class, status);
CREATE TABLE usage (org_id TEXT NOT NULL, project_id TEXT NOT NULL, run_id TEXT NOT NULL, op_ref TEXT NOT NULL,
  agent_id TEXT NOT NULL, model TEXT, provider TEXT, scope TEXT NOT NULL, input_tokens INTEGER, output_tokens INTEGER,
  cache_read_tokens INTEGER, cache_write_tokens INTEGER, reasoning_tokens INTEGER, cost_usd_estimate REAL,
  basis TEXT NOT NULL, PRIMARY KEY (org_id, project_id, run_id, op_ref)) STRICT;
CREATE TABLE edges (org_id TEXT NOT NULL, project_id TEXT NOT NULL, edge_id TEXT NOT NULL, kind TEXT NOT NULL,
  from_type TEXT NOT NULL, from_id TEXT NOT NULL, to_type TEXT NOT NULL, to_id TEXT NOT NULL, basis TEXT NOT NULL,
  rule TEXT, confidence TEXT NOT NULL CHECK (confidence IN ('asserted','inferred')), evidence_json TEXT NOT NULL,
  key_ids_json TEXT NOT NULL, cross_credential INTEGER NOT NULL /* r2 F6 */,
  evidence_count INTEGER NOT NULL, first_seen_ms INTEGER NOT NULL, last_seen_ms INTEGER NOT NULL,
  PRIMARY KEY (org_id, project_id, edge_id)) STRICT;
CREATE INDEX edges_from ON edges (org_id, project_id, from_id);
CREATE INDEX edges_to ON edges (org_id, project_id, to_id);

CREATE TABLE audit_log (org_id TEXT NOT NULL, seq INTEGER NOT NULL, at TEXT NOT NULL, actor_type TEXT NOT NULL,
  actor_id TEXT NOT NULL, action TEXT NOT NULL, target_type TEXT NOT NULL, target_id TEXT NOT NULL,
  detail_json TEXT NOT NULL, prev_hash TEXT NOT NULL, hash TEXT NOT NULL, PRIMARY KEY (org_id, seq)) STRICT;
`,
} as const;
