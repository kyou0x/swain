# ADR-0004: Swain platform architecture (local and self-hosted server)

Product name changed by the owner on 2026-11-16: Agent Time Machine → Nerve (working name) → Swain.

Status: Proposed r2 (2026-11-16; r2 folds the G0 security design review conditions F11, F17, F20 and F21; see §7). Requires: human approval, G0 security review, and the charter amendment in the design spec §0.
Numbering note: this was requested as "ADR-0003". That number is already taken by `ADR-0003-CLAUDE-CODE-IMPORT-SOURCE.md`, so the Swain ADRs are numbered 0004 to 0008.
Related: ADR-0001 (local-first), ADR-0002 (canonical events), ADR-0005 (model v2), ADR-0006 (ingestion), ADR-0007 (security and tenancy), ADR-0008 (UI and identity), the design spec, the internal audit.

## Context

The offline importer (the `atm` command, formerly Agent Time Machine) imports files offline and renders static HTML. Swain has to receive telemetry continuously from many agents, frameworks and machines. It has to keep the agents, their runs and their relationships, and serve investigation pages to one user or a team. The Swain guarantees to keep are the zero runtime dependencies, the policy-enforced isolation, the hash-only default, the inert HTML and the evidence provenance.

The audit lists the blockers in its §10: L2 (no network code), L3 (synchronous CLI), L4 (blanket identifier bans), L5 (file-only `SourceBytes`), L6 (O(N) file index) and L8 (single-import renderers).

Verified locally on 2026-11-15 (scratchpad probe, Node v24.21.0):
- `node:sqlite` loads without a flag and prints no warning. It exports `DatabaseSync`, `StatementSync`, `Session`, `constants` and `backup`.
- `sqlite_version()` is 3.53.4.
- STRICT tables work and reject REAL in INTEGER columns.
- `json_extract` works.
- FTS5 is compiled in. `journal_mode=wal` works.
- `ON CONFLICT DO NOTHING` works.
- `VACUUM INTO` works.
- `allowExtension: false` makes `loadExtension` throw `ERR_INVALID_STATE`.
- `StatementSync.setReadBigInts(true)` round-trips int64 nanosecond values.
- `enableLoadExtension`, `enableDefensive` and `setAuthorizer` exist.

TBD-RESEARCH: the Node 24 documentation stability level of `node:sqlite`. The author believes it is "1.1 Active development" but did not check. The decision below does not depend on it, because the engine pin is `>=24 <25` and all access goes through one interface.

## Decision

### 1. Process model
- **A new long-running process, `swain serve`.** It is built on `node:http` `createServer` only and has zero runtime dependencies.
- **One process serves three surfaces:**
  - OTLP/HTTP ingestion (`/v1/traces`, `/v1/logs`);
  - native ingestion (`/api/v1/ingest/*`);
  - server-rendered web pages and a small JSON read API.
- **No outbound network from the server.** The server package may import `createServer` from `node:http`, and may not import `request`/`get` from `node:http`/`node:https`, `node:net` or `node:dgram`. Policy-check enforces this (§5).
- **Loopback bind (r2, F7).** The server binds only the literal addresses `127.0.0.1` and `::1`. The exact rules are in ADR-0007 §1. In N1 any other bind is refused. Exposure arrives with team mode.
- **Hardened listener (r2, F17).** Every handler runs inside one wrapper that turns any throw into a static 500. A `clientError` handler answers malformed requests with a static 400 and closes the socket. `server.maxConnections` is set (default 256). Nothing is logged that contains headers, bodies or query strings; ADR-0006 §9 has the full logging rule.
- **Synchronous DB under a write queue.** `DatabaseSync` is synchronous. All writes go through a single in-process write queue, and each request's batch is one transaction. Reads run on the same connection between writes.
  - Trade-off: a large batch blocks the event loop for the duration of its transaction. Batch bounds (ADR-0006 §6) keep that under about 100 ms on commodity hardware; the design spec N1 has a non-gating perf smoke test.
  - A worker-thread DB executor is a later option behind the same interface.

