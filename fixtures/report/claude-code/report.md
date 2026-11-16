# Swain session report

## Notices

- hashes allow confirmation of guessed content; do not share exports
- content policy hash-only: event content is not stored, only hashes and sizes are shown
- EXPERIMENTAL: this adapter reads a source format that is experimental
- UNDOCUMENTED SOURCE: the provider does not document this format and it may change without notice
- untested provider version: this provider version is not in the adapter's tested list

## Session

- Import ID: imp\_b6f83cf7afb6570b77aeca0e73353bf9
- Session ID: ses\_37bfce23ddb3b69aeb48d4027d02bad4
- Provider: claude\-code
- Source kind: claude\-code\.transcript\-jsonl
- Source stability: undocumented
- Experimental: yes
- Adapter: claude\-code\.transcript\-jsonl\@0\.1\.0
- Source: \~\/\.claude\/projects\/demo\/session\-a\.jsonl
- Source SHA-256: 97a10eac1e6b0e5a68e7f7c0642f71fa75154acbe43946c86c135ffc48923d4f
- Source size (bytes): 4096
- Content retention: hash\-only
- Import outcome: partial
- Events: 24
- Event time range: 2026\-03\-02T09\:00\:00\.000Z to 2026\-03\-02T09\:00\:23\.000Z

## Explanation

### Overview

- Provider claude\-code, source kind claude\-code\.transcript\-jsonl, source stability undocumented, adapter claude\-code\.transcript\-jsonl\@0\.1\.0, import outcome partial. (evidence: `evt_8f608aedceeb5d22cde0effe224bb242`)
- The import holds 24 events, including 2 turn.started events. (evidence: `evt_8f608aedceeb5d22cde0effe224bb242`, `evt_12ef375f9bf80796709f2d0ff3a7ab40`)
- First valid event time 2026\-03\-02T09\:00\:00\.000Z, last valid event time 2026\-03\-02T09\:00\:23\.000Z. (evidence: `evt_8f608aedceeb5d22cde0effe224bb242`, `evt_12ef375f9bf80796709f2d0ff3a7ab40`)
- Interpretation: the session outcome is unknown, from the last session.ended event (rule `interp.outcome`; evidence: `evt_12ef375f9bf80796709f2d0ff3a7ab40`)

### Turns

- Turn 1: started at 2026\-03\-02T09\:00\:01\.000Z; ended with status success. (evidence: `evt_96696b2317c94c8382015d2b72abdf0a`, `evt_08421de7abe52ba6a05d6918dacf7b3c`)
- Turn 1 messages: 1 assistant text messages, 1 provider-exposed reasoning text messages. (evidence: `evt_4c7483c8f8359eb6f045bbf25ac61cc0`, `evt_1ed50c50dbe987f2dbce135dcde998ed`)
- Turn 2: started at 2026\-03\-02T09\:00\:19\.000Z; ended with status unknown. (evidence: `evt_fa9d476b8e32e893ed73181aeaf1f6e7`, `evt_c5bc2692717c4756bafd1ca81b4fe245`)

### Tools

- 5 tool requests were recorded across 3 distinct tools. A request records an attempt, not an observed execution. (evidence: `evt_4330763371ef2cf5b80b2b06bf60de38`, `evt_9b9cedca4bf853c8e1f60a182dddfef7`, `evt_d9a78cbca61cf7811ca25263acc6aa38`, `evt_0b3d5779d21b8d08867ba31741887a67`, `evt_96d34b0705996533ed03c72f07676193`)
- Tool Bash: requested 3, completed 1, failed 1, outcome not observed 1. (evidence: `evt_9b9cedca4bf853c8e1f60a182dddfef7`, `evt_9bbd2f48cbbf8e3474edb4c12289a2a6`, `evt_d9a78cbca61cf7811ca25263acc6aa38`, `evt_7672de982e470d4d1ee03bff886b8609`, `evt_96d34b0705996533ed03c72f07676193`, `evt_b9a9b39c91e989d267dee038f4ea87a9`)
- Tool Edit: requested 1, completed 1, failed 0, outcome not observed 0. (evidence: `evt_0b3d5779d21b8d08867ba31741887a67`, `evt_83609a884e1470252462a6ecdf018857`)
- Tool Read: requested 1, completed 1, failed 0, outcome not observed 0. (evidence: `evt_4330763371ef2cf5b80b2b06bf60de38`, `evt_b6393ea96aae365f26f57fe29f447112`)
- Interpretation: 1 tool requests have no observed result at the end of the source; the source may have ended before they completed (rule `interp.unfinished`; evidence: `evt_96d34b0705996533ed03c72f07676193`, `evt_b9a9b39c91e989d267dee038f4ea87a9`)

### Files changed

- 1 file.changed events across 1 distinct paths. (evidence: `evt_92c9e7aec9704c456e389c98e229bec6`)
- File \~\/project\/src\/app\.ts: change kind update, status success, derived from tool result. (evidence: `evt_92c9e7aec9704c456e389c98e229bec6`)

### Failures

