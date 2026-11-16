# Swain session report

## Notices

- hashes allow confirmation of guessed content; do not share exports
- content policy inline: retained content is shown where present
- inline content was masked best-effort; masking is not a guarantee
- EXPERIMENTAL: this adapter reads a source format that is experimental
- INTERNAL UNSTABLE SOURCE: the provider treats this format as internal and it may change
- untested provider version: this provider version is not in the adapter's tested list

## Session

- Import ID: imp\_9d7330dce7630e6ad1dcda21f39e46ab
- Session ID: ses\_e11b6854a7dd23c1b83e784d43cce03d
- Provider: codex\-cli
- Source kind: codex\-cli\.rollout\-jsonl
- Source stability: internal\-unstable
- Experimental: yes
- Adapter: codex\-cli\.rollout\-jsonl\@0\.1\.0
- Source: \~\/\.codex\/sessions\/2026\/03\/02\/rollout\-demo\.jsonl
- Source SHA-256: 0b6d0b7eb8c1bb716fc0d8d7894ef5c7e350972f1979fbbd1ba39143c2c91154
- Source size (bytes): 4096
- Content retention: inline
- Import outcome: complete
- Events: 16
- Event time range: 2026\-03\-02T09\:00\:00\.000Z to 2026\-03\-02T09\:00\:15\.000Z

## Explanation

### Overview

- Provider codex\-cli, source kind codex\-cli\.rollout\-jsonl, source stability internal\-unstable, adapter codex\-cli\.rollout\-jsonl\@0\.1\.0, import outcome complete. (evidence: `evt_e952aacba7d7d3c6144472924bc54584`)
- The import holds 16 events, including 2 turn.started events. (evidence: `evt_e952aacba7d7d3c6144472924bc54584`, `evt_7305d4a0e7d8f73b84a923f5df243c29`)
- First valid event time 2026\-03\-02T09\:00\:00\.000Z, last valid event time 2026\-03\-02T09\:00\:15\.000Z. (evidence: `evt_e952aacba7d7d3c6144472924bc54584`, `evt_7305d4a0e7d8f73b84a923f5df243c29`)
- Interpretation: the session outcome is success, from the last session.ended event (rule `interp.outcome`; evidence: `evt_7305d4a0e7d8f73b84a923f5df243c29`)

### Turns

- Turn 1: started at 2026\-03\-02T09\:00\:01\.000Z; ended with status success. (evidence: `evt_bf6bb67c62dc5f2f9f01df771eee7c3b`, `evt_f8c7a378db1f0cbd1d569483b9bdc460`)
- Turn 1 prompt excerpt (inline content): add a \-\-verbose flag (evidence: `evt_bf6bb67c62dc5f2f9f01df771eee7c3b`)
- Turn 1 messages: 1 assistant text messages. (evidence: `evt_d3c1d276bed7ee564244e42c39bc899d`)
- Turn 2: started at 2026\-03\-02T09\:00\:09\.000Z; ended with status success. (evidence: `evt_b2daa20a1a338e7ade6e826aaa0d3950`, `evt_0490fd6537ff5c1f2feaec456cf7a2d7`)
- Turn 2 prompt excerpt (inline content): also update the tests (evidence: `evt_b2daa20a1a338e7ade6e826aaa0d3950`)

### Tools

- 2 tool requests were recorded across 2 distinct tools. A request records an attempt, not an observed execution. (evidence: `evt_29ff8375e9215627d45d0e1ae43227d6`, `evt_6df4210619e4791e13f2f2df0c14ddbb`)
- Tool apply\_patch: requested 1, completed 1, failed 0, outcome not observed 0. (evidence: `evt_6df4210619e4791e13f2f2df0c14ddbb`, `evt_214b6e199dbcaaf5cc4b108c53cb52ab`)
- Tool shell: requested 1, completed 1, failed 0, outcome not observed 0. (evidence: `evt_29ff8375e9215627d45d0e1ae43227d6`, `evt_16ea9b04ecab3b0662f77e8dbcf8d0db`)

### Files changed

- 3 file.changed events across 3 distinct paths. (evidence: `evt_9487c78fc4ecf0ce1fc19eaf5eac4455`, `evt_3896148835943ba08e24feb630776d8c`, `evt_431564787027824a6c7250604e58530d`)
- File \~\/repo\/src\/cli\.ts: change kind update, status success, reported by the provider. (evidence: `evt_9487c78fc4ecf0ce1fc19eaf5eac4455`)
- File \~\/repo\/docs\/verbose\.md: change kind add, status success, reported by the provider. (evidence: `evt_3896148835943ba08e24feb630776d8c`)
- File \~\/repo\/test\/cli\.test\.ts: change kind update, status success, derived from tool result. (evidence: `evt_431564787027824a6c7250604e58530d`)

### Failures

- No evidence-backed statements for this section.

### Permissions

- No evidence-backed statements for this section.

### Tokens

- Model synthetic\-model\-c: cumulative as reported (last session-scope usage event, not summed), input tokens 2500, output tokens 400, total tokens 2900, cost (provider-side estimate) USD 0\.021000. (evidence: `evt_25955810a3da2456cb0a9d9bb5c8ab2e`)

### Capture gaps and unknown records

- Import statistics, not an event, report 2 source records folded without an event of their own. (evidence: `evt_e952aacba7d7d3c6144472924bc54584`)

