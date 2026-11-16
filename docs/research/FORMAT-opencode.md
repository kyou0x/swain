# OpenCode session formats (export JSON and on-disk storage)

Source: public repository `anomalyco/opencode` (`https://github.com/sst/opencode` returns HTTP 301 to `https://github.com/anomalyco/opencode`), pinned to release tag **v1.19.5** (GitHub "latest" release, published 2026-10-28). No real user session or log was read; everything below comes from source at that tag.

Citation shorthand (all paths at tag `v1.19.5`):
- `[EXPORT]` = `packages/opencode/src/cli/cmd/export.ts`
- `[V1]` = `packages/schema/src/v1/session.ts` (Part, Message, Session event schemas; re-exported by `packages/core/src/v1/session.ts`)
- `[SESS]` = `packages/opencode/src/session/session.ts` (Session.Info schema, `fromRow`, `messages()`)
- `[MSG]` = `packages/opencode/src/session/message-v2.ts` (`info()`, `part()`, `hydrate()`, `page()`)
- `[SQL]` = `packages/core/src/session/sql.ts`
- `[DB]` = `packages/core/src/database/database.ts`
- `[STORE]` = `packages/opencode/src/storage/storage.ts`
- `[FD]` = `packages/schema/src/file-diff.ts`
- `[PROC]` = `packages/opencode/src/session/processor.ts`
- `[TOOL:x]` = `packages/opencode/src/tool/x.ts`

## 1. `opencode export [sessionID]`

Command definition: `[EXPORT]` `command: "export [sessionID]"`, describe "export session data as JSON", option `--sanitize` (boolean). The `[EXPORT]` handler is the only export path verified. I did not verify a separate `opencode session export` subcommand. `packages/opencode/src/cli/cmd/session.ts` was downloaded but not inspected for one, so treat that as UNKNOWN.

### 1.1 Stdout / stderr behavior (`[EXPORT]`, function `run`)
- stderr, always, first: `Exporting session: <sessionID or "latest">\n`.
- If no `sessionID` argument is given, an interactive `@clack/prompts` picker is shown (all output redirected to stderr) listing sessions sorted by `time.updated` descending. An adapter should always pass an explicit sessionID. With zero sessions it prints "No sessions found" to stderr and exits without writing JSON to stdout.
- stdout receives ONLY: `JSON.stringify(exportData, null, 2)` followed by `os.EOL`. This is **pretty-printed with 2-space indent**. Nothing else is written to stdout.
- Failure (session missing or any error while loading): `fail("Session not found: <id>")` (error path; stdout stays empty). Exit code semantics of `fail` are UNKNOWN (`../effect-cmd` not inspected).
- Because `JSON.stringify` is used, properties whose value is `undefined` are omitted from the output. Optional fields are therefore absent, not `null`.

### 1.2 Top-level shape
```
{
  "info":     Session.Info,                       // section 2
  "messages": [ { "info": Message, "parts": Part[] }, ... ]   // sections 3, 4
}
```
`messages` is `SessionV1.WithParts[]` (`[V1]` `WithParts = {info: Info, parts: Part[]}`).
- Message order: oldest first. `[SESS]` `messages()` pages through `[MSG]` `page()` (query `ORDER BY time_created DESC, id DESC`) and reverses the result, giving ascending (`time_created`, `id`).
- Part order within a message: `ORDER BY part.id` (ascending). Part ids are time-ordered, so this is creation order (`[MSG]` `hydrate()`).
- A message with no parts yields `"parts": []`.

### 1.3 `--sanitize` variant (`[EXPORT]` `sanitize()`)
Same shape, with content replaced by placeholders of the form `[redacted:<kind>:<id>]` (empty or whitespace-only strings are left as-is). Object-typed metadata/input that is non-empty is replaced with `{"redacted": "<kind>:<id>"}`.
- Session: `title`, `directory` redacted; `summary.diffs[].file/patch`; `revert.snapshot/diff`.
- User message: `system`, `summary.title/body/diffs`.
- Assistant message: `path.cwd`, `path.root`.
- Parts: `text.text`, `reasoning.text`, file `url/filename/source.*`, subtask `prompt/description/command`, tool `state.input/output/title/metadata/raw`, patch `hash` and `files[]`, snapshot `snapshot`, step-start/finish `snapshot`, agent `source.value`.
- NOT redacted by sanitize: `tool.state.error` strings, `retry.error`, assistant `error`, `session.slug`, `session.path`, `agent`/`model` names. A consumer should not assume sanitized exports are free of sensitive text.
- Adapters should handle both unsanitized and sanitized exports. In the sanitized form, `tool.state.input` may be `{"redacted": "tool-input:<partID>"}`, so tool input keys will not be present.

