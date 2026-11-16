# ADR-0003: Claude Code import source for P0

Status: **Accepted (Option D, sequenced) by the human on 2026-11-15 (D-1).** The P0-ACCEPTANCE item 3 wording change is approved in principle but not yet applied. S5 remains blocked on capture authorization and naming of a redaction reviewer. S6 is blocked on S5. Nothing here blocks S1-S4 or S7.
Date: 2026-11-15. Evidence: `docs/research/PROVIDER-SOURCES.md` §1. That research was produced by a summarizing fetch tool and is secondhand.

## Problem

`P0-ACCEPTANCE.md` item 3 says "Import at least one redacted Claude Code JSONL session". The official Claude Code docs (https://code.claude.com/docs/en/sessions) say the on-disk transcript JSONL under `~/.claude/projects/...` is "internal to Claude Code and changes between versions, so scripts that parse these files directly can break on any release". No official record schema was found. The documented structured surfaces are:
- `claude -p --output-format stream-json --verbose` (https://code.claude.com/docs/en/headless)
- hook payloads (https://code.claude.com/docs/en/hooks)

So the source P0 imports determines whether Swain is built on a documented interface or on an internal format.

## What is known vs unknown

| Fact | Status |
|---|---|
| Transcript location, naming, 30-day default retention, `subagents/` nesting | DOCUMENTED |
| Transcript is unstable or internal | DOCUMENTED |
| Transcript record types and fields | UNKNOWN (no official source; local files not read) |
| stream-json message kinds (`system/init`, `assistant`, `user`, `stream_event`, `result`, `system/api_retry`, `permission_denied`, hook messages) | DOCUMENTED (names only) |
| stream-json `parent_tool_use_id` for subagents; final `result` with usage/cost | DOCUMENTED |
| stream-json full per-message field schema (Agent SDK TS reference) | NOT READ. It is expected to embed Anthropic Messages API content blocks (`tool_use`, `tool_result`), but this research does not verify that. It must be confirmed by a real capture. |
| Timestamps in stream-json or transcript | UNKNOWN |
| Hook payload fields (common + 13 events) | DOCUMENTED; no timestamp documented |
| `--no-session-persistence`, `--verbose`, `--output-format` flags exist in 2.1.325 | LOCAL-OBSERVED (`--help`) |
| Any of the above holds for 2.1.325 in practice | UNVERIFIED (no fixture) |

## Options

### A. Transcript JSONL, version-pinned and defensive
Import `~/.claude/projects/<p>/<id>.jsonl` with source kind `claude-code.transcript-jsonl` and stability `internal-unstable`.
- Pros:
  - Users already have these files for every interactive session, which gives the highest user value and the richest history.
  - It matches the literal P0 wording.
  - Nothing has to be configured in advance.
- Cons:
  - There is no schema to build against. The mapping has to be reverse-engineered from local files, which is exactly what the docs warn against, and it can break on any release.
  - Fixtures must come from real local sessions. That carries privacy risk and needs a heavy redaction review.
  - "Supported" can only ever mean "exact tested versions". Every other version gets an `untested-provider-version` warning, and that will be the normal case given the release cadence (2.1.199..2.1.325 seen).
  - It risks the PRD failure mode "hardwired to Claude transcript schema".
  - Subagent sessions span several files, which needs multi-source sessions in P0.

### B. stream-json (`claude -p --output-format stream-json --verbose`) captured to a file
The user runs headless Claude themselves and redirects stdout to a file. Swain imports that file with source kind `claude-code.stream-json` and stability `documented-interface`.
- Pros:
  - It is a documented, programmatic interface, with types published in the Agent SDK reference.
  - It is the same capture pattern as Codex `exec --json` and OpenCode `run --format json`. That makes it one provider-neutral "collected stream" design.
  - Subagent activity is inline (`parent_tool_use_id`), so one file is one source.
  - A fixture can be produced from a throwaway, benign scripted run instead of mining a user's history, which is a much smaller privacy surface.
  - Usage and cost come from the documented `result` message.
- Cons:
  - It covers only headless `-p` runs captured deliberately. Existing interactive history cannot be imported, so P0 user value is lower.
  - The per-message schema has not been read. Its stability promise across versions is not quantified, beyond being a documented SDK surface.
  - Timestamps are unknown and may be absent. The timeline would then be sequence-only.
  - A real fixture needs a human to run Claude with an account and network. Swain itself never runs it.

### C. Hooks-captured JSONL
A user-installed hook appends each hook payload to a file. Swain imports that file.
- Pros:
  - Field-level documentation is the strongest of the three options.
  - It covers interactive sessions, including permission and subagent lifecycle.
- Cons:
  - It requires installing a hook. S9 consent applies, and live hooks are explicitly out of P0.
  - Hooks can block or delay the host (ADR-0001).
  - No timestamp is documented, so the collector would have to add a receipt time. That is our code, which makes it a P3 live-capture component.
  - Hook payloads carry no assistant message stream (only `last_assistant_message`) and no token usage.

### D. Combination (sequenced)
Use B as the P0 primary. Add A as an optional, clearly labeled experimental source kind, only after a human-approved fixture exists. Defer C to P3. Both A and B live in `packages/adapters/claude-code/`.
- Shared mapping: one internal module maps content blocks (`tool_use`, `tool_result`, text, thinking) to canonical drafts. It is reused only if a fixture proves both surfaces use the same block shape.
- Separate framing: each surface gets its own record-envelope module, so a transcript format break cannot affect stream-json imports.

## Recommendation (architect; accepted as D-1)

**Option D, sequenced: B in P0 (satisfies item 3), A optional and gated, C deferred to P3.**

As accepted by the human:
- A is **not in P0**. It may become an experimental later source (timing D-2).
- The capture must be a fresh capture made under the S5 conditions below. It must not come from existing history.
- B is the only option that is documented, provider-neutral (the same mode as Codex and OpenCode), and obtainable without mining private history or installing hooks.
- A is valuable, but building P0's only real importer on a format the vendor calls internal contradicts "do not invent compatibility" and the PRD's anti-hardwiring principle.
- The recommendation stays honest only if:
  - the fixture is a real capture from 2.1.325, redacted and reviewed;
  - `testedProviderVersions` lists exactly the captured version(s);
  - the adapter manifest declares `sourceStability`, and reports display it;
  - every unrecognized message type becomes `source.unknown`, never an error and never dropped.
- I do not claim that stream-json is stable across versions, that it has timestamps, or that its content blocks match the transcript. Each of these is verified or refuted by the S5 fixture.

## S5 capture conditions (binding; G0 security review H2 + S5/S6 conditions)

**Data-handling rules (H2).** Coding agents, including the Claude Code session that develops this repo, are external model clients. Raw captures must never reach them.
- No agent reads `~/.claude/**`, any `CLAUDE_CONFIG_DIR`, any raw or unredacted capture, or the identifier list described below.
- No agent is given a raw file path, raw excerpts, or raw-file hashes for identification purposes.
- Only the human inspects and redacts raw bytes, and does so outside the repository and outside any directory an agent can access.
- Only redacted bytes enter the repository, and only after the review in step 8.
- This rule is proposed as part of S14 in `SECURITY-REQUIREMENTS.md`. Applying that amendment is a separate, human-approved docs change.

**Capture procedure** (executed by the human; a contributor may only draft the procedure and `FIXTURE.json` template from this text):
1. **Isolated environment.**
   - Use a container, a VM, or a dedicated OS user with no access to the human's real home directory, SSH keys, cloud credentials or repositories.
   - Use a fresh, empty `CLAUDE_CONFIG_DIR` with no hooks, plugins, MCP servers or custom settings (T6). Authentication is provisioned into that directory by the human.
   - If authentication cannot be provisioned without copying real configuration, stop and record why.
2. **Working directory.** Use an empty throwaway working directory: no secrets, no `.env`, no git remote, no real code.
3. **Flags.**
   - Use `claude -p "<benign scripted prompt>" --output-format stream-json --verbose --no-session-persistence`. `--no-session-persistence` was LOCAL-OBSERVED in 2.1.325 `--help`; re-confirm it in the capture environment.
   - Use a tool allow-list restricted to what the prompt needs, using the flag name confirmed in `claude --help` in that environment.
   - **Never use permission-bypass flags or modes**, such as `bypassPermissions` or any "skip permissions" flag.
4. **Prompt coverage.** The prompt exercises:
   - a successful read-only tool;
   - a failing shell command (for example, listing a nonexistent path);
   - optionally a subagent;
   - a denied permission, if achievable without bypass.
   No network targets, no scanning, no credentials (S11).
5. **Raw storage.** Redirect stdout to a file outside the repository. Record `claude --version` in the capture environment.
6. **Redaction (by the human, outside the repo).**
   - Consistently replace usernames, hostnames, paths, emails, account and organization identifiers, and every native ID (`session_id`, message and request IDs, `tool_use` IDs, UUIDs).
   - The identifier search must cover these forms:
     - plain;
     - JSON-escaped (`\/`, `\uXXXX` escapes);
     - URL-encoded;
     - case variants;
     - the Claude project-directory mangled form (non-alphanumerics replaced by `-`);
     - base64 or other encodings, if present.
   - The identifier list is never committed and never given to an agent. Only the human runs the search. `FIXTURE.json` records only the date and the hit count, which must be 0.
7. **Manifest.** Record in `FIXTURE.json`:
   - the exact command, with the prompt text, if benign;
   - the version and date;
   - redaction steps described generically;
   - the reviewer;
   - the sha256 of the committed redacted file;
   - `synthetic: false`, `redacted: true`.
   The unredacted original is never committed, including in history.
8. **Review.** a security review reviews the redacted bytes before the first commit (proposed S14). A BLOCK stops S6 (S12).
9. **Goldens.** Expected canonical outputs are generated only from the committed redacted bytes.

## Decision record
Resolved (human, 2026-11-15, the maintainer decision record):
- **D-1: Option D, sequenced, accepted.** The P0 Claude source is a user-captured `claude -p --output-format stream-json --verbose` file (source kind `claude-code.stream-json`).
- Transcript JSONL may only become an experimental later source. It is not in P0.
- The amendment to P0-ACCEPTANCE item 3 is approved in principle. **It has not yet been applied**; it will be applied as a separate docs change, not by agents unilaterally.

Still open:
1. **D-2:** exact timing of experimental transcript import (P2 or later). This ADR assumes it is not in P0, so captures use `--no-session-persistence`.
2. **S5 capture:** authorization of the account-backed capture run (network, API cost), and naming of the human redaction reviewer.
3. **Version policy:** confirm that "tested" means exactly the versions with committed fixtures, and that untested versions import with a warning (recommended; not yet explicitly confirmed).

## Consequences
- If B: README and reports must say that interactive history is not importable in P0.
- If A: every Claude release is a potential silent mapping break. Mitigations are the `source.unknown` accounting, contract tests on pinned fixtures, and a stability banner in reports. Maintenance cost is ongoing.
- Either way, the adapter depends only on `@swain/core` contracts, and the choice does not change the ADR-0002 schema.
