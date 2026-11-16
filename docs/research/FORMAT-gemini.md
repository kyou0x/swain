# Gemini CLI on-disk session format

Source: `google-gemini/gemini-cli`, tag **v0.68.0** (latest release, published 2026-11-10T21:17:07Z; v0.69.0-preview.0 published the same day, v0.67.0 on 2026-11-04). All paths below are relative to the repo at that tag, fetched verbatim from `raw.githubusercontent.com` into an isolated temporary directory (never executed). No real user data was read. Anything not found in source is marked UNKNOWN.

Short citations: CRT = `packages/core/src/services/chatRecordingTypes.ts`; CRS = `packages/core/src/services/chatRecordingService.ts`; STO = `packages/core/src/config/storage.ts`; REG = `packages/core/src/config/projectRegistry.ts`; PTH = `packages/core/src/utils/paths.ts`.

## 0. Headline answers

1. **At v0.68.0 session files are append-only JSONL (`.jsonl`), not one rewritten JSON document.** (CRS `appendRecord` uses `fs.appendFileSync(file, JSON.stringify(record) + '\n')`; filenames end in `.jsonl`.)
2. **Legacy format is still read**: a single pretty/plain JSON document `session-*.json` holding a full `ConversationRecord` (with `messages` array). The loader tries JSONL first; if no record yields `sessionId`+`projectHash`, it re-parses the whole file as one JSON object (CRS `parseLegacyContentFallback`). `Storage.listProjectChatFiles` accepts both `.json` and `.jsonl` (STO). On resume of a `.json` file the CLI migrates it by writing a new `.jsonl` sibling (CRS `doInitialize`).
3. **The project directory is no longer `sha256(projectRoot)`**. It is a human-readable slug from a registry (see 1.1). The `projectHash` *field inside records* is still `sha256(projectRoot)` hex.
4. A reader MUST fold the log (later records override/patch earlier ones); it cannot just map lines to messages. The same message `id` is appended many times.
5. The Antigravity banner is present in README at v0.68.0; the repo is still maintained (releases through at least 2026-11-10) but repositioned (see section 6).

## 1. File location and naming

### 1.1 Directory
- Global dir: `Storage.getGlobalGeminiDir()` = `<homedir>/.gemini` (falls back to `<os.tmpdir()>/.gemini` if no home). (STO)
- Global temp dir = `<global>/tmp` (STO `TMP_DIR_NAME = 'tmp'`; the `getGlobalTempDir` body was not separately fetched, UNKNOWN beyond the constant and `getProjectTempDir` joining `getGlobalTempDir()` with the identifier).
- Runtime dir (`getGlobalRuntimeDir`) equals the global dir, except under macOS Seatbelt sandbox (`SANDBOX=sandbox-exec`) where it is `~/.cache/.gemini`. Project registry lives at `<runtimeDir>/projects.json`. (STO)
- Project temp dir = `<global>/tmp/<identifier>`; chats are in `<project temp dir>/chats/`. (STO `getProjectTempDir`; CRS `doInitialize`)
- `<identifier>` = a **slug** from `ProjectRegistry.getShortId(projectRoot)` (REG): `slugify(basename(projectRoot))` = lowercase, non `[a-z0-9]` runs replaced by `-`, trimmed, fallback `project`; on collision suffixed `-1`, `-2`, ... Registry file `projects.json` shape: `{"projects": {"<absolute project path>": "<slug>"}}` (slug regex `^[a-z0-9-]+$`). Each slug dir may contain a `.project_root` marker file with the owning path.
- **Legacy identifier** = `sha256(projectRoot)` hex (STO `getFilePathHash`); `performMigration` renames old hash dirs to the slug dir (temp dir and `<runtime>/history/`). An adapter must handle both: `tmp/<slug>/chats` and (older installs) `tmp/<64-hex>/chats`. Docs (`docs/cli/checkpointing.md`) still say `<project_hash>`; that is stale relative to code.
- **Subagent sessions**: `chats/<sanitize(parentSessionId)>/<sanitize(sessionId)>.jsonl` (no `session-` prefix, no timestamp). (CRS `doInitialize`)

