# Fixtures
Commit only synthetic or manually redacted, reviewed samples. Keep per-provider versions and expected canonical output under source control. Include positive, partial, corrupt, adversarial and forward-compat cases. Never commit actual tokens, credentials, user chats or real target identifiers.

Suggested: fixtures/{claude-code,codex-cli,gemini-cli,opencode}/{version}/ and fixtures/expected/.

## Layout
- `fixtures/<provider>/<version | synthetic-doc-derived>/` with a `FIXTURE.json`
- `fixtures/expected/`, `fixtures/hostile/`, `fixtures/reference/`, `fixtures/canonical/`

Fixtures are evidence: never reformat. All fixtures are `-text` (no EOL normalization). `fixtures/hostile/**` is also `-diff`: review it with `cat -v` or `od -c`.

`fixtures/canonical/` holds the synthetic canonical-event fixtures: `valid/` (one event per kind plus a linked set), `invalid/` (one file per rejection family) and `INDEX.json`, which maps each file to `{valid, expectedIssueCodes, sha256}` with `sha256` over the file bytes.