## 2. Session.Info (`export.info`)

Schema: `[SESS]` `Info` (lines ~224-243); row mapping `fromRow` (lines ~59-118); identical in `[V1]` `SessionInfo`. Timestamps are **epoch milliseconds** (integers; `[SQL]` `Timestamps` default `Date.now()`).

| Field | Type | Req? | Notes |
|---|---|---|---|
| `id` | string, starts `ses` | yes | Format `ses_` + 26-char descending-time-ordered id (`packages/schema/src/session-id.ts`, `identifier.ts`) |
| `slug` | string | yes | |
| `projectID` | string | yes | `Project.ID`; format UNKNOWN beyond string |
| `workspaceID` | string | no | |
| `directory` | string | yes | absolute path of the session working dir |
| `path` | string | no | path of cwd relative to the worktree (`sessionPath()`) |
| `parentID` | string (ses id) | no | set for child/subagent/fork sessions |
| `summary` | `{additions:number, deletions:number, files:number, diffs?: FileDiff[]}` | no | present when any of the three summary columns is non-null |
| `cost` | number | no | session total (in practice always set via `fromRow`) |
| `tokens` | `{input, output, reasoning, cache:{read, write}}` numbers | no | in practice always set via `fromRow` |
| `share` | `{url: string}` | no | |
| `title` | string | yes | |
| `agent` | string | no | |
| `model` | `{id: string, providerID: string, variant?: string}` | no | |
| `version` | string | yes | opencode version that created the session |
| `metadata` | `Record<string, any>` | no | |
| `time` | `{created, updated, compacting?, archived?}` | yes | epoch ms; `archived` may be any finite number |
| `permission` | `PermissionV1.Ruleset` | no | ruleset shape not documented here (UNKNOWN; `packages/core/src/v1/permission.ts` not inspected) |
| `revert` | `{messageID, partID?, snapshot?, diff?}` | no | |

`FileDiff` (`[FD]`): `{file?: string, patch?: string, additions: number, deletions: number, status?: "added"|"deleted"|"modified"}`.

## 3. Message (`messages[].info`), union discriminated on `role`

Schema: `[V1]` `User`, `Assistant`, `Info`. In the DB the row stores `data` JSON; `[MSG]` `info()` spreads `row.data` and adds `id` and `sessionID`. Message ids start `msg` (`msg_` + 26 chars, ascending-time order).

### 3.1 `role: "user"`
| Field | Type | Req? |
|---|---|---|
| `id` | string (`msg_...`) | yes |
| `sessionID` | string | yes |
| `role` | `"user"` | yes |
| `time` | `{created: number}` (epoch ms) | yes |
| `format` | `{type:"text"}` or `{type:"json_schema", schema: object, retryCount: number}` | no |
| `summary` | `{title?: string, body?: string, diffs: FileDiff[]}` | no |
| `agent` | string | yes |
| `model` | `{providerID: string, modelID: string, variant?: string}` | yes |
| `system` | string | no |
| `tools` | `Record<string, boolean>` | no |

### 3.2 `role: "assistant"`
| Field | Type | Req? |
|---|---|---|
| `id`, `sessionID`, `role: "assistant"` | | yes |
| `time` | `{created: number, completed?: number}` (epoch ms) | yes (`completed` absent while in progress/aborted) |
| `error` | one of the named errors below | no |
| `parentID` | string (id of the user message it answers) | yes |
| `modelID` | string | yes |
| `providerID` | string | yes |
| `mode` | string (legacy; same domain as agent) | yes |
| `agent` | string | yes |
| `path` | `{cwd: string, root: string}` | yes |
| `summary` | boolean | no (true for compaction summary messages; exact semantics UNKNOWN) |
| `cost` | number (USD, finite) | yes |
| `tokens` | `{total?: number, input, output, reasoning, cache:{read, write}}` | yes |
| `structured` | any | no |
| `variant` | string | no |
| `finish` | string (finish reason) | no |

