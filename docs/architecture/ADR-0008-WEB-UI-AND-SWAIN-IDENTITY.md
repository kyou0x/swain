# ADR-0008: Web UI, information architecture and Swain identity

Product name changed by the owner on 2026-11-16: Agent Time Machine → Nerve (working name) → Swain.

Status: Proposed r2 (2026-11-16; r2 folds the G0 security design review conditions F6, F10, F15 and F18; see §7). Requires human approval. The rebrand of exports (§6) is a separate, reviewed slice.

## Context
The current viewer (`packages/report/src/render/{html,stream,trace,actions,theme}.ts`) is a dense, dark, no-JS investigation page. It contains a stream, a waterfall, threads per agent, commands, an explanation, a timeline and warnings, for **one** import (`SessionView`). Swain needs fleet-level navigation, while keeping the viewer, the red mark and the style, and it must not become a generic dashboard. Two audit findings constrain the design:
- audit L8: renderers handle exactly one import;
- audit L11: the brand string is hard-coded and pinned by goldens.

## Decision

### 1. Server-rendered HTML that reuses the existing renderers
- **The report package remains the only HTML producer.** It stays pure, and the server only composes and serves its output.
- **New in `@swain/report`:**
  - `RenderOptions.brand?: { name: string; mark: "atm" | "swain" }`. The original default was `{ name: "Agent Time Machine", mark: "atm" }`; since the N6 rebrand the default is `{ name: "Swain", mark: "swain" }` (the `atm` mark is still accepted).
  - `renderRunPage(view: RunView, o)`, where `RunView = { run: RunHeader; parts: readonly SessionView[]; related: readonly EdgeView[] }`.
    - With one part, the `<main>` content is byte-identical to `renderUiSessionPage` for that part; a golden test compares them with the header and nav stripped.
    - With several parts, it concatenates the events in part order: parts are sorted by first valid event time, then arrival. Events keep their per-source `(sourceSequence, subIndex)` order. The page carries the notice "N sources; ordered by first timestamp; not causally ordered" (ADR-0002 §7).
    - It then reuses `buildTrace`, `buildActionLog`, `renderStream`, `renderTrace`, `renderActions` and `explainSession` unchanged. `explainSession` runs per part, and its sections are concatenated under per-source headings, so every statement still cites the event IDs of its own part.
  - `renderSpanRunPage(view: SpanRunView, o)` for runs backed by OTel records. It uses the same shell, top bar, cards, minimap style and 50-step bar classes. It renders:
    - a span waterfall (tree by `parentSpanId`, ordered by start time, "parent not received" group, conflicting duplicates flagged);
    - a span detail block (operation class and its `normBasis`, attributes with content values hidden or hash-only per role, events, links, status, provenance tuple);
    - a tools table and a usage table with labeled computed totals;
    - the related-runs panel.
  - `renderFleetPage`, `renderAgentPage`, `renderRunsListPage` and `renderAuditPage` (N4).
- **CSP.** The single style stays data-independent and hashed. New classes are added to `buildStyle()`, so the CSP hash changes once, in the slice that adds them, and the goldens are regenerated in that reviewed slice.

### 2. Information architecture
```
Top bar:  [mark] Swain / <org> / <workspace> / <project ▾ (links)>            [search by id] [user]
Level 1  Fleet         /o/<org>/w/<ws>/p/<project>            agents table (default view)
Level 2  Agent         /a/<agt>                                runs table + relationships + tools
Level 3  Run           /r/<run>                                existing viewer (events) or span viewer
Level 4  Evidence      /r/<run>/evidence/<batch>/<path>        provenance, hashes, raw (if retained and permitted)
Side     Dependencies  /o/<org>/w/<ws>/p/<project>/graph       agent→agent edges with evidence counts (N3)
         Keys, Members, Retention, Audit  /settings/...         (keys read-only in N1; forms from N2/N4)
```
- **Fleet (not a dashboard).** One dense, sortable table. Sorting is done with server-side `?sort=` links.
  - Columns: agent, key basis, status (active/idle/ended counts), runs (24 h / 7 d), sessions, errors (24 h, with an error-rate badge), top 3 tools, tokens in/out, reported cost estimate (labeled), p50/p95 run duration (only runs with both start and end evidence; "n/a" otherwise), relationships (in/out edge counts), last seen.
  - There are no charts or vanity tiles. Every number links to the filtered runs list that produced it. This keeps the "evidence first" rule: every figure is traceable to rows.