### 1.2 `projectHash` field
`getProjectHash(projectRoot) = crypto.createHash('sha256').update(projectRoot).digest('hex')` (PTH line 318). Input is the raw project-root path string (no normalization visible in that function). Used for the `projectHash` field in every session header.

### 1.3 Filename (main sessions)
`session-<YYYY-MM-DDTHH-mm>-<shortId>.jsonl` where timestamp = `new Date().toISOString().slice(0,16)` with `:` replaced by `-` (UTC), `shortId` = first 8 chars of `sanitizeFilenamePart(sessionId)` (`[^a-zA-Z0-9_-]` -> `_`, `packages/core/src/utils/fileUtils.ts`). On collision: `session-<ts>-<n>-<shortId>.jsonl` with n = 1, 2, ... (CRS). `SESSION_FILE_PREFIX = 'session-'` (CRT). Example: `session-2026-11-15T10-30-a1b2c3d4.jsonl`.
Other artefacts: `<file>.unreadable-<epoch ms>` (preserved corrupt file), `<file>.tmp-<pid>` (atomic rewrite temp). Both should be ignored.

### 1.4 Telling formats apart
- Extension: `.jsonl` = new, `.json` = legacy.
- Content: legacy is a single JSON object whose top-level keys include `sessionId`, `projectHash`, `messages` (array). New format has one JSON object per line; line 1 is a header with `sessionId` and `projectHash` and (normally) no `messages`. A tolerant adapter: try per-line parse; if no header found, `JSON.parse` the entire file (this is what the CLI does). Blank lines and unparseable lines are silently skipped by the CLI.
- Caveat: a `.jsonl` could in principle contain a legacy `$set.messages` checkpoint (deprecated, see 2.5).

## 2. JSONL record kinds (v0.68.0)

Each line is one JSON object. Classification order used by the CLI (CRS `createJsonlRecordAccumulator.processLine`), first match wins:

1. `$rewindTo` is a string -> RewindRecord
2. `$patch` is an object -> MessagePatchRecord
3. has string `id` (and no `$patch`) -> MessageRecord
4. `$set` is an object -> MetadataUpdateRecord
5. has string `sessionId` and string `projectHash` -> PartialMetadataRecord (header)

### 2.1 Header / PartialMetadataRecord (CRT `PartialMetadataRecord`)
First line of a new file. Fields: `sessionId: string`, `projectHash: string`, `startTime?: ISO string`, `lastUpdated?: ISO string`, `summary?: string`, `memoryScratchpad?`, `directories?: string[]`, `kind?: 'main'|'subagent'`. Fields are shallow-merged into running metadata (later records win). `kind` is `undefined` (key omitted by JSON.stringify) for main sessions in practice since `initialize` is called with an optional `kind`; whether CLI passes `'main'` explicitly is UNKNOWN. `directories` is only set at creation for subagents; for main sessions it is set later via `$set`.
Loader result requires `sessionId` and `projectHash` or the file is treated as invalid (then falls to legacy fallback).

### 2.2 MessageRecord line
A complete message object (shape in section 3). The same `id` may appear many times (e.g. when tokens or tool calls are attached after the first write: `pushMessage` re-appends the whole updated message). **Fold rule: `Map<id, message>` with `set`; a re-appearing id replaces the content but keeps its original position in iteration order (JS Map semantics).** Order of messages = first-appearance order of ids, then modified by rewind/patch records.

### 2.3 MetadataUpdateRecord `{"$set": {...}}` (CRT)
`$set` is `Partial<Omit<ConversationRecord,'messages'>>` (so any of `sessionId, projectHash, startTime, lastUpdated, summary, memoryScratchpad, directories, kind`). Shallow-merged into metadata. Emitted for: `lastUpdated` after each recorded message, `summary` (`saveSummary`), `directories`, and `sessionId` on resume. Deprecated: `$set.messages: MessageRecord[]` = legacy full-history checkpoint; if present the loader clears all messages and replaces them with this array.

### 2.4 RewindRecord `{"$rewindTo": "<messageId>"}`
Delete the message with that id and every message after it (in current order). If the id is not found in the folded map, the loader **clears all messages**. (CRS processLine)

