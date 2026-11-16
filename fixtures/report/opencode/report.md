# Swain session report

## Notices

- hashes allow confirmation of guessed content; do not share exports
- content policy hash-only: event content is not stored, only hashes and sizes are shown
- experimental label: no
- documented source interface
- untested provider version: this provider version is not in the adapter's tested list

## Session

- Import ID: imp\_ede36f16e42563999af8ad3f798819d9
- Session ID: ses\_9d2ed19b74c63c0a1954f177f068074a
- Provider: opencode
- Source kind: opencode\.session\-export
- Source stability: documented\-interface
- Experimental: no
- Adapter: opencode\.session\-export\@0\.1\.0
- Source: \~\/exports\/export\.json
- Source SHA-256: ee267ea36fb356876b402d181556e0d5d666ad4f0f34b3a23ab31a04dc00a1f3
- Source size (bytes): 4096
- Content retention: hash\-only
- Import outcome: complete
- Events: 13
- Event time range: 2026\-03\-02T09\:00\:00\.000Z to 2026\-03\-02T09\:00\:12\.000Z

## Explanation

### Overview

- Provider opencode, source kind opencode\.session\-export, source stability documented\-interface, adapter opencode\.session\-export\@0\.1\.0, import outcome complete. (evidence: `evt_35de545f6cd6cf6dff85ddb3bd09e10c`)
- The import holds 13 events, including 2 turn.started events. (evidence: `evt_35de545f6cd6cf6dff85ddb3bd09e10c`, `evt_8e178ada88885cca28ebce90321690d4`)
- First valid event time 2026\-03\-02T09\:00\:00\.000Z, last valid event time 2026\-03\-02T09\:00\:12\.000Z. (evidence: `evt_35de545f6cd6cf6dff85ddb3bd09e10c`, `evt_8e178ada88885cca28ebce90321690d4`)
- Interpretation: the session outcome is success, from the last session.ended event (rule `interp.outcome`; evidence: `evt_8e178ada88885cca28ebce90321690d4`)

### Turns

- Turn 1: started at 2026\-03\-02T09\:00\:01\.000Z; ended with status success. (evidence: `evt_4697f0e1e042df61a22fa0ce57965b86`, `evt_fc7fc7fc3cbd36456bccbd65a52bac7e`)
- Turn 2: started at 2026\-03\-02T09\:00\:09\.000Z; ended with status success. (evidence: `evt_a6a80c265e5f4a67d87d663fa3db23b6`, `evt_cdb09c0d3d1bf190807fb9f4cc76138e`)

### Tools

- 2 tool requests were recorded across 2 distinct tools. A request records an attempt, not an observed execution. (evidence: `evt_8dfb5ed909fae56526895da10691f492`, `evt_0910bcc7ee608b0ef72446d4141a31b8`)
- Tool edit: requested 1, completed 1, failed 0, outcome not observed 0. (evidence: `evt_0910bcc7ee608b0ef72446d4141a31b8`, `evt_16941f08768500d7494186380e40fd33`)
- Tool grep: requested 1, completed 1, failed 0, outcome not observed 0. (evidence: `evt_8dfb5ed909fae56526895da10691f492`, `evt_0db43a528ea893f0ac8bd0b86c726e36`)

### Files changed

- 1 file.changed events across 1 distinct paths. (evidence: `evt_dc9af67abc71ffc94a5f2529bc8eb18b`)
- File \~\/app\/lib\/util\.ts: change kind update, status success, derived from tool result. (evidence: `evt_dc9af67abc71ffc94a5f2529bc8eb18b`)

### Failures

- No evidence-backed statements for this section.

### Permissions

- No evidence-backed statements for this section.

### Tokens

- Model synthetic\-model\-o: summed from 2 turn-scope usage events, input tokens 1000, output tokens 110, cost (provider-side estimate) USD 0\.004000. (evidence: `evt_e05878f6e52f7a4f668777d196fadd42`, `evt_941aa4e9d8945d20daeae341be749458`)

### Capture gaps and unknown records

- No evidence-backed statements for this section.

### Limitations

