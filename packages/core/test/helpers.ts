import { escapeControlChars } from "../src/text/index.js";

/**
 * Compare two possibly untrusted strings. On mismatch only escaped text is
 * printed, on a single line, so a hostile string cannot inject terminal or
 * CI workflow commands (L2). Identical copies live in the other packages'
 * test/helpers.ts; reviewers diff them (N11).
 */
export function assertEqualEscaped(actual: string, expected: string): void {
  if (actual !== expected) {
    throw new Error(
      `actual: ${escapeControlChars(actual.slice(0, 2000))} expected: ${escapeControlChars(expected.slice(0, 2000))}`,
    );
  }
}