### 2.5 MessagePatchRecord `{"$patch": {...}}` (CRT `MessagePatchRecord`)
Fields (all optional): `id`, `content`, `toolCalls: [{id, result?}]` (single patch applied to message `id`); `updates: MessagePatch[]` (each `{id, content?, toolCalls?}`); `removeIds: string[]` (delete those messages); `orderIds: string[]` (reorder: messages not listed stay first in existing order, listed ones follow in the given order; unknown ids ignored).
Patch application (`applySinglePatch`): if message exists, `content` (if present) replaces `message.content`; for `toolCalls` patches, only on `gemini` messages that already have `toolCalls`, the matching `toolCalls[].id` gets `result` replaced. Patches for unknown message ids are ignored. Apply order inside one `$patch`: single patch, `updates`, `removeIds`, `orderIds`.

### 2.6 `memoryScratchpad` (CRT `MemoryScratchpad`)
`{version: 1, workflowSummary?: string, toolSequence?: string[], touchedPaths?: string[], validationStatus?: 'passed'|'failed'|'unknown'}`. Carried in `$set`. Who writes it: UNKNOWN (writer not inspected; only the loader/types).

## 3. Logical ConversationRecord (what the fold produces) (CRT)

```
ConversationRecord {
  sessionId: string
  projectHash: string          // sha256 hex of project root
  startTime: string            // ISO 8601
  lastUpdated: string          // ISO 8601
  messages: MessageRecord[]
  summary?: string
  memoryScratchpad?: MemoryScratchpad
  directories?: string[]       // workspace dirs added via /dir add
  kind?: 'main' | 'subagent'
}
```
In legacy `.json` files this is the literal whole file. Loader defaults: missing `startTime`/`lastUpdated` become "now".

### 3.1 MessageRecord (CRT `BaseMessageRecord & ConversationRecordExtra`)
Base (all types):
- `id: string` - UUID (`randomUUID()`) unless the caller supplied one (the chat layer supplies durable ids that are also used by the in-memory history).
- `timestamp: string` - ISO 8601 UTC, creation time of the record.
- `type: 'user' | 'gemini' | 'info' | 'error' | 'warning'`. (Hence "gemini" is the model role; there is no `'assistant'`.)
- `content: PartListUnion` - from `@google/genai`: `string | Part | Part[]`. In practice both strings (`''` for tool-only gemini messages created by `recordToolCalls`; plain strings from CLI-side messages) and `Part[]` (from history sync) occur. Adapters must accept string, a single Part object, or an array. Part kinds seen in this code: `{text}`, `{text, thought:true, thoughtSignature}`, `{functionCall:{id?,name,args}}`, `{functionResponse:{id,name,response}}`, `{inlineData}`/binary injections. Exact Part schema is the Google GenAI SDK `Part` (not fetched; field list otherwise UNKNOWN).
- `displayContent?: PartListUnion` - what the UI showed when it differs from `content` (e.g. user input with `@file` expansion); only set if different (CRS/geminiChat).

Extra when `type === 'gemini'`:
- `toolCalls?: ToolCallRecord[]`
- `thoughts?: Array<{subject: string, description: string, timestamp: string}>` (ThoughtSummary from `packages/core/src/utils/thoughtUtils.ts` is `{subject, description}`; `**Subject**` bold prefix of raw thought is parsed into `subject`.)
- `tokens?: TokensSummary | null`
- `model?: string` - model id string, free-form (e.g. `gemini-3-pro-preview`; actual values UNKNOWN beyond whatever the API client reports).
`user`, `info`, `error`, `warning` have only the base fields.