### Limitations

- Source stability is internal\-unstable. The adapter is labelled experimental. (evidence: `evt_e952aacba7d7d3c6144472924bc54584`)
- Import warnings, not events: untested\-provider\-version x1. (evidence: `evt_e952aacba7d7d3c6144472924bc54584`)

## Timeline

| Seq | Event | Kind | Status | Actor | Time | Detail | Source |
|---|---|---|---|---|---|---|---|
| 0.0 | `evt_e952aacba7d7d3c6144472924bc54584` | session\.started | none | runtime | 2026\-03\-02T09\:00\:00\.000Z | trigger startup | line 1\, offset 0\, sha256 c049c78794a2 |
| 1.0 | `evt_bf6bb67c62dc5f2f9f01df771eee7c3b` | turn\.started | none | user | 2026\-03\-02T09\:00\:01\.000Z | prompt (inline): add a \-\-verbose flag | line 2\, offset 200\, sha256 4b3b55ca3216 |
| 2.0 | `evt_d3c1d276bed7ee564244e42c39bc899d` | message\.observed | none | agent | 2026\-03\-02T09\:00\:02\.000Z | text message, role assistant content (inline): I will edit the CLI parser\. | line 3\, offset 400\, sha256 da30eba25a46 |
| 3.0 | `evt_29ff8375e9215627d45d0e1ae43227d6` | tool\.requested | none | agent | 2026\-03\-02T09\:00\:03\.000Z | requested tool shell (builtin) input (inline): ls src | line 4\, offset 600\, sha256 1ad673795243 |
| 4.0 | `evt_16ea9b04ecab3b0662f77e8dbcf8d0db` | tool\.completed | success | agent | 2026\-03\-02T09\:00\:04\.000Z | tool shell completed, exit code 0 output (inline): cli\.ts\\nmain\.ts\\n | line 5\, offset 800\, sha256 b7ced3d0232e |
| 5.0 | `evt_9487c78fc4ecf0ce1fc19eaf5eac4455` | file\.changed | success | agent | 2026\-03\-02T09\:00\:05\.000Z | file \~\/repo\/src\/cli\.ts, change kind update, reported by the provider | line 6\, offset 1000\, sha256 ff0731a9a7cd |
| 6.0 | `evt_3896148835943ba08e24feb630776d8c` | file\.changed | success | agent | 2026\-03\-02T09\:00\:06\.000Z | file \~\/repo\/docs\/verbose\.md, change kind add, reported by the provider | line 7\, offset 1200\, sha256 488f7d5a0df1 |
| 7.0 | `evt_9112d8e29bdf2b7a848f332aa0898b2e` | model\.usage | none | agent | 2026\-03\-02T09\:00\:07\.000Z | usage scope session, model synthetic\-model\-c, total tokens 1100 | line 8\, offset 1400\, sha256 6fa015389231 |
| 8.0 | `evt_f8c7a378db1f0cbd1d569483b9bdc460` | turn\.ended | success | agent | 2026\-03\-02T09\:00\:08\.000Z |  | line 9\, offset 1600\, sha256 144f5249b8de |
| 9.0 | `evt_b2daa20a1a338e7ade6e826aaa0d3950` | turn\.started | none | user | 2026\-03\-02T09\:00\:09\.000Z | prompt (inline): also update the tests | line 10\, offset 1800\, sha256 ff503546f375 |
| 10.0 | `evt_6df4210619e4791e13f2f2df0c14ddbb` | tool\.requested | none | agent | 2026\-03\-02T09\:00\:10\.000Z | requested tool apply\_patch (builtin) input (inline): \*\*\* Begin Patch\\n\*\*\* End Patch | line 11\, offset 2000\, sha256 2906097c25e1 |
| 11.0 | `evt_214b6e199dbcaaf5cc4b108c53cb52ab` | tool\.completed | success | agent | 2026\-03\-02T09\:00\:11\.000Z | tool apply\_patch completed output (inline): ok | line 12\, offset 2200\, sha256 3a9df9ade185 |
| 12.0 | `evt_431564787027824a6c7250604e58530d` | file\.changed | success | agent | 2026\-03\-02T09\:00\:12\.000Z | file \~\/repo\/test\/cli\.test\.ts, change kind update, derived from tool result | line 13\, offset 2400\, sha256 dbccae21c14c |
| 13.0 | `evt_25955810a3da2456cb0a9d9bb5c8ab2e` | model\.usage | none | agent | 2026\-03\-02T09\:00\:13\.000Z | usage scope session, model synthetic\-model\-c, total tokens 2900 | line 14\, offset 2600\, sha256 91bb3b1f9c33 |
| 14.0 | `evt_0490fd6537ff5c1f2feaec456cf7a2d7` | turn\.ended | success | agent | 2026\-03\-02T09\:00\:14\.000Z |  | line 15\, offset 2800\, sha256 7cc5a1593392 |
| 15.0 | `evt_7305d4a0e7d8f73b84a923f5df243c29` | session\.ended | success | runtime | 2026\-03\-02T09\:00\:15\.000Z | reason exit | line 16\, offset 3000\, sha256 202d05d582be |

## Warnings and gaps

- warning untested\-provider\-version (info), source sequence none: seen\=0\.0\.0\-synthetic
