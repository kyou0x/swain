import { escapeControlChars } from "@swain/core";

/**
 * Compare two possibly untrusted strings. On mismatch only escaped text is
 * printed, on a single line, so a hostile string cannot inject terminal or
 * CI workflow commands (L2). This is the canonical copy; core and cli keep
 * identical copies because cross-package test imports are not allowed (N11).
 */
export function assertEqualEscaped(actual: string, expected: string): void {
  if (actual !== expected) {
    throw new Error(
      `actual: ${escapeControlChars(actual.slice(0, 2000))} expected: ${escapeControlChars(expected.slice(0, 2000))}`,
    );
  }
}