Behavioural notes (CRS, `geminiChat.ts`):
- Tool results are fed back to the model as a **`type:'user'` message whose `content` is `Part[]` of `functionResponse` parts** (geminiChat `recordSyntheticMessage('user', userContent.parts)`). So a tool call appears twice: in the gemini message's `toolCalls[]` (with `result`) and as a following `user` message with the functionResponse part. Adapters should dedupe: treat `user` messages whose parts are all `functionResponse` as tool-result carriers, not human input.
- History-sync messages (`updateMessagesFromHistory`) store model turns as `type:'gemini'` with `content: Part[]` (may include `functionCall` parts and `thought:true` parts). Content of such messages can therefore contain function calls independent of `toolCalls[]`.
- Synthetic: `info` message holding binary/inlineData parts; `gemini` message "Binary content received. Proceeding with analysis." (thought part) for binary injections.
- `recordThought` queues thoughts; they attach to the *next* recorded `gemini` message (or the new gemini message created by `recordToolCalls`). `recordMessageTokens` attaches to the last gemini message if it has no `tokens`, else queues for the next one. `tokens` may be `null`/absent.
- Resumable/ignored detection uses `partListUnionToString(content)`; user messages with "ignored" content (`isIgnoredUserContent`, not inspected) are not treated as real prompts. Details UNKNOWN.

### 3.2 TokensSummary (CRT)
`{input: number /*promptTokenCount*/, output: number /*candidatesTokenCount*/, cached: number /*cachedContentTokenCount*/, thoughts?: number /*thoughtsTokenCount*/, tool?: number /*toolUsePromptTokenCount*/, total: number /*totalTokenCount*/}`. `recordMessageTokens` always writes all six keys, defaulting missing counts to 0.

### 3.3 ToolCallRecord (CRT; population in `geminiChat.recordCompletedToolCalls` and `ChatRecordingService.recordToolCalls`)
- `id: string` - the call id (`request.callId`); matches `functionResponse.id`.
- `name: string` - tool name (`originalRequestName ?? name`), e.g. `run_shell_command`.
- `args: Record<string, unknown>` - tool arguments as sent by the model (`originalRequestArgs ?? args`).
- `result?: PartListUnion | null` - `call.response.responseParts` (normally `Part[]` containing `{functionResponse:{id,name,response:{output:string}|{error:string}}}`; the `response` inner keys `output`/`error` are inferred from convention, not verified in the files fetched => UNKNOWN). May be later replaced by a `$patch` with the history version (`turnParts`, i.e. the full user turn parts, possibly masked/truncated).
- `status: Status` - see 4.
- `timestamp: string` - ISO time the record was created (completion time, not start).
- `agentId?: string` - from `response.data.agentId` when a subagent ran the call.
- `displayName?: string` - from tool registry (`tool.displayName`, falls back to `name`).
- `description?: string` - `invocation.getDescription()` (for shell this is typically the command with annotations); else registry tool description (the long model-facing description!) when blank. Treat as UI text.
- `resultDisplay?: ToolResultDisplay` - union (tools.ts line 935): `string | FileDiff | AnsiOutput | TodoList | SubagentProgress | GrepResult | ListDirectoryResult | ReadManyFilesResult`. `FileDiff = {fileDiff: string /*unified diff*/, fileName: string, filePath: string, originalContent: string|null, newContent: string, diffStat?: DiffStat, isNewFile?: boolean, isBuildFile?: boolean}`. Other variants' shapes not expanded here (UNKNOWN beyond name). `DiffStat` fields UNKNOWN. Only `string` or object values are kept; other types dropped.
- `renderOutputAsMarkdown?: boolean` - `tool.isOutputMarkdown`.
Note: `MAX_TOOL_OUTPUT_SIZE = 50KB` is exported in CRT; where it is applied is UNKNOWN (not seen in the recording path).

## 4. Tool call `status` values
Type `Status = ToolCall['status']` (`packages/core/src/scheduler/types.ts`), derived from enum `CoreToolCallStatus`: `validating`, `scheduled`, `error`, `success`, `executing`, `cancelled`, `awaiting_approval`. Recording is called with *completed* calls (`recordCompletedToolCalls(CompletedToolCall[])`), so persisted values are expected to be only `success`, `error`, `cancelled`; whether any in-progress status is ever persisted is UNKNOWN.

## 5. Built-in tool names and arg keys (v0.68.0)
Sources: `packages/core/src/tools/definitions/base-declarations.ts` (names/param constants), `definitions/model-family-sets/gemini-3.ts` and `dynamic-declaration-helpers.ts` (schemas). Names recorded in `toolCalls[].name` are these constants (MCP tools use their own prefixed names - format UNKNOWN here).

