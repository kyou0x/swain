/**
 * Home-directory masking for display surfaces (SPEC-002 M-12). Pure; POSIX separators only.
 * Canonical events keep the raw path; only display text is masked.
 */

/** `/home/u/x` with home `/home/u` becomes `~/x`; the home directory itself becomes `~`. */
export function maskHome(path: string, homeDir: string | null): string {
  if (homeDir === null || !homeDir.startsWith("/")) return path;
  let home = homeDir;
  while (home.length > 1 && home.endsWith("/")) home = home.slice(0, -1);
  // The filesystem root would mask every absolute path.
  if (home === "/") return path;
  if (path === home) return "~";
  if (path.startsWith(`${home}/`)) return `~${path.slice(home.length)}`;
  return path;
}
