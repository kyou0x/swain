# Swain quickstart (N1: server, keys, OTLP ingest, fleet pages)

Swain is local and loopback only. `swain serve` is the only command that opens a socket, and it
binds `127.0.0.1` and `[::1]`, never `0.0.0.0`. Everything below runs on one machine as one user.
The offline `atm` / `swain import|sessions|show|report|ui` commands are unchanged.

## 0. Build

```bash
npm ci
npm run build
```

There is no global install. The commands below write `swain`; define it once per shell (an alias
for interactive use, or call the script directly):

```bash
alias swain='node packages/cli/dist/src/swain-bin.js'
# or, without an alias:  npm run swain -- <command>   (the repo script, same file)
```

## 1. Start the server

```bash
swain serve                       # 127.0.0.1 and [::1], port 4318
swain serve --port 0              # any free port; the printed URL names it
swain serve --host 127.0.0.1 --db /absolute/path/swain.sqlite
```

What it creates (the first run only): a `0700` directory under `$XDG_DATA_HOME/swain/`
(default `~/.local/share/swain/`) holding a `0600` SQLite file, and a `0600` runtime file
`$XDG_STATE_HOME/swain/server-<port>.json` (default `~/.local/state/swain/`) with the server origin
and its instance ID. It prints only literal-IP URLs. Ctrl-C or SIGTERM stops it and removes the
runtime file.

`--host` accepts exactly `127.0.0.1` or `::1`. Any other value, including `localhost`, is refused.

## 2. Create a key

```bash
swain keys create --project demo --agent planner --save
```

- The key is pinned to the agent name by default (`--no-pin` removes the pin).
- `--save` writes `~/.config/swain/credentials/demo.key` (directory `0700`, file `0600`, created
  with `O_EXCL | O_NOFOLLOW`, never overwritten) and records the server origin in it. The secret is
  not printed; the output shows the placeholder `<SWAIN_KEY>` and the file path.
- `--show-secret` prints the secret once instead (a terminal or CI log can keep it).
- No command accepts a key on the command line. Keys live in credential files only.

```bash
swain keys list                   # never shows secrets
swain keys revoke key_0123456789abcdef
```

## 3. Send telemetry

**Protobuf is off.** Until the protobuf decoder passes its gate, the server answers `415` to
`application/x-protobuf`. Exporters must use OTLP/HTTP with JSON:

```bash
export OTEL_EXPORTER_OTLP_PROTOCOL=http/json
```

Print the exporter settings (this writes nothing and sends nothing):

```bash
swain connect otlp                # generic exporter
swain connect claude-code         # Claude Code telemetry env block, content logging off
```

Replace `<SWAIN_KEY>` with the secret from the credential file. For Claude Code, prefer an
`otelHeadersHelper` command that prints the `Authorization` header from the credential file over
pasting the key into `settings.json`.

To try the pipeline without any agent, post the synthetic fixtures with the saved key:

```bash
SECRET=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.env.HOME+"/.config/swain/credentials/demo.key","utf8")).secret)')
curl -sS -H "Authorization: Bearer $SECRET" -H "Content-Type: application/json" \
  --data-binary @fixtures/otlp/traces-genai.json http://127.0.0.1:4318/v1/traces
curl -sS -H "Authorization: Bearer $SECRET" -H "Content-Type: application/json" \
  --data-binary @fixtures/otlp/logs-claude-code.json http://127.0.0.1:4318/v1/logs
```

(Replace the port if you started with `--port 0`.) Passing a key to `curl -H` puts it in that
process's argv; use it only on a machine where that is acceptable, or use an exporter that reads the
header from the environment.

## 4. Check the server

```bash
swain status --project demo
```