### 2. Storage: SQLite by default, behind an interface
- **The interface.** `@swain/db` exports `interface SwainStore`, a set of repository methods (the design spec §2). Every method that touches tenant data takes a `Scope { orgId, workspaceId?, projectId? }` as its first argument. No method accepts raw SQL from callers.
- **The default implementation** is `SqliteSwainStore` on `node:sqlite` `DatabaseSync`:
  - `PRAGMA journal_mode=WAL`, `foreign_keys=ON`, `busy_timeout=5000`, `trusted_schema=OFF`;
  - defensive mode on;
  - extension loading never enabled: the constructor gets `{ allowExtension: false, enableForeignKeyConstraints: true }`. A local probe verified that `loadExtension` then throws `ERR_INVALID_STATE`.
  - Nanosecond times are bound as `BigInt`, and statements that read them call `setReadBigInts(true)`. The round-trip was verified locally.
- **Database file (r2, F11).** The default path is `$XDG_DATA_HOME/swain/swain.sqlite`, else `~/.local/share/swain/swain.sqlite`. Opening follows this sequence, and **every check runs before the first PRAGMA or statement**:
  1. `swain-bin` sets `process.umask(0o077)` before anything else.
  2. Parent directory: created 0700 if missing. It is checked with `lstat`; it must not be a symlink, must be owned by the current uid, and must not be group- or world-writable. Otherwise `db-permissions`.
  3. DB file: if missing, it is pre-created with `openSync(path, O_CREAT | O_EXCL | O_WRONLY | O_NOFOLLOW, 0o600)` and closed. If present, `lstat` refuses a symlink, and the mode must be exactly 0600 with the current uid as owner; otherwise `db-permissions` (there is no silent chmod of an existing file).
  4. `new DatabaseSync(...)`, then the PRAGMAs.
  5. After WAL is enabled, `-wal` and `-shm` are `lstat`-checked (no symlinks) and chmodded to 0600.
- **Schema integrity on open (r2, F21).** On open, `sqlite_schema` is compared with the expected object set for the applied migration version. Any trigger, view or other unexpected object refuses start with `db-corrupt`.
- **Postgres later.** It would be a second `SwainStore` implementation. Postgres needs either a runtime dependency (a driver) or a hand-written wire-protocol client. Both are out of scope until a human decision, which is recorded as an open question in the design spec. The schema avoids SQLite-only features where cheap: no `WITHOUT ROWID` reliance, JSON stored as TEXT, times as INTEGER nanoseconds or ISO TEXT.
- **Migrations** are versioned, forward-only and non-destructive (the design spec §2.1).
  - Before applying pending migrations, the store snapshots the database. `VACUUM INTO ?` always takes the target path as a **bound parameter**, never interpolated. The target is a temp file `.<random>.tmp` inside the 0700 DB directory, created under umask 077. That file is then `lstat`-checked and copied by the confined writer (`wx | O_NOFOLLOW`, 0600) to `<db>.pre-v<NNNN>.sqlite`, and the temp file is unlinked. `swain db backup <out>` uses the same path.
  - A migration may never contain `DROP`, `DELETE`, `ALTER TABLE … DROP COLUMN`, `ALTER TABLE … RENAME`, `CREATE TRIGGER`, `CREATE VIEW`, `ATTACH` or `DETACH` (r2, F21), or any PRAGMA outside the allowlist `foreign_keys`, `user_version`. A unit test lints the migration SQL text.

### 3. The file store and `atm import` keep working
- **`atm` is unchanged.** Same commands, store, exit codes, outputs and synchronous `runMain`. `atm` never opens a socket. That guarantee stays true for the `atm` binary. Only `swain` gains network commands.
- **`swain` is a superset.** `swain import|sessions|show|explain|report|commands|ui|sources` dispatch to the same `main()` against the same file store, byte-identical.
- **Non-destructive migration.** `swain db import-store [--store DIR]` copies file-store imports into the database:
  - It uses only the existing read path (`openStore().list()` and `.load()`, which re-validate every event).
  - It is idempotent per `importId`, with one transaction per import.
  - It never writes to, locks or deletes anything in the file store. The file store stays readable by `atm` forever.
  - Each import becomes a run of kind `import` (ADR-0005 §4) whose `legacyImportId` keeps the `imp_` ID, so old IDs still resolve (`/r/imp_…` redirects).
- **Native ingestion reuses the pipeline.** The server runs `selectAdapter` and `runImport` on uploaded bytes. Adapter registrations are injected by the CLI composition root, so `@swain/server` does not depend on adapter packages.

### 4. Package and module boundaries

New packages, all `private: true`, ESM, strict TypeScript, tested with `node:test`:

