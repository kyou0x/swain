# Initial threat model — STRIDE-lite

## Assets
Transcripts (may include secrets, source code, credentials, customer data), tool outputs, generated explanations, evidence links, local SQLite database, artifact store, CLI configuration, integrations.

## Trust boundaries
(1) Untrusted source files and tool output -> parser. (2) Raw source -> normalized event + persistence. (3) Event store -> narrative LLM (especially external providers). (4) Reports -> browser/HTML. (5) Adapter/hook installation -> host CLI. (6) Local user -> filesystem.

## Threat scenarios
- Prompt injection embedded in a transcript tries to instruct report generator or coding assistant.
- Secrets in Bash output, HTTP headers, `.env`, logs or patch diff leak into reports or LLM API.
- Malformed JSONL, oversized input, deeply nested payload, path traversal, symlinks, log injection cause crashes or file disclosure.
- XSS when tool output is rendered as HTML or Markdown.
- Replay accidentally reruns captured destructive shell command or network request.
- Malicious extension/hook executes with local user permissions.
- Provider event ambiguity leads to false attribution of a security action or fabricated vulnerability.

## Mitigations / verification
Deterministic schema validation, streaming bounds, path confinement, safe HTML escaping, local-only storage by default, mandatory redaction checks before remote inference, disabled outbound telemetry, explicit opt-in integration install, no command execution in P0-P3, source hashes and provenance. Add hostile fixture tests for each boundary.
