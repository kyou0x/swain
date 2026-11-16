# Provider Adapter Contract v0

Required adapter responsibilities:
- Declare `id`, adapter version, supported provider versions (tested), capture mode(s), capability matrix.
- Detect native source type/version; reject unsupported types descriptively.
- Parse incrementally; bound input size/time/memory; normalize without execution.
- Emit canonical events with provenance (file+line, source sequence, content hash).
- Surface unknown records, lost/missing fields, parse warnings, ambiguous correlations.
- Explicitly report unsupported fields, never infer missing tool arguments or reasoning.
- Pass shared contract and adversarial-fixture test suite.

## Modes
`import-file` (P0), `stream-events` (future), `live-hook` (future). The provider adapter need not offer all modes.

## Providers and initial read strategy
- Claude Code: transcript JSONL and official hook event shapes (file import first).
- Codex CLI: `codex exec --json` stdout event stream; app-server future. `exec --json` is not necessarily identical to on-disk rollout files.
- Gemini CLI: hooks provide lifecycle/tool events; validate via actual documented hook payloads. Do not assume undocumented transcript schema.
- OpenCode: SDK event subscription and supported plugin APIs; import mode may be built through an official export or collected stream instead of private files.

## Provider capability matrix
Maintain machine-readable table with `available`, `partial`, `unknown`, `unsupported` for: session lifecycle, tool call inputs/outputs, LLM metadata, file patches, subagents, permissions, failures, timestamps, tokens. Test each mapping using anonymized official/real fixtures.

## Contract test examples
- Equivalent tool started/succeeded/failed samples from each provider map to common event types.
- Native IDs are namespaced; no collisions across imports.
- Unexpected field and future provider version never crash unrelated imports.
- Out-of-order and truncated streams produce honest `capture.gap` metadata.