`error` union (discriminated on `name`, each `{name, data:{...}}`), `[V1]`:
- `ProviderAuthError` `{providerID, message}`
- `UnknownError` `{message, ref?}`
- `MessageOutputLengthError` `{}`
- `MessageAbortedError` `{message}`
- `StructuredOutputError` `{message, retries}`
- `ContextOverflowError` `{message, responseBody?}`
- `ContentFilterError` `{message}`
- `APIError` `{message, statusCode?, isRetryable, responseHeaders?: Record<string,string>, responseBody?, metadata?: Record<string,string>}`

## 4. Part (`messages[].parts[]`), union discriminated on `type`

Every part has the base fields `id` (starts `prt`, `prt_` + 26 chars), `sessionID`, `messageID` (`[V1]` `partBase`; in the DB they come from the row columns, `[MSG]` `part()`). All `time.*` values are epoch ms integers. Part types (12): `text`, `subtask`, `reasoning`, `file`, `tool`, `step-start`, `step-finish`, `snapshot`, `patch`, `agent`, `retry`, `compaction` (`[V1]` `Part`).

| type | fields (beyond base) |
|---|---|
| `text` | `text: string`; `synthetic?: boolean`; `ignored?: boolean`; `time?: {start, end?}`; `metadata?: Record<string, any>` |
| `reasoning` | `text: string`; `metadata?: Record<string, any>`; `time: {start, end?}` (required) |
| `file` | `mime: string`; `filename?: string`; `url: string` (often a `data:` URL or `file://` URL; content may be large); `source?`: one of `{type:"file", path, text:{value,start,end}}`, `{type:"symbol", path, range:{start:{line,character}, end:{...}}, name, kind:number, text:{...}}`, `{type:"resource", clientName, uri, text:{...}}` |
| `tool` | `callID: string`; `tool: string`; `state: ToolState` (below); `metadata?: Record<string, any>` |
| `step-start` | `snapshot?: string` (git tree hash) |
| `step-finish` | `reason: string`; `snapshot?: string`; `cost: number`; `tokens: {total?, input, output, reasoning, cache:{read, write}}` |
| `snapshot` | `snapshot: string` |
| `patch` | `hash: string`; `files: string[]` (file paths changed) |
| `agent` | `name: string`; `source?: {value: string, start: number, end: number}` |
| `subtask` | `prompt: string`; `description: string`; `agent: string`; `model?: {providerID, modelID}`; `command?: string` |
| `retry` | `attempt: number`; `error: APIError ({name:"APIError", data:{...}})`; `time: {created}` |
| `compaction` | `auto: boolean`; `overflow?: boolean`; `tail_start_id?: string (msg id)` |

### 4.1 ToolState, discriminated on `status` (`[V1]`)
| status | fields |
|---|---|
| `pending` | `input: Record<string, any>`; `raw: string` (raw streamed argument text) |
| `running` | `input`; `title?: string`; `metadata?: Record<string, any>`; `time: {start}` |
| `completed` | `input`; `output: string`; `title: string`; `metadata: Record<string, any>`; `time: {start, end, compacted?}`; `attachments?: FilePart[]` |
| `error` | `input`; `error: string`; `metadata?: Record<string, any>`; `time: {start, end}` |

Notes:
- `time.compacted` (epoch ms), when set, indicates the tool output was pruned/compacted from model context. Whether the `output` text is also cleared in storage is UNKNOWN. `[MSG]` has a `truncateToolOutput` helper for model-context building only.
- `input` is the tool-call argument object, as parsed from the model call. Its keys depend on the tool (section 6) and are not guaranteed to match the schema (model errors yield the `invalid` tool).
- Which parts get emitted when: `step-start` and `step-finish` bracket each LLM step. `patch` parts are written after `step-finish` when `snapshot.patch()` reports changed files (`[PROC]`, around lines 430-480, 560). So a `patch` part can appear only in steps that modified files and only when snapshots are enabled (snapshot-disabled configuration behavior is UNKNOWN).

## 5. On-disk storage at v1.19.5

