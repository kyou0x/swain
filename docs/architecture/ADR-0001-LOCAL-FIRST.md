# ADR-0001: Local-first, adapter-driven, event-sourced core
Status: Proposed (requires architecture review)

## Decision
Prefer a TypeScript strict monorepo with packages for schema, ingestion, adapters, storage, narration and reports; CLI first. SQLite and a local content-addressed artifact directory. Four provider adapters share a single versioned event contract, never internal implementations.

## Reasons
Easy contributor onboarding; portable JSON artifacts; enables offline-first operation; keeps integrations isolated from provider release changes.

## Trade-offs
Provider completeness differs. Hooks can block or delay host agents if poorly implemented. Imported historical sessions and live event streams may have different ordering and information. Capture cannot guarantee OS-wide completeness, and deterministic replay is a separate later research problem.

## Alternatives to reevaluate
Rust collector later for single-binary distribution; OpenTelemetry semantic conventions as additional export; append-only store when concurrency requires it.