- **Agent page.**
  - A header with identity evidence (`keyBasis`, first and last seen, integrations).
  - The runs table, with filters: status, error, time range, session, all as GET query parameters.
  - Relationships: callers, callees, handoffs and spawns, each with kind, basis and an evidence count that links to an example run and span. Inferred edges are hidden, with a toggle link, and none exist through N3.
  - A tools table and usage over time as a table.
- **Run page.**
  - The existing viewer for event-backed runs; the span viewer for trace runs.
  - Both carry a "Related" strip: same-session runs, parent and child agents' runs (asserted edges only), and conflicting or late data warnings.
  - A provenance line: "verifiable from retained raw body" or "hash-only: verifiable against the sender's copy".
  - **Credentials (r2, F6).** The run header and each part header (one per source or batch group) list the contributing credentials by `keyId` label and pinned agent. When more than one credential contributed to a run, the header shows the persistent notice **"multiple credentials contributed"**, and per-credential counts link to the records each one delivered.
  - Conflicting records from different credentials are shown side by side, labeled "conflicting records from N credentials; none treated as canonical". Cross-credential relationship edges are hidden by default and labeled when shown (ADR-0005 §9).
  - **Kept unknown strings (r2, F15)** are rendered with a "best-effort masked" marker, a CSS class plus visible text, wherever metadata strings outside the pinned key tables are shown.
  - **Synthesized tool requests (r2, F18)** from Claude Code `tool_result` records are labeled "request attested by its result record". A start computed as end minus duration is labeled "derived", and the waterfall draws it with the dashed bar class used for derived values. When it cannot be computed, the start is "n/a".
- **Search.** `GET /search?q=` accepts an exact ID or prefix: `run_`, `agt_`, `imp_`, `ses_`, `evt_`, a 32-hex trace ID, or a 16-hex span ID (with run). This is ID resolution only, not full-text. FTS5 is available (ADR-0004 context) and deferred, because search over content conflicts with the hash-only default.
- **Accessibility.** Tables use `<th scope>`, link text is descriptive, focus outlines are visible, contrast is ≥ 4.5:1 (as theme.ts already states), and there is no information by color alone (status words beside the red/amber chips).

### 3. Navigation and investigation UX
- **Stable URLs** for every object (ADR-0005 §10), plus deep links into a run (`#evt_…`, `/s/<spanId>`). The browser back button and copy-paste work because all state is in the URL.
- **Pivots.** Every agent name, tool name, session and model in a run view links to the corresponding filtered list. For example, a tool links to "runs where this agent called tool X with an error in the last 24 h".
- **Breadcrumbs** always show org › workspace › project › agent › run.
- **Login page (r2, F10).** `GET /login` renders a minimal page in the Swain shell with one POST form and one "Continue" button. No data is shown before the code is consumed.
- **Keyboard.** Plain links and `accesskey` only (`r` refresh, `f` fleet, `a` agent). No JS is used.

### 4. Live updates: explicit refresh, no JS
- **Every page has a "Refresh" link** (same URL plus `?t=<server now>` to bust caches) and shows "as of <server time>".
- **Run pages of `active` runs** offer an opt-in `?live=10`, which adds `<meta http-equiv="refresh" content="10">`. CSP does not restrict meta refresh. Accepted values are 5, 10, 30 and 60, and the option is off by default.
- **Rationale.** No script means no CSP `script-src`, no XSS-to-action escalation, and the existing e2e "no `<script`" assertion keeps holding. Investigation pages are read, not watched.
- **Revisit trigger.** If users need sub-5-second streaming, a later ADR may add one hashed inline script for SSE under `script-src 'sha256-…'` with `connect-src 'self'`. It is not planned.

