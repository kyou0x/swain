# Swain session report

## Notices

- hashes allow confirmation of guessed content; do not share exports
- content policy hash-only: event content is not stored, only hashes and sizes are shown
- EXPERIMENTAL: this adapter reads a source format that is experimental
- UNDOCUMENTED SOURCE: the provider does not document this format and it may change without notice
- untested provider version: this provider version is not in the adapter's tested list

## Session

- Import ID: imp\_189fb3b8ac64a0cde3867d23c83892f6
- Session ID: ses\_a4e1768dcf9597a9746bd0e5327d8875
- Provider: gemini\-cli
- Source kind: gemini\-cli\.chat\-jsonl
- Source stability: undocumented
- Experimental: yes
- Adapter: gemini\-cli\.chat\-jsonl\@0\.1\.0
- Source: \~\/\.gemini\/tmp\/demo\/chats\/chat\-demo\.jsonl
- Source SHA-256: de4759ea5dab9dee14005573342853782d8cad7f84a0fefa9e49ebc4f253c4b3
- Source size (bytes): 4096
- Content retention: hash\-only
- Import outcome: complete
- Events: 10
- Event time range: 2026\-03\-02T09\:00\:00\.000Z to 2026\-03\-02T09\:00\:09\.000Z

## Explanation

### Overview

- Provider gemini\-cli, source kind gemini\-cli\.chat\-jsonl, source stability undocumented, adapter gemini\-cli\.chat\-jsonl\@0\.1\.0, import outcome complete. (evidence: `evt_a3b4d021dc063f02ddd96091b019877f`)
- The import holds 10 events, including 1 turn.started events. (evidence: `evt_a3b4d021dc063f02ddd96091b019877f`, `evt_17e2b0c6fe4fe8d6b4c967b620108a17`)
- First valid event time 2026\-03\-02T09\:00\:00\.000Z, last valid event time 2026\-03\-02T09\:00\:09\.000Z. (evidence: `evt_a3b4d021dc063f02ddd96091b019877f`, `evt_17e2b0c6fe4fe8d6b4c967b620108a17`)
- Interpretation: no session.ended event exists; the outcome is interrupted, from the last turn.ended event (rule `interp.outcome`; evidence: `evt_17e2b0c6fe4fe8d6b4c967b620108a17`)

### Turns

- Turn 1: started at 2026\-03\-02T09\:00\:01\.000Z; ended with status interrupted. (evidence: `evt_0b3f0af5b3289dbe39ad80d08110dd5c`, `evt_17e2b0c6fe4fe8d6b4c967b620108a17`)

### Tools

- 1 tool requests were recorded across 1 distinct tools. A request records an attempt, not an observed execution. (evidence: `evt_ba307331305327ac7d60e138d4b1e164`)
- Tool search\_docs: requested 1, completed 0, failed 1, outcome not observed 0. (evidence: `evt_ba307331305327ac7d60e138d4b1e164`, `evt_3404c8e1617cecbc35c6246d62214155`)

### Files changed

- No evidence-backed statements for this section.

### Failures

- 1 tool.failed events with error class denied (tools: search\_docs). (evidence: `evt_3404c8e1617cecbc35c6246d62214155`)
- 1 agent.ended events with status interrupted. (evidence: `evt_41963553d1444dc0604b817fcb6f8dc6`)
- 1 turn.ended events with status interrupted. (evidence: `evt_17e2b0c6fe4fe8d6b4c967b620108a17`)

### Permissions

- 1 permission requests were recorded (tools: search\_docs). A request is not a decision. (evidence: `evt_c589ae039227b7576f32b7bbc7e73e0e`)
- 1 permission decisions: deny, decided by policy. (evidence: `evt_bc6af57bafb68bbd54fd591430502c1e`)

### Tokens

- Model synthetic\-model\-g: summed from 1 turn-scope usage events, input tokens 400, output tokens 50. (evidence: `evt_cbfcbb058b4438b3bf84589ea194606f`)