- 1 tool.failed events with error class error (tools: Bash). (evidence: `evt_9bbd2f48cbbf8e3474edb4c12289a2a6`)
- Interpretation: tool Bash failed and was followed, in the same turn, by a successful Bash result, which may be a retry (rule `interp.retry`; evidence: `evt_9bbd2f48cbbf8e3474edb4c12289a2a6`, `evt_7672de982e470d4d1ee03bff886b8609`)

### Permissions

- 1 permission requests were recorded (tools: Bash). A request is not a decision. (evidence: `evt_65758389e86b5d020d57768b24f2373a`)
- 1 permission decisions: allow, decided by user. (evidence: `evt_0ce950e1855f088f68be4d6de0f2c76d`)

### Tokens

- Model synthetic\-model\-a: summed from 2 message-scope usage events, input tokens 2700, output tokens 520, cached input tokens 800, cost (provider-side estimate) USD 0\.012300. (evidence: `evt_de48ecfb3e0489be2ce53cb708ec43c6`, `evt_61c9f020d1f22b72b02d36b0cb199a55`)

### Capture gaps and unknown records

- 1 capture gaps with reason missing\-result. (evidence: `evt_b9a9b39c91e989d267dee038f4ea87a9`)
- 1 records were not recognized and kept as source.unknown (native types: queue\-operation). (evidence: `evt_dfaf5b8d4512b5e46766d8fc5d794eb3`)

### Limitations

- Source stability is undocumented. The adapter is labelled experimental. The source format is undocumented and may change without notice. (evidence: `evt_8f608aedceeb5d22cde0effe224bb242`)
- 13 events carry hash-only content; the text is not stored and only its hash and size are known. (evidence: `evt_96696b2317c94c8382015d2b72abdf0a`, `evt_4c7483c8f8359eb6f045bbf25ac61cc0`, `evt_4330763371ef2cf5b80b2b06bf60de38`, `evt_b6393ea96aae365f26f57fe29f447112`, `evt_9b9cedca4bf853c8e1f60a182dddfef7`, `evt_9bbd2f48cbbf8e3474edb4c12289a2a6`, `evt_d9a78cbca61cf7811ca25263acc6aa38`, `evt_7672de982e470d4d1ee03bff886b8609`, `evt_0b3d5779d21b8d08867ba31741887a67`, `evt_83609a884e1470252462a6ecdf018857`, `evt_1ed50c50dbe987f2dbce135dcde998ed`, `evt_fa9d476b8e32e893ed73181aeaf1f6e7`, `evt_96d34b0705996533ed03c72f07676193`)
- Import warnings, not events: unknown\-record\-type x1, untested\-provider\-version x1. (evidence: `evt_8f608aedceeb5d22cde0effe224bb242`)

## Timeline

