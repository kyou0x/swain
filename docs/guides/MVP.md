# Swain MVP: worked example

From a clean clone to a generated UI, using the synthetic fixtures in this repository. Everything runs
offline. Nothing is uploaded, no server is started, and no provider directory is read unless you pass
its path to `swain import`.

Requires Node.js 24.

## 1. Build

```sh
npm ci --ignore-scripts && npm run build
```

Run the CLI as `node packages/cli/dist/src/bin.js` (or `npm run -s swain -- <args>`). Below, `swain` stands
for either form; `atm` is kept as an alias. Use `--store DIR` to keep this tryout separate from your real store (the default is
`$XDG_DATA_HOME/swain`, else `~/.local/share/swain`; if only the legacy `agent-time-machine` directory exists, it is used and a
notice is printed once on stderr. Nothing is moved, copied or deleted):

```sh
alias swain='node packages/cli/dist/src/bin.js --store /tmp/atm-demo'
swain --version
```

```
swain 0.0.0
canonical-schema 0.1.0
```

## 2. Import

The adapter is detected automatically from the file contents. Several files and directories can be given.

```sh
swain import fixtures/codex-cli/synthetic-mvp/rollout-legacy-golden.jsonl \
           fixtures/gemini-cli/synthetic-mvp/session-golden.jsonl \
           fixtures/opencode/synthetic-mvp/export-golden.json \
           fixtures/claude-code/synthetic-mvp/transcript-golden.jsonl
```

```
added      imp_4a662a9a9859  codex-cli.rollout-jsonl  fixtures/codex-cli/synthetic-mvp/rollout-legacy-golden.jsonl
           complete: 12 events, 0 gaps, 0 unknown records, 2 warnings  [experimental] [undocumented] [untested-provider-version]
added      imp_c70af5b54e07  opencode.session-export  fixtures/opencode/synthetic-mvp/export-golden.json
           partial: 26 events, 2 gaps, 1 unknown record, 14 warnings  [experimental] [untested-provider-version]
...
4 files: 4 added, 0 unchanged, 0 replaced, 0 skipped (adapter version), 0 rejected.
note: these adapters are experimental. They were built from documentation and source research,
      not verified against real provider files; unrecognised records are kept as source.unknown.
note: content is stored as hashes only. Use --include-content to keep (best-effort masked) text.
```

How to read it:

- The labels `[experimental]`, `[undocumented]` and `[internal-unstable]` describe how trustworthy the
  source format is. `[untested-provider-version]` means no provider version has been verified yet, which
  is true for every adapter today.
- "gaps" are places where the source shows something should exist but it was not observed (for example a
  tool request without a result). "unknown records" are records the adapter did not recognise; they are
  kept, not dropped.
- Exit code 3 means "imported, but with gaps or unknown records". Other codes: 0 ok, 2 usage, 4 input
  rejected (no adapter matched, too large, not a regular file), 5 output refused, 6 ID not found,
  7 store error (lock, corruption, symlink).
- Re-running the same import prints `unchanged`. A new adapter version is skipped until you pass
  `--reimport`.
- Import stores hashes and sizes only. `--include-content` keeps text, masked on a best-effort basis
  (masking is not a guarantee), so treat such a store as sensitive.

## 3. List, show, explain

```sh
swain sessions            # alias: swain list; filters: --provider P --outcome O; --json
```

```
ID                PROVIDER     SOURCE KIND                   OUTCOME   EVENTS  GAPS  FIRST EVENT               FILE
imp_4a662a9a9859  codex-cli    codex-cli.rollout-jsonl       complete  12      0     2026-11-15T09:00:00.000Z  rollout-legacy-golden.jsonl
imp_c70af5b54e07  opencode     opencode.session-export       partial   26      2     2026-09-21T14:13:20.000Z  export-golden.json
```

An ID can be abbreviated to `imp_` plus at least six hex characters.

```sh
swain show imp_c70af5 --limit 5      # event timeline; --json for machine output
swain explain imp_c70af5             # plain-text explanation
```

```
Tools
  - 6 tool requests were recorded across 6 distinct tools. A request records an attempt, not an observed execution.  [evt_2b4d9e0a, evt_fb36c0f3, evt_a339ba88, +3 more]
  - Tool glob: requested 1, completed 0, failed 0, outcome not observed 1.  [evt_eab2a04e, evt_8bd79189]
  - Interpretation: 2 tool requests have no observed result at the end of the source; ...  [interp.unfinished; basis: ...]
```

Every statement cites event IDs. Statements marked `Interpretation:` come from a named rule, not directly
from one event.

## 4. Reports

```sh
swain report imp_c70af5 --format md                       # to stdout
swain report imp_c70af5 --format json > report.json
swain report imp_c70af5 --format html --out report.html   # HTML requires --out; add --force to overwrite
```