- Source stability is documented\-interface. The adapter is not labelled experimental. (evidence: `evt_35de545f6cd6cf6dff85ddb3bd09e10c`)
- 6 events carry hash-only content; the text is not stored and only its hash and size are known. (evidence: `evt_4697f0e1e042df61a22fa0ce57965b86`, `evt_8dfb5ed909fae56526895da10691f492`, `evt_0db43a528ea893f0ac8bd0b86c726e36`, `evt_0910bcc7ee608b0ef72446d4141a31b8`, `evt_16941f08768500d7494186380e40fd33`, `evt_a6a80c265e5f4a67d87d663fa3db23b6`)
- Import warnings, not events: untested\-provider\-version x1. (evidence: `evt_35de545f6cd6cf6dff85ddb3bd09e10c`)

## Timeline

| Seq | Event | Kind | Status | Actor | Time | Detail | Source |
|---|---|---|---|---|---|---|---|
| 0.0 | `evt_35de545f6cd6cf6dff85ddb3bd09e10c` | session\.started | none | runtime | 2026\-03\-02T09\:00\:00\.000Z | trigger startup | line 1\, offset 0\, sha256 8714d6803794 |
| 1.0 | `evt_4697f0e1e042df61a22fa0ce57965b86` | turn\.started | none | user | 2026\-03\-02T09\:00\:01\.000Z | prompt hash-only, 26 bytes | line 2\, offset 200\, sha256 2a9e36d2ae28 |
| 2.0 | `evt_8dfb5ed909fae56526895da10691f492` | tool\.requested | none | agent | 2026\-03\-02T09\:00\:02\.000Z | requested tool grep (builtin) input hash-only, 11 bytes | line 3\, offset 400\, sha256 cf4dbcd18d6b |
| 3.0 | `evt_0db43a528ea893f0ac8bd0b86c726e36` | tool\.completed | success | agent | 2026\-03\-02T09\:00\:03\.000Z | tool grep completed output hash-only, 7 bytes | line 4\, offset 600\, sha256 f9b3e64c122b |
| 4.0 | `evt_0910bcc7ee608b0ef72446d4141a31b8` | tool\.requested | none | agent | 2026\-03\-02T09\:00\:04\.000Z | requested tool edit (builtin) input hash-only, 4 bytes | line 5\, offset 800\, sha256 af5f90ecc5af |
| 5.0 | `evt_16941f08768500d7494186380e40fd33` | tool\.completed | success | agent | 2026\-03\-02T09\:00\:05\.000Z | tool edit completed output hash-only, 6 bytes | line 6\, offset 1000\, sha256 bae6fa6212da |
| 6.0 | `evt_dc9af67abc71ffc94a5f2529bc8eb18b` | file\.changed | success | agent | 2026\-03\-02T09\:00\:06\.000Z | file \~\/app\/lib\/util\.ts, change kind update, derived from tool result | line 7\, offset 1200\, sha256 fca3a0ad68fa |
| 7.0 | `evt_e05878f6e52f7a4f668777d196fadd42` | model\.usage | none | agent | 2026\-03\-02T09\:00\:07\.000Z | usage scope turn, model synthetic\-model\-o | line 8\, offset 1400\, sha256 fb4caac14f84 |
| 8.0 | `evt_fc7fc7fc3cbd36456bccbd65a52bac7e` | turn\.ended | success | agent | 2026\-03\-02T09\:00\:08\.000Z |  | line 9\, offset 1600\, sha256 edc066a5f4ec |
| 9.0 | `evt_a6a80c265e5f4a67d87d663fa3db23b6` | turn\.started | none | user | 2026\-03\-02T09\:00\:09\.000Z | prompt hash-only, 13 bytes | line 10\, offset 1800\, sha256 f869ed8ffb0e |
| 10.0 | `evt_941aa4e9d8945d20daeae341be749458` | model\.usage | none | agent | 2026\-03\-02T09\:00\:10\.000Z | usage scope turn, model synthetic\-model\-o | line 11\, offset 2000\, sha256 2a0cf4d9871b |
| 11.0 | `evt_cdb09c0d3d1bf190807fb9f4cc76138e` | turn\.ended | success | agent | 2026\-03\-02T09\:00\:11\.000Z |  | line 12\, offset 2200\, sha256 3991d6d21f62 |
| 12.0 | `evt_8e178ada88885cca28ebce90321690d4` | session\.ended | success | runtime | 2026\-03\-02T09\:00\:12\.000Z | reason exit | line 13\, offset 2400\, sha256 bae6a9851572 |

## Warnings and gaps

- warning untested\-provider\-version (info), source sequence none: seen\=0\.0\.0\-synthetic
