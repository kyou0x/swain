# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `swain serve`: a loopback-only HTTP server that ingests OTLP/HTTP JSON traces and logs into a
  hardened, append-only SQLite store.
- Fleet, agent, runs and run pages, server-rendered with no JavaScript and a strict CSP.
- Run view tabs: Commands, Timeline, Agents, Waterfall and Spans, with per-agent and
  per-credential attribution.
- Ingest keys: per project, agent-pinned by default, revocable and stored hashed. Includes
  `swain keys create|list|revoke`.
- `swain status` and `swain open`, which authenticate the server with an HMAC proof before sending a
  key or printing a URL.
- `swain connect otlp|claude-code`, which prints exporter settings.
- Optional `--require-login` mode with single-use login links and `HttpOnly`, `SameSite=Strict`
  sessions.
- Per-project content policy (`hash-only` by default, opt-in `inline`) with best-effort secret
  masking.
- Offline import and reports for Claude Code, Codex CLI, Gemini CLI and OpenCode session files:
  `import`, `sessions`, `show`, `explain`, `commands`, `report`, `ui` and `sources`.
- A demo multi-agent simulator and a content-policy helper in `examples/demo`.

[Unreleased]: https://github.com/kyou0x/swain/commits/main