| Tool name | Args keys (required marked *) |
|---|---|
| `run_shell_command` | `command`*, `description`, `dir_path`, `is_background`, `additional_permissions` (object; dynamic) |
| `replace` (edit) | `file_path`*, `instruction`*, `old_string`*, `new_string`*, `allow_multiple` |
| `write_file` | `file_path`*, `content`* |
| `read_file` | `file_path`*, `start_line`, `end_line` |
| `read_many_files` | `include`*, `exclude`, `recursive`, `useDefaultExcludes` |
| `list_directory` | `dir_path`*, `ignore`, `file_filtering_options` |
| `glob` | `pattern`*, `dir_path`, `case_sensitive`, `respect_git_ignore`, `respect_gemini_ignore` |
| `grep_search` | `pattern`*, `dir_path`, `include_pattern`, `exclude_pattern`, `names_only`, `max_matches_per_file`, `total_max_matches`, `fixed_strings`, `context`, `after`, `before`, `no_ignore` (grep variant may differ; `ripGrep.ts` also exists) |
| `google_web_search` | `query`* |
| `web_fetch` | `prompt`* |
| `write_todos` | `todos`* (items `{description, status}`) |
| `ask_user` | `questions`* |
| `activate_skill` | `name` |
| `get_internal_docs` | `path` |
| `enter_plan_mode` / `exit_plan_mode` | `reason` / `plan_filename` |
| `update_topic` | `title`, `summary`, `strategic_intent` |
| `complete_task`, `read_mcp_resource`, `list_mcp_resources` | args UNKNOWN (`read_mcp_resource` requires `uri`) |
Other tool files exist (`memoryTool.ts`, `shellBackgroundTools.ts`, `trackerTools.ts`); their names/args are UNKNOWN. Required-ness of grep/glob/shell args was read from gemini-3 schema only; an older model-family schema (`default-legacy.ts`) may differ.

How file edits appear: `replace` and `write_file` calls carry the full `old_string`/`new_string` or `content`; on success `resultDisplay` is normally a `FileDiff` object with `fileDiff`, `filePath`, `originalContent`, `newContent` (inference from the `FileDiff` type and tool UI contract; which specific tools populate it is UNKNOWN without reading `edit.ts`/`write-file.ts`). Paths in `file_path` are absolute in the schema description convention (not verified). Shell output is in `result[].functionResponse.response` and/or `resultDisplay` as string or `AnsiOutput`.

## 6. Repo status and Antigravity banner
`README.md` at v0.68.0 carries an IMPORTANT banner: Gemini CLI is now for **Gemini Code Assist Standard/Enterprise** and Code Assist for GitHub on Google Cloud; **free individual access and Google AI Pro/Ultra moved to Antigravity CLI (`agy`) on June 18, 2026**; Gemini CLI is "not optimized for Gemini 4+" and "not for model benchmarks". It describes itself as "an open-source terminal agent maintained for enterprise Gemini Code Assist workflows". So: still maintained (v0.67.0 2026-11-04, v0.68.0 2026-11-10, v0.69.0-preview.0 2026-11-10; roughly weekly stable cadence), but the consumer user base shifted. Antigravity CLI's own on-disk format is out of scope and UNKNOWN here. Implication: expect existing Gemini installs to have mixed legacy `.json` and new `.jsonl` files, and possibly no new sessions on machines migrated to `agy`.

## 7. Checkpoint formats (different files, cheap to document)

### 7.1 `/chat save <tag>` (chatCommand.ts, `packages/core/src/core/logger.ts`)
Path: `<project temp dir>/checkpoint-<encodeURIComponent(tag)>.json` (NOT under `chats/`). Content: `JSON.stringify(checkpoint, null, 2)` of `{history: Content[], authType?: AuthType}` where `Content` is the GenAI SDK `{role: 'user'|'model', parts: Part[]}`. Legacy variant: file is a bare JSON array of `Content`. Saved only if history length exceeds the initial history length. Legacy filename `checkpoint-<rawTag>.json` also read. `AuthType` values UNKNOWN. No timestamps/ids/tokens in this format.
Also `<project temp dir>/logs.json`: array of `LogEntry {sessionId, messageId: number, timestamp: string, type: 'user', message: string}` (user prompts only; `logger.ts`). Whether it is still written at v0.68.0 is UNKNOWN.

