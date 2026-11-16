# ADR-0007: Security and tenancy model

Status: Proposed r2 (2026-11-16; r2 folds the G0 security design review conditions F7 to F12, F16, F19, F20, F22 and F24 to F26; see §11). G0 result: PASS-WITH-CONDITIONS. Requires: human approval, an independent security review (G3) before team mode ships, and amendments to `docs/security/SECURITY-REQUIREMENTS.md` and `THREAT-MODEL.md`. Those amendments are proposals: the requirement texts are in the design spec §7 and the threat-model delta in §9 below. Following the repository convention (proposals live in plans, specs and ADRs, as P0-PLAN §3 did for S13 to S15), they are merged into `docs/security/` by a separate, human-approved docs change, not by this ADR.
Research: `docs/research/SWAIN-OTEL-FRAMEWORKS.md` (OTF) and `docs/research/SWAIN-CLAUDE-CODE-TELEMETRY.md` (CC-T).

## Context
Swain's security posture rests on four properties: no network, local files, inert static HTML, and hash-only content. Swain adds a listening server, credentials, a browser session and several users. That changes the trust boundaries (THREAT-MODEL boundaries 1 to 6), and the ADR-0002 §10 conditions for "sharing" now apply (audit L14).

## Decision

### 1. Network exposure
- **Exact loopback bind (r2, F7).**
  - `swain serve` binds **only the literal addresses `127.0.0.1` and `::1`**, port 4318 by default (the OTLP/HTTP default, OTF §2).
  - Before N4, `--host` accepts exactly those two literals. Everything else is rejected with exit 2 `bind-not-loopback`, before any socket is opened: `localhost` (a name, resolved by the OS), `0.0.0.0`, `::`, `::ffff:127.0.0.1`, any other 127.0.0.0/8 address, and any name.
  - After `listen`, the server asserts `server.address()` equals the requested literal and port, and exits 1 otherwise.
  - A test covers the default with `--host` omitted.
- **Both families by default (r2, F7).** Without `--host`, the server binds `127.0.0.1:<port>` **and** `[::1]:<port>`, so that no other local process can take the other family's port and receive keys from exporters configured with `localhost`.
  - If `::1` is unavailable (IPv6 disabled, `EADDRNOTAVAIL`), the server continues on IPv4 and `swain status` warns.
  - If either address is already in use (`EADDRINUSE`), the server refuses to start (exit 7 `port-held`), naming the family.
  - `--host 127.0.0.1` alone binds one family and makes `swain status` check and warn when the other family's port is held by another process.
- **Literal IPs only.** Every printed or configured URL uses a literal IP: `swain connect`, `swain open` and `swain status` print `http://127.0.0.1:<port>`, never `localhost`.
- **Team mode (N4)** allows `--host <addr>` only when both of the following hold:
  1. TLS is configured (`--tls-cert`, `--tls-key`, served with `node:https` `createServer`; P-NET adds that name for `server` in N4), or `--behind-proxy` is set together with `--public-url https://…`, and the server then requires `X-Forwarded-Proto: https` from the configured `--trusted-proxy` address only;
  2. team mode is initialized (at least one owner user exists).
- **Host header allowlist (r2, F7; DNS-rebinding defense)**, in every mode.
  - The match is exact and case-insensitive against:
    - local mode: `127.0.0.1:<port>`, `[::1]:<port>`, `localhost:<port>`;
    - team mode: the host of `--public-url`.
    `localhost` is accepted in the Host header only, never for binding, because browsers send it when users type it.
  - Rejected with 421 before routing: a missing `Host`, a Host with a trailing dot (`localhost.:4318`), a Host without the port, a duplicated Host header, and an absolute-form request target (`GET http://evil/...`, rejected as 400).