Output files are created with mode 0600; an existing target is refused without `--force`, and symlinks
are never followed.

**Trace view.** HTML reports and local UI session pages have a Trace section between Explanation and
Commands and actions (below). It lists what you asked (one prompt per turn, linked to the turn), then each turn as a
collapsible block with its tool calls (request paired with its result, status, duration, input/output,
permissions, file changes), messages, subagents, usage events and capture gaps, plus a per-session tool
usage table and a small waterfall bar per tool call. Every step links to its Timeline row. Prompts and tool
output are only visible when the session was imported with `--include-content`; otherwise the Trace shows
hashes and sizes and tells you to run `swain import --include-content --reimport <path>`. The Trace covers
at most the first 5000 events of a session and says so when it is cut.

### Auditing a red-team run

To see every tool command each agent (the main agent and each subagent) requested, in order, with results where recorded:

```sh
swain import --include-content --reimport <path>   # command text needs --include-content
swain commands imp_c70af5                           # shell commands only
swain commands imp_c70af5 --all                     # every tool action, with a target where obvious
swain commands imp_aaaaaa imp_bbbbbb --json         # several sessions merged by time; machine output
```

Each line shows the sequence number, time, session (only with several IDs), agent (`main`, or the subagent
type with a stable index such as `researcher #1`), status, exit code and the command or target. HTML
reports and local UI session pages carry the same data in a "Commands and actions" section between Trace
and Timeline, with CSS-only filters for "Only shell commands" and for each agent, and an event link per row.

- Command text exists only for sessions imported with `--include-content`. A hash-only import shows
  "command hidden (hash-only, N bytes)".
- Shell tools are recognized by tool name (`Bash`, `bash`, `exec_command`, `shell_command`, `shell`,
  `local_shell`, `run_shell_command`). This is a heuristic: a shell run through another tool is not listed
  as a command.
- One session is listed in source order. Several sessions are merged by timestamp (rows without a valid
  time last). At most 64 sessions and 20000 rows are listed per call; the JSON `command` is cut at 8192
  characters (`commandTruncated`). Agents are shown as `subagent "type" #N`; `Agent`/`Task` rows show
  `subagent_type - description`.
- Captured output may contain the secrets the operation found. Masking is best-effort and not a guarantee.
- The store and every report stay on this machine; do not share them without review.
- Commands are cut at 400 characters and output at 200 in the table; `--json` carries the full command.
  Rows without a valid timestamp follow the timed ones, in their original order.

## 5. Local UI

```sh
swain ui                   # writes <store>/ui; or: swain ui --out DIR [--force]
```

```
Generated a static UI for 4 imports (no server, no JavaScript).
Open in a browser: file:///tmp/atm-demo/ui/index.html
```

Open the printed `file://` URL. The UI is static HTML with a Content-Security-Policy of
`default-src 'none'` and no JavaScript. `swain` never launches a browser or opens a socket.

## 6. Import your own sessions

`swain` never scans your home directory on its own. Ask it where each tool keeps files, then pass the
paths you choose:

```sh
swain sources
```

This only prints locations (resolved from `$HOME`) and file name patterns; it does no filesystem access.
Then for example:

```sh
swain import ~/.codex/sessions            # a directory: symlinks are skipped and counted
swain import path/to/one-session.jsonl
```

- **OpenCode** keeps sessions in a database, which is not read. Export one session first:
  `opencode export <session-id> > session.json`, then `swain import session.json`.
- **Codex** `exec --json` output saved to a file is imported as is.
- Use `--provider` and `--source-kind` to narrow adapter detection. An ambiguous match is rejected, never
  guessed.

## 7. Limitations (read this)

- All four adapters are **experimental**. They were written from documentation and source research of
  each tool, and tested only against **synthetic fixtures** in `fixtures/*/synthetic-mvp`. They have
  **not been verified against real provider files**, and no provider version is marked as tested.
- Claude Code transcripts, Codex rollouts and Gemini chats are undocumented or internal formats and can
  change without notice. Unrecognised records become `source.unknown` events instead of being guessed.
- A tool "request" is not proof that the tool ran. Explanations say so and cite the evidence.
- Reports and the UI contain hashes that allow confirming a guessed piece of content. Do not share them
  as if they were anonymous.
- Not in the MVP: live capture, replay, cloud features, an OpenCode database reader, private model
  reasoning (only provider-exposed reasoning text is labeled as such).
- Output directories are checked with `lstat` before use; do not write into directories that other users
  can modify (documented time-of-check limit).
- Under the Node permission model, `fsync` is disabled by Node, so the store skips the durability
  barrier there (the data is still written atomically via rename).