| Package | Role | May import (`@swain/*`) | Builtins (named imports only) |
|---|---|---|---|
| `@swain/model` | Pure v2 types, validators, `deriveSwainId`, the OTLP→model normalizer (GenAI/OpenInference), the relationship-evidence rules, run status computation | `@swain/core` | `node:crypto {createHash}` |
| `@swain/otlp` | Pure OTLP decoding: a bounded JSON decoder and a **hand-written bounded protobuf decoder** for `ExportTraceServiceRequest`/`ExportLogsServiceRequest`, plus the deterministic log projection (ADR-0006 §3) | `@swain/core`, `@swain/model` | none |
| `@swain/db` | `SwainStore` interface plus the SQLite implementation and migrations | `@swain/core`, `@swain/model`, `@swain/report` (type-only) | `node:sqlite {DatabaseSync}`; `node:fs` {`lstatSync, mkdirSync, constants` at the package root; `openSync, closeSync, readSync, writeSync, fstatSync, fsyncSync, unlinkSync, fchmodSync, chmodSync, linkSync` under `sqlite/` only; no `renameSync`} (r2, F11/F20: pre-create by descriptor, the confined backup copy published by hard link); `node:path` (`PATH_NAMES`); `node:crypto {createHash, randomBytes}` |
| `@swain/server` | HTTP routing, auth, rate limits, the write queue, OTLP/native handlers, page composition | `@swain/core`, `@swain/model`, `@swain/otlp`, `@swain/db`, `@swain/report`, `@swain/store` (value imports limited to `buildImportRecord`, `parseImportRecord`) | `node:http {createServer}`; `node:zlib {gunzipSync, constants}`; `node:crypto {createHash, randomBytes, timingSafeEqual}`; `scryptSync` added in N4 |
| `@swain/client` | CLI-side HTTP client, spool and retry. It talks only to the configured Swain URL | `@swain/core`, `@swain/model` | `node:http {request}`, `node:https {request}`; `node:fs` (spool names, as store); `node:path`; `node:crypto {createHash, randomBytes, randomInt}` |
| `@swain/sdk-ts` | TypeScript SDK. It emits standard OTLP/HTTP JSON spans with GenAI attributes and **must stay self-contained** (no `@swain/*` imports) so it can be published alone | none | `node:http {request}`, `node:https {request}`, `node:crypto {randomBytes}`, `node:timers {setTimeout, clearTimeout}` (only under `src/export/**`) |

Changed packages:
- **`@swain/core`** gains a pure `sourceFromBuffer(bytes, displayName, bounds): SourceBytes` in `src/ingest/fs/buffer.ts`. It shares the zstd path with `read.ts`, opens no file, and is not added to `CORE_FS_EXPORTS`. No schema change.
- **`@swain/store`** exports the existing record builder as a pure `buildImportRecord(result, meta, sessionId, nowMs, displayPath)`. Store behavior stays byte-identical, and the existing tests prove it.
- **`@swain/report`** gains:
  - a `brand` render option (default `"Swain"`);
  - exported shell parts (`htmlDoc`, `topBar`, `cardsHtml`, bar quantization);
  - `renderRunPage(RunView)` for multi-part event runs;
  - `renderSpanRunPage(SpanRunView)`.
  Every existing golden stays byte-identical (ADR-0008).
- **`@swain/cli`** gains a second bin, `swain` → `dist/src/swain-bin.js`, with an async `runSwain(argv, io): Promise<number>`. It may import `@swain/server`, `@swain/db` and `@swain/client`. Its `bin.ts` for `atm` is untouched.

### 5. Policy-check rules per package (`tools/policy-check.mjs`)
- **Existing rules unchanged.** All existing global rules (P-IDENT, P-DATE, P-RANDOM, P-PROCESS, P-LOCALE, P-DATELOCAL, P-CTOR, P-DYNIMPORT, P-IMPORTMETA, P-EXT, P-RELATIVE) apply to the new packages unchanged, *except* for the scoped exceptions below. Each exception is a table entry (package, path prefix, identifier), and each one comes with a negative test showing the exception does not leak to another path or package.
- **P-IDENT exceptions:**
  - `sdk-ts/src/export/**`: `setTimeout`, `clearTimeout` (imported from `node:timers`);
  - none elsewhere.
  - `Buffer` stays banned. Code uses `Uint8Array`, and `node:http` chunks are typed as `Uint8Array`.
  - `crypto` (the global) stays banned. Code uses named imports from `node:crypto`.