- **No outbound connections, ever.** The server sends no telemetry, makes no update checks and calls no LLM (P-NET, P-TLS).
- **WSL2 (r2, F19).** On WSL2, loopback listeners may be reachable from the Windows host (localhost forwarding), and in mirrored networking mode from the Windows host's network view. `swain serve` detects WSL from the presence of the `WSL_DISTRO_NAME` environment variable, which `swain-bin` reads as a literal env key and injects as a boolean; no file is read. It then prints a static warning, and the threat model records the residual (§9, T-N14).

### 2. Modes
| | Local single-user (default) | Team (N4) |
|---|---|---|
| Users | an implicit `local-owner` | named users with passwords (scrypt N=2^15, r=8, p=1, 16-byte salt, through `node:crypto` `scryptSync`); OIDC is a later ADR |
| Web login | **none by default** (owner decision 2026-11-16, below); opt-in one-time login code with `swain serve --require-login` | username + password, then the same session mechanism |
| Org/workspace | `local` / `default` (multiple projects allowed) | many orgs, workspaces and projects |
| Who may administer | anyone who can open the DB file (the filesystem owner) through `swain admin …` | owner/admin roles in the UI, plus DB-file holders |

**Owner decision, 2026-11-16: no web login by default.** The product owner said: "não precisa ter login, não quero". In local mode the pages (`/`, `/a/:id`, `/runs`, `/r/:id`) therefore need no session, no login code and no CSRF form, and the page chrome has no sign-in or sign-out control. `/login` and `/logout` return 404. The server option is `webAuth: "none" | "login"`, default `"none"`; `swain serve --require-login` selects `"login"` and restores exactly the behaviour described in the rest of this section and in §5, for shared hosts. The reviewed login code is gated, not deleted. Ingest authentication (keys), the server-proof and the owner proof are unchanged.
- **Protections that do not depend on login and stay in force:** loopback-only literal bind; the Host allowlist restricted to the bound families (this is the DNS-rebinding defence and, without login, the main barrier: any other Host gets 421 before any page is rendered); socket-derived origin proofs; no CORS headers (so another origin cannot read a response); CSP with `frame-ancestors 'none'`, `X-Frame-Options: DENY`, COOP and CORP `same-origin`, `nosniff`, `no-referrer`, `no-store`; ID regex validation and output escaping.
- **New refusal in no-auth mode.** A `GET` page or data request that carries `Sec-Fetch-Site: cross-site` or `same-site` gets 403, unless it is a top-level navigation (`Sec-Fetch-Mode: navigate` and `Sec-Fetch-Dest: document`, whose response the navigating site cannot read). Any other or duplicated `Sec-Fetch-Site` value is refused. `GET /api/v1/status` keeps its key and additionally requires `Sec-Fetch-Site` to be `same-origin`, `none` or absent (non-browser clients such as `swain status` send none); it has no navigation exception. A cookie is not a credential in this mode.
- **Residual risk, accepted by the owner.** Any local process, and any other local OS user, on this machine can read the pages over loopback. The pages show exporter-supplied metadata strings (agent and span names, attribute values, resource values), which may include PII or secrets and are masked best effort only, and inline content for projects whose content policy is `inline`; for hash-only projects content is shown as a hash. Nothing here is guaranteed free of sensitive data. A browser on this machine can navigate to the pages. DNS rebinding is blocked by the Host allowlist. Cross-site reads are blocked by the same-origin policy (no CORS, CORP `same-origin`) and, for browsers that send Fetch Metadata, by the Sec-Fetch rule above. Browsers that do not send Fetch Metadata are not refused by that rule: their requests are still processed, and only the same-origin policy plus CORP stop a cross-site page from reading the response. A same-machine web app on another port in the same browser can issue a plain request but cannot read the response cross-origin. Hosts with other users should run `swain serve --require-login`.
- **`swain open` in this mode** finds the server (no runtime file: exit 8, no output, no fallback to 4318), checks `/healthz`, and verifies the **owner proof** of ADR-0006 §8 exactly as in the login flow (security review F1: a squatter of a stale runtime file's port must not send the user to forged pages). On a failed proof it exits 8 and prints nothing. It then prints the plain URL (`http://127.0.0.1:<port>/`, `/a/<id>`, `/r/<id>`) and creates no login code. The mode is read from `GET /healthz` (`{"ok":true,"webAuth":"none"|"login"}`) after the proof; anything other than an explicit `"none"` keeps the code flow. The page server also caps page renders per server (token bucket, burst 60, 30 per second, 429 beyond it) and `server.start` audits the `webAuth` mode.

**Local login code with `--require-login` (r2, F10).**
- **Creation.** `swain open [target]` generates a 32-byte random code. It stores `sha256(code)` together with the **server-side `next_path`** (the resolved target, validated against the route table), a 60 s expiry, and single use. It prints `http://127.0.0.1:<port>/login?code=<code>`. There is no `next` parameter in the URL.
- **Owner proof before creation (G3-auth B2).** Before it stores a code or prints a URL, `swain open` finds the server (no runtime file: not running, exit 8; no fallback to 4318), checks `/healthz`, and verifies the **owner proof** of ADR-0006 §8 (`purpose:"owner"`, `ownerKey = HMAC(client_proof, lp("swain:v1:owner-proof-key"))`, answer `HMAC(ownerKey, lp("swain:v1:owner-proof") ‖ lp(origin) ‖ lp(instanceId) ‖ lp(challenge))`). A failed or stale proof exits 8 and prints nothing. **Residual:** the check happens when the command runs, while the URL is pasted later; a crash plus a squat of the port inside the 60 s window would still receive the (single-use) code.
- **`GET /login?code=…`** consumes **nothing**. It returns a page with a single POST form (hidden `code` field, one "Continue" button). `Cache-Control: no-store`, `Referrer-Policy: no-referrer`. This keeps link prefetchers, previewers and browser preloading from burning or using the code.
- **`POST /login`** consumes the code atomically: the update succeeds only if the code is unused and unexpired. It sets the session cookie and redirects (303) to the stored `next_path`. Any `next` value in the request is ignored. A failed attempt counts against the global unauthenticated bucket (ADR-0006 §5a).
  - CSRF on this form: the request must carry `Origin` (or `Sec-Fetch-Site: same-origin`) matching the allowlist. The code itself is the secret, and there is no session yet.
- **Logging.** URLs, including query strings, are never logged (ADR-0006 §9).
- **Pasting versus launching.** The docs recommend **pasting the printed URL** into the browser rather than running `xdg-open <url>`. A launched browser process carries the URL in its argv, which other local users can read in `/proc/*/cmdline` within the 60 s window. That is also why N-Q4 chose print-only.
- **Other OS users.** They can reach loopback, but hold no code and cannot read the 0600 DB, so they cannot log in.

**Session cookie (r2, F9).**
- `swain_session=<32 random bytes, base64url>`; `HttpOnly; SameSite=Strict; Path=/`; **host-only** (no `Domain` attribute); `Secure` in team/TLS mode.
- The server stores only `sha256(token)`.
- Lifetime: local mode, **2 h idle** and 24 h absolute; team mode, 12 h idle and 7 d absolute. Sessions are revocable (`swain admin sessions revoke`, or logout).
- **Cross-port residual (r2, F9).** Cookies are not isolated by port. Any other web application served on `127.0.0.1` at any port, in the same browser, receives `swain_session` on its own requests to `127.0.0.1`, and a malicious local web app could read it. Mitigations:
  - the shorter local idle lifetime;
  - `SameSite=Strict`, which stops cross-site sends but not same-site cross-port reads by the other app;
  - the full-origin CSRF check (§5).
  - The residual is documented as T-N4b.

### 3. Org isolation enforced in storage
- **Every tenant table** has `org_id` as the leading primary-key or index column. Project-scoped tables also carry `project_id`.
- **Scope.** Every repository method requires a `Scope`. **Project-scoped methods require `projectId`** in the type (`Required<Scope>`), not optionally (r2, F12).
- **Statement registry and tenant lint (r2, F12).** All SQL is declared in one registry (`db/src/sqlite/statements.ts`), and each entry is tagged `tenant: true|false`. A unit test parses every statement with a small SQL tokenizer (no regex over raw text) and fails unless:
  1. **every table alias** that refers to a tenant table is constrained by `<alias>.org_id = :orgId` (and `<alias>.project_id = :projectId` for project-scoped tables) in the `WHERE` or `ON` clause, including subqueries and joins;
  2. there is **no unparenthesized top-level `OR`** in a `WHERE` clause;
  3. writes set `org_id` and `project_id` from bound scope parameters, never from input fields;
  4. there is **no interpolation**: sort columns, directions and status filters are chosen from closed maps of complete statement variants, and every value is a bound parameter;
  5. every `LIKE` uses `ESCAPE '\'`, with input escaped by the one helper `likePattern()`.
- **`tenant: false` is a closed allowlist** in the test file, and adding an entry needs review: migrations, `schema_migrations`, `server_secrets`, `findKey` by `keyId`, login-code and session lookup by token hash, and the `orgs` bootstrap.
- **Runtime row-scope assertion.** Every row read from a tenant statement passes `assertRowScope(row, scope)`, which checks that `org_id` (and `project_id`) equal the scope. A mismatch throws `db-scope-violation` (500, audited). This is defense in depth behind the lint.
- **Cross-project reads** inside an org also require `project_id IN (:allowedProjects)`, computed from memberships (N4).
- **Isolation tests** (integration):
  - two orgs, and two projects inside one org, with colliding slugs, trace IDs, span IDs, session IDs, agent keys and import IDs;
  - for every read API and page, data from the other org **or project** is never returned, and its IDs return 404.
- **Gate (r2, F20).** The tenant lint and the isolation tests pass **before any read API or page is wired** (the design spec §6 gates).
- **IDs are not secrets.** Authorization never relies on an ID being unguessable.

### 4. RBAC (N4; local mode is equivalent to owner)

| Permission | owner | admin | member | viewer |
|---|---|---|---|---|
| View fleet, agents, runs (metadata) | yes | yes | yes | yes |
| View content (inline `ContentRef`, retained raw bodies) | yes | yes | yes, if the project grants `content:read` to members | no |
| View content hashes and exact byte lengths | yes | yes | with `content:read` | no (hidden; lengths bucketed, §6) |
| Create and revoke ingest keys for a project | yes | yes | no | no |
| Change project content policy or raw retention | yes | yes (audited, and requires re-authentication) | no | no |
| Create projects and workspaces | yes | yes | no | no |
| Manage members and roles | yes | yes (cannot grant owner) | no | no |
| Retention apply / tombstone | yes | yes | no | no |
| View the audit log | yes | yes | no | no |
| Delete the org, transfer ownership | yes | no | no | no |

Roles are per org. Project-level grants (`content:read`) are flags on the project. They are evaluated in one pure function, `can(principal, action, resource)` in `@swain/model`, with a table-driven test of every cell.

### 5. CSRF and CSP
- **Pages are server-rendered with no JavaScript.** This keeps the existing guarantee and the existing e2e assertions. Interactions are links, `GET` forms for filters, and `POST` forms for mutations.
  - Rationale: the attack surface stays minimal, and pages are testable as strings. The existing renderers are already no-JS.
  - Live updates come from an explicit refresh (ADR-0008 §4).
- **CSP** on every HTML response, sent as a header *and* as a meta tag. The meta tag is kept so that files saved from the browser are still inert:
  `default-src 'none'; style-src 'sha256-<hash>'; img-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`.
  - The only change from exports is `form-action 'self'`, required for POST forms. Static exports keep `form-action 'none'`.
- **Other headers:** `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Resource-Policy: same-origin`, `Cache-Control: no-store` on authenticated pages.
- **CSRF protection for every state-changing request** (r2, F9/F22). This includes `POST /logout`, which ships in N1, so CSRF tokens are needed from N1:
  - `POST` only;
  - `SameSite=Strict`, host-only cookie;
  - a synchronizer token, `csrf = HMAC-SHA256(serverSecret, lp("swain:v1:csrf") ‖ lp(sessionIdHash) ‖ lp(formId))`, with length-prefixed components (r2, F22), sent in a hidden field and compared with `timingSafeEqual`;
  - the **full origin, including scheme and port**, must match: `Origin` must equal `http://127.0.0.1:<port>` (or the other allowlisted origins), or `Sec-Fetch-Site` must be `same-origin`. A missing `Origin` together with a missing `Sec-Fetch-Site` is rejected.
  - Any failure gets 403 `csrf`. `serverSecret` is **32 random bytes generated per server process, kept in memory only** (amended after G3-auth F5, by design). A restart invalidates only the forms that are open in a browser at that moment: the user reloads the page and gets a new token. It is deliberately not stored in the DB `server_secrets` table, so a database copy, a backup or a leaked file cannot be used to forge a CSRF token. The session itself (stored as a hash) survives restarts.
  - The login POST has no session yet and therefore no session-bound token. It is protected by the full-origin check (`Origin`, or `Sec-Fetch-Site: same-origin`) alone, as in §2; the single-use code is the secret.
- **JSON read API** (`/api/v1/*` GET, r2, F9/F22).
  - With a session cookie, it requires `Sec-Fetch-Site: same-origin`. A **missing** `Sec-Fetch-Site` is rejected (403), so non-browser clients cannot use cookies.
  - With a key, only `/api/v1/status` is available, with `read:status` or any `ingest:` scope. There is no `read:*` scope.
  - No CORS headers are ever sent.

### 6. Redaction and opt-in content capture
- **Project content policy:** `contentPolicy: "hash-only" (default) | "inline"`, `maxInlineContentBytes` (≤ 1 MiB), `rawRetention: "hash-only" (default) | "full"`, `metadataPolicy: "keep-short" (default, N-Q3) | "allowlist"` (r2, F15). Changes are audited and apply to future ingests only. Nothing is re-derived silently.
- **`rawRetention: full` warning (r2, F22).** The setting command and the UI print that retained raw bodies contain **everything the sender sent**, including content the receiver policy would otherwise hash. The run view carries a persistent "raw bodies retained" label.
- **Applied at the receiver** (ADR-0005 §6), regardless of what the sender sends.
- **Connector defaults.** `swain connect` prints a placeholder or a credential-file reference instead of the key unless `--show-secret` is given (r2, F16, ADR-0006 §8.1). It never enables sender content flags by default. For Claude Code, `OTEL_LOG_USER_PROMPTS`, `OTEL_LOG_ASSISTANT_RESPONSES`, `OTEL_LOG_TOOL_DETAILS`, `OTEL_LOG_TOOL_CONTENT` and `OTEL_LOG_RAW_API_BODIES` stay unset unless the user passes `--with-content`, and the printed config warns about them (CC-T §1).
- **Masking.** Inline content and metadata strings pass `redactText`. It is labeled best-effort everywhere (S3).
- **ADR-0002 §10 sharing conditions (D-14 hash oracle).**
  - Users without `content:read` never see content hashes, and they see byte lengths bucketed to powers of two.
  - Exports from the server (HTML/JSON/MD downloads, N4) include hashes only for users with `content:read`, and carry the existing "hashes allow confirmation of guessed content" notice.
  - Keyed hashes are **not** introduced: the stored hashes must stay plain SHA-256 to remain verifiable against source bytes.
  - These conditions plus a fresh G3 review gate team mode.

### 7. Retention (explicit, non-destructive by default)
- **Policies** are per project and per data class: `raw-bodies`, `content`, `l1-records`, `runs`. Each has `keepDays | null` (null = forever, the default) and `mode: "report" | "apply"` (default `report`).
- **No timers or background jobs.** `swain retention plan [--project P]` prints what would be removed. `swain retention apply --project P --class C --confirm <planHash>` executes a reviewed plan. The server never runs retention by itself.
- **Order of removal:**
  1. raw bodies are nulled (the `ingest_batches` row and hashes stay);
  2. inline content is downgraded to hash-only (the `ContentRef` keeps `sha256`/`byteLength`);
  3. L1/L2 rows are removed only for `l1-records`/`runs`, leaving a `tombstones` row (`runId`, counts, plan hash, time, actor).
- **Audit and backup.** Each apply writes an audit entry. A `VACUUM INTO` backup is taken first unless `--no-backup` is set, which is itself audited.
- Migrations never delete anything (ADR-0004 §2). Retention is the only deletion path.

### 8. Audit log
- **Table** `audit_log(org_id, seq, at, actor_type, actor_id, action, target_type, target_id, detail_json, prev_hash, hash)`:
  - append-only;
  - `hash = sha256(lp("swain:v1:audit") ‖ lp(prev_hash) ‖ lp(canonicalJson(entry without hash)))`, chained per org, with length-prefixed components (r2, F22);
  - `swain admin audit verify` recomputes the chain.
  - Tamper evidence holds against accidental or partial edits, not against a DB-file holder who rewrites the whole chain. This limitation is documented.
- **Actions (closed list):** `key.create`, `key.revoke`, `login.success`, `login.failure` (rate-limited, aggregated per minute), `session.revoke`, `project.create`, `project.policy.change`, `member.add`, `member.role.change`, `member.remove`, `retention.apply`, `db.import-store`, `db.migrate`, `server.start` (with bind address), `ingest.rejected` (aggregated per key per minute).
- `detail_json` holds static codes and IDs only. It never contains secrets, content or untrusted free text; names are bounded and escaped at render time.

### 9. Threat model delta (proposal; to merge into `THREAT-MODEL.md` after approval)
| # | New surface | Threats | Mitigations |
|---|---|---|---|
| T-N1 | HTTP listener | Remote access when exposed by mistake; bind to a name or wildcard; DNS rebinding; slowloris; request smuggling; unauthenticated resource exhaustion | Literal-loopback bind only, with `server.address()` asserted and both families held (§1, F7); exact Host allowlist, rejecting a trailing dot, a missing Host and absolute-form targets; auth before body and slots (ADR-0006 §5a, F1); global unauthenticated bucket; `headersTimeout`/`requestTimeout`/`maxConnections`; `clientError` handler; `node:http` parser defaults; body caps |
| T-N2 | Protobuf/JSON/gzip decoders | Memory or CPU exhaustion, decompression bombs, parser bugs, integer overflow, encoding disagreement | ADR-0006 §3/§6 bounds, BigInt lengths, duplicate-field and oneof rejection, a 1M value budget, length checks before allocation, fuzzing (≥ 1M structure-aware runs), G3-proto before wiring |
| T-N3 | Ingest keys | Theft (env files, shell history, settings.json, argv, `/proc`), brute force, replay, **delivery to a squatting listener** | Hashed at rest; shown once; Bearer header only; never in argv; revocable; global 401 bucket; scope pins and agent pins by default (F6); credential files 0600 in a 0700 dir, origin-pinned (F8, F16); the client authenticates the server by HMAC before sending a key (F8); both families held. **Residual (F8):** third-party exporters cannot authenticate the server, so **on a shared host loopback is not a confidentiality boundary** for keys sent by such exporters. A process that wins the port before `swain serve` starts receives them |
| T-N4 | Browser session | CSRF, session theft, clickjacking, XSS via telemetry, login-code leakage | `SameSite=Strict`, host-only, HttpOnly; full-origin CSRF check including the port; `Sec-Fetch-Site` required for cookie JSON (F9); `frame-ancestors 'none'`; no JS; hashed-style CSP; escaping (S5); login code consumed only by POST, with a server-side `next_path`, never logged, pasted rather than launched (F10) |
| T-N4b | Cross-port cookies (F9) | Another web app on `127.0.0.1:<other port>`, in the same browser, receives or reads `swain_session` | Shorter local session lifetime (2 h idle); documented residual; team mode uses its own hostname and TLS |
| T-N5 | Multi-tenant DB | Cross-org or cross-project reads through a missing or OR-widened filter, interpolation, `LIKE` wildcards | Statement-registry tenant lint (F12), runtime row-scope assertion, cross-project isolation tests, 404-not-403 |
| T-N6 | Content captured by senders | Prompts or secrets stored despite the hash-only intent | Receiver-side policy on every field and every path (ADR-0005 §6, F2/F3); secret-name and URL rules; extended masker (F15); optional `metadataPolicy: allowlist`. Residual: secrets in short metadata strings outside the lists, including 16/32/64-hex or UUID-shaped secrets that are exempt from the entropy heuristic (masked best-effort, labeled). The three-character-class entropy rule never masks pure-hex or lowercase-alphanumeric tokens of ANY length (for example a 40-character hex or a 30-character lowercase-alphanumeric secret). Home paths and personal data (names, emails, usernames) in kept metadata are stored best-effort-masked only: N1.6 renderers must mask home-directory prefixes at display, and the UI keeps the "best-effort masked" label. Keys are budgeted and replaced by placeholders beyond the cap (ADR-0005 §6.2), so keys cannot carry bulk plaintext |
| T-N7 | Spoofed telemetry | A key holder forges agent names, handoffs or causality, or poisons another credential's runs | Edges only from asserted fields with their basis; namespaced agent keys (F5); pinned keys by default; `keyId` on every L1 row; cross-credential edges excluded by default and labeled; conflicting records from different keys are never canonical; run headers list contributing credentials (F6) |
| T-N8 | Hook forwarder (`swain hook`, N2) | Blocking the host agent; unbounded stdin; spool tampering; following payload paths | Async hook, 2 s timeout, 1 MiB stdin cap, 0700 spool with caps and purge (F23); payload paths are never opened by the client or the server |
| T-N9 | `swain connect --write` (N2) | Corrupting user settings; persisted misconfiguration; plaintext keys in `settings.json` | Dry run by default, explicit `--write`, backup, a minimal merge of owned `env` keys only, `--undo`, refusal of symlinked or unparseable files; `otelHeadersHelper` preferred; warning on group- or world-readable settings (F16); tests use a temp `HOME` only |
| T-N10 | Hash oracle on shared views | Confirming guessed content | §6; N4 preconditions §10 |
| T-N11 | Audit log | Repudiation, tampering | Length-prefixed hash chain. Limitation: a DB-file holder can rewrite the whole chain |
| T-N12 | Self-hosted operators | Running exposed without TLS | Refusal rule §1; `swain status` warns |
| T-N13 | **Observed agents running as the same OS user** (F19) | An agent Swain observes (Claude Code, an SDK app) runs as the user's uid. It can read the DB, credential files, spool and `settings.json`, rewrite evidence, forge audit entries and recompute the hash chain, or stop the server | Not preventable by file permissions; the audit chain does **not** prevent it. Documented prominently. Users who need tamper resistance must run `swain serve` as a different OS user, or on another host in team mode with TLS, and give observed agents only ingest keys |
| T-N14 | **WSL2 networking** (F19) | With localhost forwarding or mirrored networking, a loopback listener inside WSL2 can be reachable from the Windows host and, in mirrored mode, may follow Windows firewall rules | Static warning on WSL detection (§1); docs explain `.wslconfig` settings; the exact reachability matrix is UNVERIFIED and must be checked by a human on a WSL2 machine before Swain claims anything about it |
| T-N15 | Server impersonation toward Swain's own client (F8) | A process on the other address family, or a stale-port squatter, collects keys from `swain push`/`hook` | Server-proof HMAC bound to origin and `instanceId`; origin-pinned credentials; refusal and spooling on failure |
| T-N16 | Logs | Secrets or codes in logs | No access log; no URLs, query strings, headers or bodies logged (F17) |

### 10. Preconditions for N4 (team mode), from G0 F24 to F26
These must be resolved by an ADR amendment and a G3 review **before N4 starts**. They do not block N1 to N3.
- **F24, completeness of hash hiding.** Inventory every surface that can reveal a content hash or exact length to a user without `content:read`: pages, JSON API, exports, evidence pages, error messages, search results, `ETag`s, sort orders by length, response sizes. Each one must be hidden or bucketed, or the residual must be documented.
- **F25, dedup oracle.** Batch, span, log and import dedup responses (`unchanged`, `identical-same-key`/`identical-other-key` sightings, `idempotency-conflict`, `exists`, timing) must not let one credential or user learn whether another already submitted a given body or record. Partially addressed by keying batch dedup on `keyId` (ADR-0006 §4); a full analysis is needed for spans, logs and imports.
- **F26, RBAC and operational gaps.**
  - RBAC matrix gaps: per-workspace roles, key ownership versus project admin, viewing the audit log of a deleted project, member removal versus their keys and sessions.
  - `scryptSync` `maxmem` set explicitly, and login CPU limits.
  - Trusted-proxy hop handling: exactly one hop; `X-Forwarded-For` parsed from the right, from the trusted address only.
  - Retention completeness for backups, `-wal` files and SQLite free pages: whether `secure_delete` or `VACUUM` is needed after an apply, and how `*.pre-v*.sqlite` backups are listed and retired.

### 11. r2 changes (G0 security design review, 2026-11-16)
- F7: literal loopback bind, both families, exact Host matching, WSL2 warning (§1).
- F9: host-only cookie, shorter local lifetime, full-origin CSRF, `Sec-Fetch-Site` required for cookie JSON, cross-port residual (§2, §5).
- F10: login code consumed by POST only, server-side `next_path`, no URL logging, paste instead of `xdg-open` (§2).
- F12: tenant lint rules, required `projectId`, closed `tenant:false` list, runtime row assertion, cross-project tests, gate (§3).
- F16: placeholder printing, credential files (§6, ADR-0006 §8.1).
- F19: same-uid agents and WSL2 added to the threat delta (§9).
- F20: gate placement (§3, the design spec §6).
- F22: CSRF on logout, closed scopes, length-prefixed HMAC and audit inputs, raw-retention warning (§5, §6, §8).
- F24 to F26: N4 preconditions (§10).

### 12. Owner decision, 2026-11-16: pages open by default
See §2. The login, session and CSRF design of §2 and §5 applies only with `swain serve --require-login`.

## Alternatives considered
| Alternative | Why not |
|---|---|
| No auth in local mode (loopback is enough) | Other local users, and browser-based attacks (DNS rebinding, CSRF), can reach loopback |
| A JS single-page UI with a token in localStorage | XSS-to-token theft, a larger CSP surface, and it breaks the no-JS guarantee |
| Keyed (HMAC) content hashes | Loses verifiability against source bytes. Hiding hashes per role achieves the D-14 goal without that loss |
| Automatic retention timers | Silent deletion of evidence. An explicit plan and apply is auditable |
| OIDC in N4 | It needs outbound calls to the IdP, which conflicts with "never connects out". It gets a later ADR |

## Consequences
- Local mode adds one step (`swain open` gives a login link), which is the price of keeping loopback safe.
- Team mode is strictly gated behind TLS, owner bootstrap and a fresh G3 review.
- `SECURITY-REQUIREMENTS.md` gains proposed S16 to S27 and an S15 amendment (wording in the design spec §7, renumbered in r2 because P0-PLAN §3 already proposes S13 to S15), which need human approval.

## Guarantees changed
| Guarantee | Change |
|---|---|
| S2 "Default capture remains local" | Data goes to a local or self-hosted Swain the user configured, and never to a third party. Default bind is loopback |
| "Offline by default; no network telemetry" | The server listens; nothing connects out. `atm` stays fully offline |
| HTML CSP `form-action 'none'` | Server pages use `form-action 'self'`. Exports are unchanged |
| D-14 accepted residual for P0 only | Replaced by the role-based hash visibility in §6 for team mode |