**SQLite, not a JSON file tree.** Evidence: `[SQL]` defines drizzle `sqliteTable`s; `[DB]` lines ~46-54.
- Database file: `<Global.Path.data>/opencode.db` (default channel), `<data>/opencode-<channel>.db` for non-default install channels (channel string sanitised to `[a-zA-Z0-9._-]`), or `<data>/<Flag.OPENCODE_DB>` if that env flag is set (the branch at line 46; exact conditions on lines 40-54 not fully verified). `Global.Path.data` = `xdgData + "/opencode"` (`packages/core/src/global.ts`), i.e. `~/.local/share/opencode` on Linux when `XDG_DATA_HOME` is unset.
- Tables relevant to sessions (`[SQL]`):
  - `session`: columns `id` (PK), `project_id`, `workspace_id`, `parent_id`, `slug`, `directory`, `path`, `title`, `version`, `share_url`, `summary_additions`, `summary_deletions`, `summary_files`, `summary_diffs` (JSON), `metadata` (JSON), `cost` (real), `tokens_input`, `tokens_output`, `tokens_reasoning`, `tokens_cache_read`, `tokens_cache_write`, `revert` (JSON), `permission` (JSON), `agent`, `model` (JSON `{id, providerID, variant?}`), `time_created`, `time_updated`, `time_compacting`, `time_archived`.
  - `message`: `id` (PK), `session_id`, `time_created`, `time_updated`, `data` (JSON = Message minus `id` and `sessionID`).
  - `part`: `id` (PK), `message_id`, `session_id`, `time_created`, `time_updated`, `data` (JSON = Part minus `id`, `sessionID`, `messageID`).
  - Other tables (not documented here): `todo`, `session_message`, `session_input`, `session_context_epoch`. These belong to the newer "v2" event-sourced session model. `session_message.data` format is UNKNOWN.
  - Reconstructing the export from SQL: `info = {...message.data, id: message.id, sessionID: message.session_id}`; `part = {...part.data, id, sessionID: part.session_id, messageID: part.message_id}` (`[MSG]` lines 80-94). Session info maps via `fromRow` (`[SESS]`).
- Legacy JSON tree (migrated into SQLite on upgrade by `[STORE]` migrations): `storage/session/info/<id>.json`, `storage/session/message/<sessionID>/<msgID>.json`, `storage/session/part/<sessionID>/<msgID>/<partID>.json`, later `session/<projectID>/<sessionID>.json`, `session_diff/<sessionID>.json`, `project/<projectID>.json`, with a `migration` marker file (`[STORE]` `file()` appends `.json` to the key path). Whether tag v1.19.5 still reads/writes these at runtime beyond migration is UNKNOWN. Treat JSON-tree layouts as legacy only. The `storage/message/<sid>/*.json` and `storage/part/<mid>/*.json` layout mentioned in the task brief was NOT found at this tag (only the `storage/session/{info,message,part}` variants in migration code).

## 6. Built-in tool names and input keys (the `tool` part's `tool` field and `state.input`)

Tool ids are the string passed to `Tool.define(...)` in `packages/opencode/src/tool/<file>.ts`. Input schemas are each file's `Parameters`. Optional keys are marked `?`.

| tool | input keys | source |
|---|---|---|
| `bash` | `command: string`, `timeout?: number (ms)`, `workdir?: string` | `shell.ts` (`ShellID.ToolID = "bash"` in `tool/shell/id.ts`, kept as "bash" for compatibility even on PowerShell/cmd); schema in `tool/shell/prompt.ts` |
| `read` | `filePath: string`, `offset?: number (1-indexed line)`, `limit?: number` | `read.ts` |
| `write` | `filePath: string`, `content: string` | `write.ts` |
| `edit` | `filePath: string`, `oldString: string`, `newString: string`, `replaceAll?: boolean` | `edit.ts` |
| `apply_patch` | `patchText: string` | `apply_patch.ts` |
| `glob` | `pattern: string`, `path?: string` | `glob.ts` |
| `grep` | `pattern: string`, `path?: string`, `include?: string` | `grep.ts` |
| `webfetch` | `url: string`, `format?: "text"|"markdown"|"html"` (default markdown), `timeout?: number (s)` | `webfetch.ts` |
| `websearch` | keys not extracted (UNKNOWN) | `websearch.ts` |
| `task` | `description: string`, `prompt: string`, `subagent_type: string`, `task_id?: string`, `command?: string`, `background?: boolean` | `task.ts` |
| `todowrite` | `todos: Todo.Info[]` (item fields UNKNOWN here; `packages/schema/src/session-todo.ts`) | `todo.ts` |
| `skill` | `name: string` | `skill.ts` |
| `question` | keys not extracted (UNKNOWN) | `question.ts` |
| `lsp` | keys not extracted (UNKNOWN) | `lsp.ts` |
| `invalid` | emitted when model args fail validation; output text "The arguments provided to the tool are invalid: ..." | `invalid.ts` |
| `plan_exit` (file `plan.ts`, `PlanExitTool`) | exact tool id string not verified (UNKNOWN) | `plan.ts` |