- **New P-NET rule.** In every package, `node:http`/`node:https`/`node:net`/`node:tls`/`node:dgram`/`node:http2`/`node:child_process`/`node:worker_threads` are violations unless the table allows them. The table allows exactly:
  - `server`: `node:http` {`createServer`};
  - `client` and `sdk-ts`: `{request}` from `node:http`/`node:https`.
- **New P-SQL rule.** `node:sqlite` is allowed only in `db/src/sqlite/**`. Only named `DatabaseSync` is allowed, and `enableLoadExtension`/`loadExtension` property names are banned in every package.
- **New `swain-bin.ts` allowance**, modeled on `bin.ts` and bound to a single `runSwain(...)` call:
  - `process.argv`, `process.exitCode`;
  - `process.stdout`/`process.stderr` as arguments;
  - `process.env.{HOME, XDG_DATA_HOME, XDG_CONFIG_HOME, XDG_STATE_HOME, SWAIN_SERVER_URL, SWAIN_DB, WSL_DISTRO_NAME}` (literal access only; `WSL_DISTRO_NAME` is passed on only as a presence boolean, r2 F19);
  - `Date.now` as a reference;
  - `process.once` with the literal `"SIGINT"`/`"SIGTERM"`, passed as an argument slot;
  - `process.stdin` as an argument (for `swain hook`, N2);
  - (r2, F11/F20) exactly one statement `process.umask(0o077)`, as the first statement of the file, with a literal argument.
- **New P-TLS rule (r2, F20).** In every package, the property name `rejectUnauthorized` and the string `NODE_TLS_REJECT_UNAUTHORIZED` are violations, in any form (property access, object literal key, element access, string literal), so TLS verification can never be disabled.
- **Where these rules land (r2, F20).** The `@swain/db` `openSync` allowance and P-SQL ship with N1.1. The `swain-bin` umask allowance and P-TLS ship with N1.8. Each has negative tests.
- **Clock.** No package other than the two bins reads the clock. The server and client receive `nowMs` by injection. Rate limiting uses lazy token-bucket refill from `nowMs()`, so the server needs no timers.
- **Lockfile check.** `lockfile-check.mjs` `WORKSPACES` and `SWAIN_DEPS` are extended with the new packages and their dependencies exactly as in the table above.

## 7. r2 changes (G0 security design review, 2026-11-16)
- F7: literal loopback bind only (§1, ADR-0007 §1).
- F11: DB pre-create, permission checks before any PRAGMA, WAL/SHM permissions, bound `VACUUM INTO`, confined backups (§2).
- F17: listener hardening (§1).
- F20: rule placement and P-TLS (§5).
- F21: schema integrity on open; migration lint bans triggers, views and `ATTACH` (§2).

## Alternatives considered

| Alternative | Why not |
|---|---|
| Keep the file store and add a server over it | O(N) index rewrite, a single global lock, and no queries across imports (audit L6). Fleet aggregates would need full scans. |
| Postgres as the default | It needs a runtime dependency or a large hand-written protocol client, and a separate service for individual users. That contradicts "zero deps, individual-first". It stays possible behind `SwainStore`. |
| An embedded KV store or a hand-rolled log store | It would reimplement indexes and transactions that SQLite gives for free, which means more hostile-input surface. |
| A third-party HTTP framework | It adds runtime dependencies. `node:http` is enough for about 20 routes. |
| A separate collector process plus a UI process | More moving parts for individuals. The interface split already allows it later. |
| Rewriting the CLI as async everywhere | It churns a reviewed, sync, deterministic CLI. A second bin isolates the async code. |

## Consequences

- The server, client and SDK reintroduce network code. These are new trust boundaries (ADR-0007 §9), and they are confined by P-NET.
- The same Node major version (24) is required by `atm` and `swain`, and `node:sqlite` API drift is contained by `SwainStore`.
- Two binaries and one codebase. Documentation must say that `atm` stays offline and socket-free.
- The DB becomes the primary history for Swain users, while the file store remains a supported import and export format.

## Guarantees changed

| Guarantee (today) | Change |
|---|---|
| "No network, no socket" (MVP guide, policy) | It stays true for `atm` and for every existing package. Narrowed for `swain`: the server listens on loopback by default and never connects out; the client and SDK connect only to the configured Swain URL. |
| "No runtime dependencies" | Unchanged. |
| Determinism of core/adapters/report | Unchanged. The server and client are effectful shells with an injected clock. |
| "Writes only in `@swain/store`" | Extended: `@swain/db` writes the DB file, and `@swain/client` writes the spool. Both are confined by policy. |