### Capture gaps and unknown records

- Import statistics, not an event, report 3 source records folded without an event of their own. (evidence: `evt_a3b4d021dc063f02ddd96091b019877f`)

### Limitations

- Source stability is undocumented. The adapter is labelled experimental. The source format is undocumented and may change without notice. (evidence: `evt_a3b4d021dc063f02ddd96091b019877f`)
- 2 events carry hash-only content; the text is not stored and only its hash and size are known. (evidence: `evt_0b3f0af5b3289dbe39ad80d08110dd5c`, `evt_ba307331305327ac7d60e138d4b1e164`)
- Import warnings, not events: folded\-records x1, untested\-provider\-version x1. (evidence: `evt_a3b4d021dc063f02ddd96091b019877f`)

## Timeline

| Seq | Event | Kind | Status | Actor | Time | Detail | Source |
|---|---|---|---|---|---|---|---|
| 0.0 | `evt_a3b4d021dc063f02ddd96091b019877f` | session\.started | none | runtime | 2026\-03\-02T09\:00\:00\.000Z | trigger startup | line 1\, offset 0\, sha256 7c388d761258 |
| 1.0 | `evt_0b3f0af5b3289dbe39ad80d08110dd5c` | turn\.started | none | user | 2026\-03\-02T09\:00\:01\.000Z | prompt hash-only, 31 bytes | line 2\, offset 200\, sha256 22d12c8d24e5 |
| 2.0 | `evt_ba307331305327ac7d60e138d4b1e164` | tool\.requested | none | agent | 2026\-03\-02T09\:00\:02\.000Z | requested tool search\_docs (mcp) server docs\-server input hash-only, 11 bytes | line 3\, offset 400\, sha256 13a491e64ca3 |
| 3.0 | `evt_c589ae039227b7576f32b7bbc7e73e0e` | permission\.requested | none | agent | 2026\-03\-02T09\:00\:03\.000Z | permission requested for search\_docs | line 4\, offset 600\, sha256 c3bc3a8d3e73 |
| 4.0 | `evt_bc6af57bafb68bbd54fd591430502c1e` | permission\.decided | none | runtime | 2026\-03\-02T09\:00\:04\.000Z | decision deny by policy | line 5\, offset 800\, sha256 2761b8c1e727 |
| 5.0 | `evt_3404c8e1617cecbc35c6246d62214155` | tool\.failed | denied | agent | 2026\-03\-02T09\:00\:05\.000Z | tool search\_docs failed, error class denied | line 6\, offset 1000\, sha256 2277c7bc5697 |
| 6.0 | `evt_e3c8daa687a315defb050af391f97a21` | agent\.started | none | subagent | 2026\-03\-02T09\:00\:06\.000Z | agent type researcher | line 7\, offset 1200\, sha256 1b631ca34789 |
| 7.0 | `evt_41963553d1444dc0604b817fcb6f8dc6` | agent\.ended | interrupted | subagent | 2026\-03\-02T09\:00\:07\.000Z |  | line 8\, offset 1400\, sha256 56d86a3a0f93 |
| 8.0 | `evt_cbfcbb058b4438b3bf84589ea194606f` | model\.usage | none | agent | 2026\-03\-02T09\:00\:08\.000Z | usage scope turn, model synthetic\-model\-g | line 9\, offset 1600\, sha256 ac280f124c57 |
| 9.0 | `evt_17e2b0c6fe4fe8d6b4c967b620108a17` | turn\.ended | interrupted | agent | 2026\-03\-02T09\:00\:09\.000Z |  | line 10\, offset 1800\, sha256 7622681e54b1 |

## Warnings and gaps

- warning untested\-provider\-version (info), source sequence none: seen\=0\.0\.0\-synthetic
- warning folded\-records (info), source sequence none: count\=3
