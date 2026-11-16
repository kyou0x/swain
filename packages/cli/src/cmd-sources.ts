/** `swain sources`: where each tool keeps session files. Pure: no filesystem access at all. */
import { type DiscoveryRoot, maskHome } from "@swain/core";
import { type Ctx, EXIT, homeDirOf } from "./context.js";
import { REGISTRATIONS } from "./registry.js";
import { esc } from "./text.js";

function resolveRoot(ctx: Ctx, root: DiscoveryRoot): string | null {
  const home = homeDirOf(ctx.env);
  const xdgData = ctx.env.XDG_DATA_HOME;
  let base: string | null = null;
  if (root.base === "home") base = home;
  else if (root.base === "xdg-data") {
    base = xdgData?.startsWith("/")
      ? xdgData.replace(/\/+$/, "")
      : home === null
        ? null
        : `${home}/.local/share`;
  } else base = home === null ? null : `${home}/.config`;
  if (base === null) return null;
  return [base, ...root.segments].join("/");
}

function captureHint(id: string): string {
  switch (id) {
    case "claude-code.stream-json":
      return "claude -p '<task>' --output-format stream-json --verbose > session.jsonl";
    case "codex-cli.exec-jsonl":
      return "codex exec --json '<task>' > session.jsonl";
    case "opencode.session-export":
      return "opencode export <sessionID> > session.json";
    default:
      return "the tool's exported session file";
  }
}

export function runSources(ctx: Ctx): number {
  ctx.out(
    "Where each tool usually keeps session files. swain never reads these locations by itself:\n" +
      "pass the files or directories you choose to 'swain import'.\n",
  );
  for (const reg of REGISTRATIONS) {
    const m = reg.adapter.manifest;
    const flags = [m.experimental ? "experimental" : null, m.sourceStability]
      .filter((x): x is string => x !== null)
      .join(", ");
    ctx.out(`\n${esc(m.id)}  [${flags}]\n`);
    if (reg.discovery.roots.length === 0) {
      ctx.out(
        `  location: none (save the tool's output to a file, e.g. ${esc(captureHint(m.id))})\n`,
      );
    }
    for (const root of reg.discovery.roots) {
      const resolved = resolveRoot(ctx, root);
      ctx.out(
        `  location: ${resolved === null ? "(HOME is not set)" : esc(maskHome(resolved, ctx.homeDir))}\n`,
      );
    }
    ctx.out(`  files:    ${esc(reg.discovery.fileNamePattern)}\n`);
  }
  ctx.out(
    "\nOpenCode keeps sessions in a database; export one first:  opencode export <session-id> > session.json\n" +
      "Then:  swain import session.json\n",
  );
  return EXIT.ok;
}
