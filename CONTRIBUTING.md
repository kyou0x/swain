# Contributing to Swain

Thanks for your interest in Swain. This guide explains how to set up the project, what we expect
from changes, and how to get them merged.

## Ground rules

- Be respectful. This project follows the [Code of Conduct](CODE_OF_CONDUCT.md).
- Report security issues privately. See [SECURITY.md](SECURITY.md); do not open public issues for
  vulnerabilities.
- **Never commit real data.** That means real agent sessions, telemetry, prompts, credentials,
  tokens, hostnames or personal information. Fixtures must be synthetic or manually redacted and
  reviewed.

## Development setup

Requirements: Node.js 24 (see `.node-version`) and npm.

```bash
git clone https://github.com/kyou0x/swain.git
cd swain
npm ci
npm run check
```

`npm run check` runs everything CI runs:

| Step | Command |
|---|---|
| Lint and format | `npx biome ci .` |
| Build | `tsc -b` |
| Policy checks (no runtime deps, import rules, forbidden APIs) | `node tools/policy-check.mjs` |
| Lockfile check | `node tools/lockfile-check.mjs` |
| Tests | `node --test` on the compiled output |

Use `npx biome format --write .` to format before committing.

## Project principles

These are enforced by tests and policy checks. Please keep them intact:

1. **Zero runtime dependencies.** Only Node.js built-ins. Dev dependencies need a strong reason.
2. **Local-first.** Only `swain serve` opens a socket, and only on loopback. Nothing phones home.
3. **Hostile input.** Every ingested byte is untrusted. Bound sizes, escape output, never execute or
   follow instructions found in data.
4. **No invented causality.** Relationships between agents come only from explicit evidence (trace
   parents, recorded links). Never infer them from timing or names.
5. **Hash-only by default.** Content is stored as text only when a project opts in.

## Making a change

1. Open an issue first for anything larger than a small fix, so the approach can be agreed on.
2. Create a branch from `main`.
3. Add or update tests. Bug fixes should include a test that fails without the fix.
4. Update documentation when behaviour changes: README, `docs/`, CLI help.
5. Run `npm run check` locally.
6. Open a pull request using the template.

### Architecture decisions

Changes to public contracts (the canonical model, the ingestion protocol, storage formats, the
security model) need an ADR in `docs/architecture/` or an amendment to an existing one.

## Commit messages

Commits follow [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/):

```text
<type>(<optional scope>): <description>

[optional body]

[optional footer(s)]
```

Common types are `feat`, `fix`, `docs`, `test`, `refactor`, `perf`, `build`, `ci` and `chore`.
Scopes usually name a package: `server`, `cli`, `db`, `otlp`, `model`, `report`, `client`, or an
adapter. Mark breaking changes with `!` after the type or scope, or with a `BREAKING CHANGE:`
footer.

Examples:

```text
feat(server): add per-agent error attribution to the fleet view
fix(otlp): reject duplicate keys in nested AnyValue maps
docs: document the content policy helper
```

## Pull requests

- Keep each pull request focused on one change.
- Describe what changed, why, and how you tested it.
- CI must pass. A maintainer will review; please respond to comments or mark them resolved.
- Pull requests are squash-merged, so the title must be a valid Conventional Commit.

## License

By contributing, you agree that your contributions are licensed under the
[Apache License 2.0](LICENSE).