Also possible: MCP tools and plugin/custom tools, with arbitrary names (MCP names are typically `<server>_<tool>` but that was not verified: UNKNOWN). `code-mode.ts` and `registry.ts` exist but were not inspected.

Completed-state output/metadata (from source, not from real sessions):
- `bash`: `title` = the command string; `output` = combined stdout/stderr text (may include a trailing `<shell_metadata>...</shell_metadata>` block when the command timed out or was aborted); `metadata = {output: string (preview/last output), exit: number|null, truncated: boolean, outputPath?: string}` (`shell.ts` ~lines 584-595; during running, metadata is also updated via `ctx.metadata`). Exact type of `exit` is not verified.
- `edit`: `title` = path relative to worktree; `output` = `"Edit applied successfully."` plus optional `"\n\nLSP errors detected in this file, please fix:\n..."`; `metadata = {diagnostics: object, diff: string (unified diff), filediff: {file, patch, additions, deletions}}` (`edit.ts` ~lines 173-210).
- `write`: `title` = path relative to worktree; `output` = result text plus optional LSP error blocks; `metadata = {diagnostics, filepath, exists: boolean}` (`write.ts` ~lines 90-98).
- Metadata for `read`, `glob`, `grep`, etc.: UNKNOWN (not extracted).

## 7. UNKNOWN / unverified summary
- Whether a `opencode session export` subcommand exists (`session.ts` not read for it).
- Exit code and stderr text on failure beyond "Session not found: <id>" (`effect-cmd.ts` not read).
- `PermissionV1.Ruleset` shape; `Project.ID` format; `Todo.Info` fields.
- Input keys for `websearch`, `question`, `lsp`; exact tool id for plan exit; MCP tool naming.
- Metadata shapes for read/glob/grep/webfetch/task/apply_patch tools.
- Exact semantics of `Assistant.summary`, `time.compacted` effect on stored `output`, and runtime use of legacy JSON storage.
- Compatibility with other versions: older releases (pre-SQLite) used the JSON file tree; their export shape may differ (e.g. no `slug`, `agent`, `model` on Session.Info; fewer part types). Not verified here.

## 8. SYNTHETIC example export (fake values; shape follows sections 1-4)

Constructed by hand from the schemas above. Not derived from any real session. Ids are 4-char-prefix plus fake suffix for readability (real ids are `ses_`/`msg_`/`prt_` plus 26 chars; only the prefix is enforced by the schema).