### 7.2 Automatic file-edit checkpoints (`/restore`; `checkpointUtils.ts`, `docs/cli/checkpointing.md`)
Disabled by default (`general.checkpointing.enabled`). Path: `<project temp dir>/checkpoints/<checkpointFileName>.json`, name pattern from the docs: `<timestamp>-<basename of file_path>-<toolName>` e.g. `2025-06-22T10-00-00_000Z-my-file.txt-write_file` (generator body only partially read). Content (`getToolCallDataSchema`): `{history?: HistoryItem[] /*UI history*/, clientHistory?: Content[], commitHash?: string /*shadow git repo commit*/, toolCall: {name: string, args: object}, messageId?: string /*prompt_id*/}`. Shadow git repo: `<runtime>/history/<identifier>/` (docs write `~/.gemini/history/<project_hash>`).

## 8. Adapter guidance (derived, not source-verified claims)
1. Enumerate `~/.gemini/tmp/*/chats/session-*.{json,jsonl}` plus `chats/<parentId>/*.jsonl` for subagents; ignore `*.unreadable-*` and `*.tmp-*`.
2. Detect format by extension, confirm by content; fall back to whole-file JSON.
3. Fold JSONL per section 2. Be tolerant: skip bad lines (last line may be truncated mid-write).
4. De-duplicate tool results (3.1 note), and treat `type:'user'` functionResponse-only messages as tool output.
5. Treat `content` as polymorphic; also tolerate absent `toolCalls`/`thoughts`/`tokens`.
6. Redact `args.content`, `old_string`, `new_string`, `resultDisplay.originalContent/newContent`, and shell `command` strings per privacy policy; they contain whole file bodies.

## 9. UNKNOWN list
- `Storage.getGlobalTempDir` body (assumed `<global>/tmp`); whether `kind:'main'` is ever written.
- GenAI `Part` full schema; exact `functionResponse.response` inner keys; MCP tool naming.
- Which writer produces `memoryScratchpad`; `isIgnoredUserContent` rules; where `MAX_TOOL_OUTPUT_SIZE` is applied.
- Whether non-terminal tool statuses ever persist; `DiffStat`, `AnsiOutput`, `GrepResult` etc. shapes.
- Per-tool `resultDisplay` variant for each tool; `AuthType` enum; model id values.
- `.json` legacy: exact historic top-level fields beyond `ConversationRecord` (older versions may have had different message `type` values or lacked `thoughts`/`tokens`); not verified against older tags.

## 10. SYNTHETIC example session file (fake values; valid JSONL, one object per line)

File: `~/.gemini/tmp/project/chats/session-2026-11-15T10-30-a1b2c3d4.jsonl` (the slug `project` and all ids are fake). Contains: header, user message, gemini message with thoughts + tokens + model + successful `run_shell_command`, a tool-result user message, a `replace` call, a failed `write_file` call, an error message, `$set` updates, and a `$patch`.

