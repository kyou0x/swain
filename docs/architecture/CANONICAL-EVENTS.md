# Canonical Event Contract v0 (proposal)

## Domain entities
`Project` -> `Session` -> `Turn` -> `Event` (+ `Actor`, `Artifact`, `EvidenceReference`). A session may have subagent parent/child relationships. Events form a partial order, not necessarily a single wall-clock truth.

## Minimal event payload
```json
{
  "schemaVersion": "0.1.0",
  "eventId": "evt_0003",
  "sessionId": "session_01",
  "turnId": "turn_02",
  "provider": "claude-code",
  "providerVersion": "unknown",
  "kind": "tool.completed",
  "timestamp": "2026-11-15T12:00:00.000Z",
  "sourceSequence": 3,
  "actorId": "agent_root",
  "parentEventId": "evt_0002",
  "status": "success",
  "payload": {"toolName": "Bash", "resultSummary": "exit 0"},
  "provenance": {"sourceId": "redacted-fixture", "line": 12, "sha256": "<actual-64-hex-hash>"},
  "completeness": {"inputs": "captured", "outputs": "captured", "internalReasoning": "unavailable"}
}
```
Example only; P0 architect decides exact field enums and validators.

## Event families
`session.started`, `session.ended`, `turn.started`, `turn.ended`, `message.observed`, `tool.requested`, `tool.completed`, `tool.failed`, `agent.started`, `agent.ended`, `file.changed`, `permission.requested`, `permission.decided`, `model.usage`, `capture.gap`, `source.unknown`.

## Invariants
- Stable ingestion-derived IDs; idempotent import; duplicate events merged or reported, not silently counted twice.
- Source sequence primary within source, timestamps advisory; causal links used where available.
- A completed result may be absent for crash/interruption; status remains partial.
- `provenance` references exact source record/hash, never guessed.
- Raw content is sensitive and opt-in; summaries do not replace original hashes.
- Unknown event types survive transformation, with warning.
- Normalize malformed/untrusted strings without evaluating code or following hyperlinks.