### 5. Visual identity
- **Theme and mark.** Keep the theme variables (`--bg #0a0a0b`, `--red #ff2d3d`, `--red2 #ff6b78`, the mono and system fonts), the density and the dark scheme. Keep the CSS-only red mark (`.logo` spans): it is reused as the Swain mark, so there is no image asset and `img-src 'none'` stays. A `swain` mark variant may change the geometry slightly but must remain CSS-only and red.
- **Word mark.** "Swain" in the same weight. Subtitles stay technical ("runs", "spans", "evidence"), with no marketing copy.

### 6. Rebrand: binaries, packages, exports
- **CLI.**
  - The new binary `swain` is the superset (ADR-0004 §3).
  - `atm` stays as a supported alias for the offline commands. It is not an alias of the network commands: `atm serve` is a usage error that prints "use swain serve". This keeps "atm never opens a socket" true.
  - Both live in `@swain/cli`. The `swain` USAGE text lists the offline commands under "Offline (same as atm)".
- **Internal packages.**
  - **Keep the `@swain/*` names.** They are private, never published, and baked into policy-check, lockfile-check, tsconfig references and about 700 tests. Renaming would churn every file for no user-visible gain.
  - New packages also use `@swain/*`, except the SDK, whose public package name is decided at its first release, as a human decision listed in the design spec.
- **Data directories.**
  - The file store keeps `agent-time-machine/`, so existing stores keep working.
  - Swain uses `swain/` under XDG data, config and state.
- **Exports** (`atm report`, `atm ui`, `swain report`).
  - They kept the Agent Time Machine brand until the dedicated rebrand slice (the design spec N6). That slice (done 2026-11-16, human-requested) switched the default brand to Swain for every command, including the `atm` alias, and regenerated the goldens in one reviewed change.
  - Exports created earlier are files on disk and are never touched.
- **Docs and README.** They are renamed to Swain in N6, and the old name is kept only as "formerly Agent Time Machine". The PRD wording changes only through an approved charter amendment.

## 7. r2 changes (G0 security design review, 2026-11-16)
- F6: credential lists and the "multiple credentials contributed" notice in run and part headers; conflict display (§2).
- F10: the login page with a POST form (§3).
- F15: the "best-effort masked" marker (§2).
- F18: labels for synthesized requests and derived starts (§2).

## Alternatives considered
| Alternative | Why not |
|---|---|
| A new SPA front end (React or similar) | Runtime and dev dependencies, JS, a larger attack surface, and it discards the reviewed renderers |
| Converting spans into ADR-0002 events to reuse the viewer as-is | Impossible without a schema 0.2 (ADR-0005), and it would misrepresent OTel data |
| A metrics dashboard with charts | The user explicitly asked for no generic dashboard. Tables with pivots are faster to investigate and are evidence-linked |
| Polling with `fetch` | Requires JS |
| Renaming `@swain/*` to `@swain/*` now | Pure churn. Revisit only if the packages are ever published |

## Consequences
- `@swain/report` grows: new pages plus a span renderer. It stays pure, which keeps it testable with string goldens.
- Pages are fast and cacheable but not live. That is acceptable for investigation.
- Two brands coexist until N6. This is documented in the README.

## Guarantees changed
| Guarantee | Change |
|---|---|
| "No JavaScript in outputs" | Kept for exports and for server pages |
| CSP `default-src 'none'` with a hashed style | Kept. Server pages add `form-action 'self'` and `frame-ancestors 'none'` (ADR-0007 §5) |
| Byte-stable exports | Kept for `atm`. `swain` exports change once in N6 |
