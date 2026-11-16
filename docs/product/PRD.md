# Product Requirements Document — Swain

## Value proposition
"Every observable action. Every tool. Every step. Explained, with evidence."

## Personas
- Developer diagnosing agent-generated bugs and failed tasks.
- Security researcher documenting an *authorized* investigation.
- Maintainer reviewing agent operations for reproducibility and auditability.

## Required user journeys
1. Import a provider-native session or event stream locally.
2. Inspect normalized events (provider, timestamp, status, actor, command, output refs).
3. See provenance and capture limitations (what the runtime did or didn't expose).
4. Export structured JSON and deterministic Markdown chronological journal (P0).
5. Generate natural-language explanations with citations (P1), opt-in BYO model/local model.
6. Group multiple sessions into an investigation with evidence links (later).

## Principles
- Four integrations architecturally supported from P0; one working importer is sufficient to finish first slice.
- Evidence is different from interpretation; no claims of hidden chain-of-thought.
- No third-party or vendor hosting, no registration with the project, no product telemetry, no forced cloud inference. Self-hosted Swain servers run by the user or their team are allowed (Swain amendment 2026-11-16, ADR-0004); loopback-only by default.
- Source adapters versioned; failures isolated; unknown events retained with classification.
- Full CLI usefulness before UI.

## Success / not-success
Success: source-to-event mapping traceable, no fabricated steps, graceful partial captures, offline export, malicious fixtures safely handled. Failure: output is a hallucinated summary without supporting event IDs, hardwired to Claude transcript schema, or leaks secrets to model endpoints.
