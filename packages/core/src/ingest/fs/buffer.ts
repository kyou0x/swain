/**
 * Pure source construction from bytes already in memory (SPEC-003 N0, ADR-0004 section 4). Shares
 * the container, display-name and zstd logic with `readSourceFile`; opens no file.
 */
import { basename } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import { ABSOLUTE_MAX_FILE_BYTES, type Bounds } from "../../adapter/contract.js";
import { AtmError } from "../../errors.js";
import { sha256Hex } from "../../ids/index.js";
import type { Hex64 } from "../../schema/types.js";
import { truncateUtf8 } from "../../text/index.js";

export interface SourceBytes {
  readonly bytes: Uint8Array;
  readonly sha256: Hex64;
  readonly byteLength: number;
  readonly container: {
    readonly encoding: "none" | "zstd";
    readonly sha256: Hex64;
    readonly byteLength: number;
  };
  /** Sanitized basename (ADR-0002 section 1a). */
  readonly displayName: string;
}

const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd] as const;
const DISPLAY_NAME_MAX_BYTES = 255;
// biome-ignore lint/suspicious/noControlCharactersInRegex: neutralizing control characters is the purpose
const UNSAFE_NAME_CHARS = /[\u0000-\u001f\u007f-\u009f\\/؜‎‏‪-‮⁦-⁩]/g;

/** ADR-0002 section 1a: no `/`, `\`, NUL; control and bidi characters replaced as well. */
export function sanitizeDisplayName(path: string): string {
  let name = basename(path).toWellFormed().replace(UNSAFE_NAME_CHARS, "_");
  name = truncateUtf8(name, DISPLAY_NAME_MAX_BYTES).text;
  return name === "" || name === "." || name === ".." ? "source" : name;
}

function isZstd(b: Uint8Array): boolean {
  return b.length >= 4 && ZSTD_MAGIC.every((m, i) => b[i] === m);
}

function errorCode(e: unknown): string | undefined {
  if (typeof e !== "object" || e === null) return undefined;
  const code = (e as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function decompress(raw: Uint8Array, bounds: Bounds): Uint8Array {
  let out: Uint8Array;
  try {
    out = zstdDecompressSync(raw, { maxOutputLength: Math.max(1, bounds.maxFileBytes) });
  } catch (e) {
    if (errorCode(e) === "ERR_BUFFER_TOO_LARGE") throw new AtmError("file-too-large");
    throw new AtmError("zstd-unavailable");
  }
  if (out.length > bounds.maxFileBytes) throw new AtmError("file-too-large");
  return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
}

/** Boundary check of the size bound shared by the file and buffer paths. */
export function assertFileLimit(bounds: Bounds): number {
  const limit = bounds.maxFileBytes;
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > ABSOLUTE_MAX_FILE_BYTES) {
    throw new AtmError("invalid-option");
  }
  return limit;
}

/**
 * Shared tail of both readers: container hashing, zstd detection and the decompressed bound.
 * `owned` is true when `raw` is private to this call (so it may be returned without a copy).
 */
export function finishSource(
  raw: Uint8Array,
  path: string,
  bounds: Bounds,
  owned: boolean,
): SourceBytes {
  const displayName = sanitizeDisplayName(path);
  const containerSha = sha256Hex(raw);
  if (!isZstd(raw)) {
    return {
      bytes: owned ? raw : raw.slice(),
      sha256: containerSha,
      byteLength: raw.length,
      container: { encoding: "none", sha256: containerSha, byteLength: raw.length },
      displayName,
    };
  }
  const bytes = decompress(raw, bounds);
  return {
    bytes,
    sha256: sha256Hex(bytes),
    byteLength: bytes.length,
    container: { encoding: "zstd", sha256: containerSha, byteLength: raw.length },
    displayName,
  };
}

/**
 * The `SourceBytes` of `bytes` as if they had been read from a file named `displayName`
 * (`readSourceFile` on the same bytes gives the same result). Throws `AtmError`
 * `invalid-option`, `file-too-large` or `zstd-unavailable`. The caller's array is never aliased.
 */
export function sourceFromBuffer(
  bytes: Uint8Array,
  displayName: string,
  bounds: Bounds,
): SourceBytes {
  const limit = assertFileLimit(bounds);
  if (!(bytes instanceof Uint8Array) || typeof displayName !== "string") {
    throw new AtmError("invalid-option");
  }
  if (bytes.length > limit) throw new AtmError("file-too-large");
  return finishSource(bytes, displayName, bounds, false);
}