| Seq | Event | Kind | Status | Actor | Time | Detail | Source |
|---|---|---|---|---|---|---|---|
| 0.0 | `evt_8f608aedceeb5d22cde0effe224bb242` | session\.started | none | runtime | 2026\-03\-02T09\:00\:00\.000Z | trigger startup | line 1\, offset 0\, sha256 921f39d140c5 |
| 1.0 | `evt_96696b2317c94c8382015d2b72abdf0a` | turn\.started | none | user | 2026\-03\-02T09\:00\:01\.000Z | prompt hash-only, 40 bytes | line 2\, offset 200\, sha256 6f4cb62a2e12 |
| 2.0 | `evt_4c7483c8f8359eb6f045bbf25ac61cc0` | message\.observed | none | agent | 2026\-03\-02T09\:00\:02\.000Z | provider-exposed reasoning text, role assistant content hash-only, 16 bytes | line 3\, offset 400\, sha256 d194134457e3 |
| 3.0 | `evt_4330763371ef2cf5b80b2b06bf60de38` | tool\.requested | none | agent | 2026\-03\-02T09\:00\:03\.000Z | requested tool Read (builtin) input hash-only, 10 bytes | line 4\, offset 600\, sha256 9160f8f35d09 |
| 4.0 | `evt_b6393ea96aae365f26f57fe29f447112` | tool\.completed | success | agent | 2026\-03\-02T09\:00\:04\.000Z | tool Read completed output hash-only, 11 bytes | line 5\, offset 800\, sha256 3050b1c441dd |
| 5.0 | `evt_9b9cedca4bf853c8e1f60a182dddfef7` | tool\.requested | none | agent | 2026\-03\-02T09\:00\:05\.000Z | requested tool Bash (builtin) input hash-only, 11 bytes | line 6\, offset 1000\, sha256 4312ef6aa65c |
| 6.0 | `evt_65758389e86b5d020d57768b24f2373a` | permission\.requested | none | agent | 2026\-03\-02T09\:00\:06\.000Z | permission requested for Bash | line 7\, offset 1200\, sha256 0d865672d768 |
| 7.0 | `evt_0ce950e1855f088f68be4d6de0f2c76d` | permission\.decided | none | user | 2026\-03\-02T09\:00\:07\.000Z | decision allow by user | line 8\, offset 1400\, sha256 96904ef33e0c |
| 8.0 | `evt_9bbd2f48cbbf8e3474edb4c12289a2a6` | tool\.failed | failure | agent | 2026\-03\-02T09\:00\:08\.000Z | tool Bash failed, error class error, exit code 1 error hash-only, 19 bytes | line 9\, offset 1600\, sha256 c4b1d24aa5b3 |
| 9.0 | `evt_d9a78cbca61cf7811ca25263acc6aa38` | tool\.requested | none | agent | 2026\-03\-02T09\:00\:09\.000Z | requested tool Bash (builtin) input hash-only, 11 bytes | line 10\, offset 1800\, sha256 563e3155743d |
| 10.0 | `evt_7672de982e470d4d1ee03bff886b8609` | tool\.completed | success | agent | 2026\-03\-02T09\:00\:10\.000Z | tool Bash completed, exit code 0 output hash-only, 10 bytes | line 11\, offset 2000\, sha256 cf515e7d0c09 |
| 11.0 | `evt_0b3d5779d21b8d08867ba31741887a67` | tool\.requested | none | agent | 2026\-03\-02T09\:00\:11\.000Z | requested tool Edit (builtin) input hash-only, 10 bytes | line 12\, offset 2200\, sha256 9dde934e3b54 |
| 12.0 | `evt_83609a884e1470252462a6ecdf018857` | tool\.completed | success | agent | 2026\-03\-02T09\:00\:12\.000Z | tool Edit completed output hash-only, 11 bytes | line 13\, offset 2400\, sha256 21e2b9c5098a |
| 13.0 | `evt_92c9e7aec9704c456e389c98e229bec6` | file\.changed | success | agent | 2026\-03\-02T09\:00\:13\.000Z | file \~\/project\/src\/app\.ts, change kind update, derived from tool result | line 14\, offset 2600\, sha256 c655c5eaa0cb |
| 14.0 | `evt_dfaf5b8d4512b5e46766d8fc5d794eb3` | source\.unknown | none | runtime | 2026\-03\-02T09\:00\:14\.000Z | unrecognized record, native type queue\-operation | line 15\, offset 2800\, sha256 67fe0912a7bd |
| 15.0 | `evt_de48ecfb3e0489be2ce53cb708ec43c6` | model\.usage | none | agent | 2026\-03\-02T09\:00\:15\.000Z | usage scope message, model synthetic\-model\-a | line 16\, offset 3000\, sha256 162fcbb59064 |
| 16.0 | `evt_61c9f020d1f22b72b02d36b0cb199a55` | model\.usage | none | agent | 2026\-03\-02T09\:00\:16\.000Z | usage scope message, model synthetic\-model\-a | line 17\, offset 3200\, sha256 8a84906cc5eb |
| 17.0 | `evt_1ed50c50dbe987f2dbce135dcde998ed` | message\.observed | none | agent | 2026\-03\-02T09\:00\:17\.000Z | text message, role assistant content hash-only, 12 bytes | line 18\, offset 3400\, sha256 db081befcbe9 |
| 18.0 | `evt_08421de7abe52ba6a05d6918dacf7b3c` | turn\.ended | success | agent | 2026\-03\-02T09\:00\:18\.000Z |  | line 19\, offset 3600\, sha256 dc7ffbc7e885 |
| 19.0 | `evt_fa9d476b8e32e893ed73181aeaf1f6e7` | turn\.started | none | user | 2026\-03\-02T09\:00\:19\.000Z | prompt hash-only, 18 bytes | line 20\, offset 3800\, sha256 7f840ee2b0e8 |
| 20.0 | `evt_96d34b0705996533ed03c72f07676193` | tool\.requested | none | agent | 2026\-03\-02T09\:00\:20\.000Z | requested tool Bash (builtin) input hash-only, 10 bytes | line 21\, offset 4000\, sha256 14ca47033e65 |
| 21.0 | `evt_b9a9b39c91e989d267dee038f4ea87a9` | capture\.gap | none | runtime | 2026\-03\-02T09\:00\:21\.000Z | gap missing\-result: no result record before end of source | line 22\, offset 4200\, sha256 389c1b250ba7 |
| 22.0 | `evt_c5bc2692717c4756bafd1ca81b4fe245` | turn\.ended | unknown | agent | 2026\-03\-02T09\:00\:22\.000Z |  | line 23\, offset 4400\, sha256 2067d78c38b1 |
| 23.0 | `evt_12ef375f9bf80796709f2d0ff3a7ab40` | session\.ended | unknown | runtime | 2026\-03\-02T09\:00\:23\.000Z | reason unknown | line 24\, offset 4600\, sha256 7ce7a9bcac7d |

## Warnings and gaps

- `evt_dfaf5b8d4512b5e46766d8fc5d794eb3`: unrecognized record, native type queue\-operation
- `evt_b9a9b39c91e989d267dee038f4ea87a9`: gap missing\-result: no result record before end of source
- warning untested\-provider\-version (info), source sequence none: seen\=0\.0\.0\-synthetic
- warning unknown\-record\-type (warn), source sequence 14: nativeType\=queue\-operation
