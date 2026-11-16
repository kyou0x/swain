# Security policy

## Supported versions

Swain is pre-1.0. Security fixes land on `main` and in the latest release only.

| Version | Supported |
|---|---|
| latest `0.x` / `main` | yes |
| older | no |

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Report vulnerabilities privately through GitHub:
[**Report a vulnerability**](https://github.com/kyou0x/swain/security/advisories/new)
(repository **Security** tab → **Advisories** → **Report a vulnerability**).

Please include:

- the affected component (server, CLI, an adapter, the report renderer, and so on) and version or
  commit;
- steps to reproduce, ideally with a minimal synthetic input;
- the impact you expect;
- any suggested fix.

Do not include real secrets, sessions or personal data in the report.

You can expect an acknowledgement within **5 business days** and a status update within
**14 days**. Once a fix is available, we will publish an advisory and credit you, unless you prefer
to stay anonymous.

## Scope

Swain's threat model is documented in
[`docs/security/THREAT-MODEL.md`](docs/security/THREAT-MODEL.md). In particular:

- **In scope:** escaping or CSP bypasses in rendered pages, authentication or server-proof bypasses,
  DNS rebinding, ingestion that crashes the server or exhausts resources beyond its documented
  limits, content-policy bypasses (content stored or shown when the policy is `hash-only`),
  cross-project or cross-credential data exposure, and path or file-permission issues in the
  CLI.
- **Out of scope (documented residual risks):** other local users or processes on the same machine
  reading pages when the server runs without `--require-login`; third-party exporters sending keys
  to whatever process holds the port; confirmation of guessed content through stored hashes; and the
  best-effort nature of secret masking.