```jsonl
{"sessionId":"a1b2c3d4-0000-4000-8000-000000000001","projectHash":"0000000000000000000000000000000000000000000000000000000000000000","startTime":"2026-11-15T10:30:00.000Z","lastUpdated":"2026-11-15T10:30:00.000Z"}
{"id":"11111111-0000-4000-8000-000000000001","timestamp":"2026-11-15T10:30:05.000Z","type":"user","content":[{"text":"Run the tests and fix the typo in /home/user/project/src/app.js"}]}
{"$set":{"lastUpdated":"2026-11-15T10:30:05.000Z"}}
{"id":"11111111-0000-4000-8000-000000000002","timestamp":"2026-11-15T10:30:09.000Z","type":"gemini","content":"","toolCalls":[{"id":"run_shell_command-1700000000000-aaaa","name":"run_shell_command","args":{"command":"npm test","description":"Run the test suite","dir_path":"/home/user/project"},"result":[{"functionResponse":{"id":"run_shell_command-1700000000000-aaaa","name":"run_shell_command","response":{"output":"Output: 1 failing: app.js: Expected 'colour' got 'color'\nExit Code: 1"}}}],"status":"success","timestamp":"2026-11-15T10:30:12.000Z","displayName":"Shell","description":"npm test [in /home/user/project]","resultDisplay":"1 failing: app.js: Expected 'colour' got 'color'","renderOutputAsMarkdown":false}],"thoughts":[{"subject":"Planning","description":"I should run the tests first to see what fails.","timestamp":"2026-11-15T10:30:08.000Z"}],"tokens":{"input":1200,"output":40,"cached":0,"thoughts":25,"tool":0,"total":1265},"model":"gemini-3-pro-preview"}
{"id":"11111111-0000-4000-8000-000000000003","timestamp":"2026-11-15T10:30:12.500Z","type":"user","content":[{"functionResponse":{"id":"run_shell_command-1700000000000-aaaa","name":"run_shell_command","response":{"output":"Output: 1 failing: app.js: Expected 'colour' got 'color'\nExit Code: 1"}}}]}
{"id":"11111111-0000-4000-8000-000000000004","timestamp":"2026-11-15T10:30:20.000Z","type":"gemini","content":"I found the typo and will fix it.","toolCalls":[{"id":"replace-1700000000001-bbbb","name":"replace","args":{"file_path":"/home/user/project/src/app.js","instruction":"Fix the spelling of colour","old_string":"const c = 'color';","new_string":"const c = 'colour';"},"result":[{"functionResponse":{"id":"replace-1700000000001-bbbb","name":"replace","response":{"output":"Successfully modified file: /home/user/project/src/app.js (1 replacements)."}}}],"status":"success","timestamp":"2026-11-15T10:30:22.000Z","displayName":"Edit","description":"src/app.js: const c = 'color'; => const c = 'colour';","resultDisplay":{"fileDiff":"--- a/src/app.js\n+++ b/src/app.js\n@@ -1 +1 @@\n-const c = 'color';\n+const c = 'colour';\n","fileName":"app.js","filePath":"/home/user/project/src/app.js","originalContent":"const c = 'color';\n","newContent":"const c = 'colour';\n"},"renderOutputAsMarkdown":true},{"id":"write_file-1700000000002-cccc","name":"write_file","args":{"file_path":"/home/user/project/locked/out.txt","content":"hello\n"},"result":[{"functionResponse":{"id":"write_file-1700000000002-cccc","name":"write_file","response":{"error":"EACCES: permission denied, open '/home/user/project/locked/out.txt'"}}}],"status":"error","timestamp":"2026-11-15T10:30:23.000Z","displayName":"WriteFile","description":"Writing to locked/out.txt","resultDisplay":"EACCES: permission denied","renderOutputAsMarkdown":false}],"thoughts":[],"tokens":{"input":1500,"output":120,"cached":1000,"thoughts":0,"tool":0,"total":1620},"model":"gemini-3-pro-preview"}
{"id":"11111111-0000-4000-8000-000000000005","timestamp":"2026-11-15T10:30:30.000Z","type":"error","content":"Request failed: 429 quota exceeded (example)"}
{"$set":{"lastUpdated":"2026-11-15T10:30:30.000Z","summary":"Fixed colour typo; one write failed"}}
{"$patch":{"updates":[{"id":"11111111-0000-4000-8000-000000000004","toolCalls":[{"id":"replace-1700000000001-bbbb","result":[{"functionResponse":{"id":"replace-1700000000001-bbbb","name":"replace","response":{"output":"Successfully modified file (masked)."}}}]}]}]}}
```

Fold result: header metadata (sessionId, projectHash, startTime) + `$set` merges (lastUpdated 10:30:30, summary) ; messages 1-5 in order; message 4's `replace` tool call `result` replaced by the `$patch`. (`displayName` strings above are illustrative; real values come from the tool registry and are UNKNOWN. The `toolCall.id` format `<name>-<epoch ms>-<rand>` is assumed from convention and not verified in source.)