```json
{
  "info": {
    "id": "ses_fake01",
    "slug": "fake-slug",
    "projectID": "proj_fake01",
    "directory": "/home/user/project",
    "path": "",
    "title": "Fix greeting typo",
    "version": "1.19.5",
    "summary": { "additions": 1, "deletions": 1, "files": 1 },
    "cost": 0.0123,
    "tokens": { "input": 1500, "output": 200, "reasoning": 50, "cache": { "read": 1000, "write": 300 } },
    "agent": "build",
    "model": { "id": "fake-model", "providerID": "fake-provider" },
    "time": { "created": 1790000000000, "updated": 1790000060000 }
  },
  "messages": [
    {
      "info": {
        "id": "msg_fakeuser01",
        "sessionID": "ses_fake01",
        "role": "user",
        "time": { "created": 1790000000000 },
        "agent": "build",
        "model": { "providerID": "fake-provider", "modelID": "fake-model" }
      },
      "parts": [
        {
          "id": "prt_fakeuser01a",
          "sessionID": "ses_fake01",
          "messageID": "msg_fakeuser01",
          "type": "text",
          "text": "Fix the typo in greeting.txt and run the tests."
        }
      ]
    },
    {
      "info": {
        "id": "msg_fakeasst01",
        "sessionID": "ses_fake01",
        "role": "assistant",
        "time": { "created": 1790000001000, "completed": 1790000059000 },
        "parentID": "msg_fakeuser01",
        "modelID": "fake-model",
        "providerID": "fake-provider",
        "mode": "build",
        "agent": "build",
        "path": { "cwd": "/home/user/project", "root": "/home/user/project" },
        "cost": 0.0123,
        "tokens": { "total": 1750, "input": 1500, "output": 200, "reasoning": 50, "cache": { "read": 1000, "write": 300 } },
        "finish": "stop"
      },
      "parts": [
        {
          "id": "prt_fakeasst01a",
          "sessionID": "ses_fake01",
          "messageID": "msg_fakeasst01",
          "type": "step-start",
          "snapshot": "0000000000000000000000000000000000000001"
        },
        {
          "id": "prt_fakeasst01b",
          "sessionID": "ses_fake01",
          "messageID": "msg_fakeasst01",
          "type": "reasoning",
          "text": "I should look at the file, fix the typo, then run tests.",
          "time": { "start": 1790000001100, "end": 1790000002000 }
        },
        {
          "id": "prt_fakeasst01c",
          "sessionID": "ses_fake01",
          "messageID": "msg_fakeasst01",
          "type": "text",
          "text": "I'll fix the typo now.",
          "time": { "start": 1790000002100, "end": 1790000002500 }
        },
        {
          "id": "prt_fakeasst01d",
          "sessionID": "ses_fake01",
          "messageID": "msg_fakeasst01",
          "type": "tool",
          "callID": "call_fake01",
          "tool": "edit",
          "state": {
            "status": "completed",
            "input": {
              "filePath": "/home/user/project/greeting.txt",
              "oldString": "Helo world",
              "newString": "Hello world"
            },
            "output": "Edit applied successfully.",
            "title": "greeting.txt",
            "metadata": {
              "diagnostics": {},
              "diff": "Index: /home/user/project/greeting.txt\n--- a/greeting.txt\n+++ b/greeting.txt\n@@ -1 +1 @@\n-Helo world\n+Hello world\n",
              "filediff": {
                "file": "/home/user/project/greeting.txt",
                "patch": "@@ -1 +1 @@\n-Helo world\n+Hello world\n",
                "additions": 1,
                "deletions": 1
              }
            },
            "time": { "start": 1790000003000, "end": 1790000003200 }
          }
        },
        {
          "id": "prt_fakeasst01e",
          "sessionID": "ses_fake01",
          "messageID": "msg_fakeasst01",
          "type": "tool",
          "callID": "call_fake02",
          "tool": "bash",
          "state": {
            "status": "completed",
            "input": { "command": "npm test", "workdir": "/home/user/project" },
            "output": "PASS  tests/greeting.test.js\nTests: 1 passed, 1 total\n",
            "title": "npm test",
            "metadata": {
              "output": "PASS  tests/greeting.test.js\nTests: 1 passed, 1 total\n",
              "exit": 0,
              "truncated": false
            },
            "time": { "start": 1790000004000, "end": 1790000009000 }
          }
        },
        {
          "id": "prt_fakeasst01f",
          "sessionID": "ses_fake01",
          "messageID": "msg_fakeasst01",
          "type": "tool",
          "callID": "call_fake03",
          "tool": "read",
          "state": {
            "status": "error",
            "input": { "filePath": "/home/user/project/missing.txt" },
            "error": "File not found: /home/user/project/missing.txt",
            "time": { "start": 1790000010000, "end": 1790000010050 }
          }
        },
        {
          "id": "prt_fakeasst01g",
          "sessionID": "ses_fake01",
          "messageID": "msg_fakeasst01",
          "type": "step-finish",
          "reason": "stop",
          "snapshot": "0000000000000000000000000000000000000002",
          "cost": 0.0123,
          "tokens": { "total": 1750, "input": 1500, "output": 200, "reasoning": 50, "cache": { "read": 1000, "write": 300 } }
        },
        {
          "id": "prt_fakeasst01h",
          "sessionID": "ses_fake01",
          "messageID": "msg_fakeasst01",
          "type": "patch",
          "hash": "0000000000000000000000000000000000000002",
          "files": ["/home/user/project/greeting.txt"]
        }
      ]
    }
  ]
}
```