The client first proves the server is the one it was told about (an HMAC over the origin and a fresh
challenge, using the key's proof secret) and only then sends the key. If the listener on the port is
something else, or the origin in the credential does not match, it exits `8` (or `2` for a
mismatched origin) and sends no key.

## 5. Open the pages

```bash
swain open                        # prints http://127.0.0.1:<port>/
swain open run <run_id>           # or agent <agent_id>, or a unique ID prefix
```

There is no login. `swain open` checks that the server answers, then prints the plain page URL
(`/`, `/a/<agent_id>` or `/r/<run_id>`) after proving the server uses your database; it creates no code and never launches a browser. Open the
URL in your browser. With no running server it prints nothing and exits 8.

Pages open to every process and user on this machine. They show exporter-supplied metadata (names, attribute values; masked best effort, possibly
PII or secrets) and inline content for projects whose policy is `inline`. The server accepts only
its own loopback Host names (so DNS rebinding fails) and refuses cross-site fetches from browsers
that send Fetch Metadata; other browsers are still stopped from reading responses by the
same-origin policy. On a shared host, start the server with a login:

```bash
swain serve --require-login       # pages need a session; swain open prints a single-use login URL
```

With `--require-login`, `swain open` prints a URL that works once, for 60 seconds. Paste it into
your browser (do not use `xdg-open`, which puts the URL in a process's argv where other local users
can read it). The page shows a button, and the code is consumed only when you press it. The session
cookie is `swain_session`, `HttpOnly`, `SameSite=Strict`, host-only, 2 hours idle and 24 hours
absolute, and `Sign out` is on every page.

Pages (no JavaScript, same CSP and theme as the static report):

- `/` the fleet: agents, status (active, idle, ended, incomplete), last seen, run count and the
  credentials that contributed. `?p=<project>` selects a project.
- `/a/<agent_id>` one agent and its runs. `/runs` all runs.
- `/r/<run_id>` one run: credentials header, waterfall and spans. "multiple credentials
  contributed" is shown when more than one key fed the run.

Status is computed from receipt times and end evidence. Agents do not report it.

On the fleet page the `error` flag is per agent: an error span marks its own agent and the agent
span that encloses it, only within spans of the same key. It never spreads to sibling agents,
parents of sub-agents or other keys' agents. For very large runs the run-wide flag is shown.

## Residual risks (read these)

- **Loopback is not a confidentiality boundary on a shared host (threat T-N3).** `swain status` and
  `swain keys`/`swain open` authenticate the server before they send a key or write a login code,
  but third-party exporters (Claude Code, OpenTelemetry SDKs and similar) cannot: they send the
  `Authorization` key to whatever listens on the configured port. On a machine with other users,
  another process that wins the port before `swain serve` starts would receive those keys. Use
  narrowly scoped, agent-pinned, revocable keys, start `swain serve` first, and prefer a
  single-user machine.
- **Without login, local readers see the pages.** By default (owner decision 2026-11-16) any local
  process or user can read the pages over loopback; use `swain serve --require-login` on a shared host.
- **Cookies (`--require-login` only) are not isolated by port (threat T-N4b).** Browsers share cookies between
  `127.0.0.1:<port>` origins of the same host. Another web app on a different local port can send
  the `swain_session` cookie of this server, and the cookie is also sent to it. The session is
  short (2 hours idle, 24 hours absolute) and `Sign out` revokes it server-side, but treat any other
  local web app in the same browser profile as able to see it.
- **`swain open` talks to the server first.** With `--require-login` it proves that the listener on
  the runtime file's port uses your database before it writes a login code or prints a URL. In the
  default mode it runs the same proof and then prints a plain URL. With no runtime file, or
  a stale one, it prints nothing and exits 8. It never guesses port 4318.

## What is not claimed

- Integrations (Claude Code, Codex, Gemini, OpenCode, generic OTLP exporters) are documented routes,
  **untested** until a real capture of that tool passes the gate. Only the synthetic fixtures in
  `fixtures/otlp/` have been exercised.
- Runs that hold only OTLP logs show a header only; the event view for logs is not built yet.
- Known follow-up: used and expired login codes and revoked or expired sessions stay in the
  database until a prune is added; the database layer forbids `DELETE` statements, and that rule is
  not relaxed here.
- Not in N1: `swain connect --write`, hooks, spool/push, `swain admin`, search, a settings page.
- Metadata strings on pages are masked best effort (home-directory prefixes); masking is not a
  guarantee, and hash-only content is shown as a hash, never as content. Do not share these pages.

## Stopping and cleaning up

Ctrl-C (or `kill -TERM <pid>`) stops the server. To remove everything: delete
`~/.local/share/swain`, `~/.local/state/swain` and `~/.config/swain`.
