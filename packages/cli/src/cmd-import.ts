import {
  ABSOLUTE_MAX_FILE_BYTES,
  AtmError,
  type Bounds,
  DEFAULT_BOUNDS,
  DEFAULT_WALK_OPTIONS,
  type ImportResult,
  PROVIDERS,
  type ProviderId,
  readSourceFile,
  runImport,
  type Selection,
  selectAdapter,
  walkImportPaths,
} from "@swain/core";
import { type PutStatus, StoreError } from "@swain/store";
import { parseCount } from "./args.js";
import {
  type Ctx,
  EXIT,
  flagOn,
  flagValue,
  labelText,
  maskPath,
  openStoreFor,
  STORE_MESSAGES,
  usageError,
} from "./context.js";
import { REGISTRATIONS } from "./registry.js";
import { echoToken, esc, plural, shortImportId } from "./text.js";

/** SPEC-002 / core `MAX_INLINE_BYTES_LIMIT`: the largest inline content cap a user may request. */
const MAX_INLINE_BYTES_CAP = 1_048_576;

type RejectCode =
  | "not-regular"
  | "too-large"
  | "no-match"
  | "ambiguous"
  | "unsupported"
  | "zstd-unavailable"
  | "changed-during-import"
  | "source-unreadable"
  | "internal";

const REJECT_HINT: Readonly<Record<RejectCode, string>> = {
  "not-regular": "only regular files can be imported (no pipes, devices or directories)",
  "too-large": "the file exceeds the size limit; raise it with --max-file-bytes (max 1 GiB)",
  "no-match":
    "no adapter recognised this file; try --provider/--source-kind, or run 'swain sources'",
  ambiguous: "more than one adapter matched; narrow it with --provider and --source-kind",
  unsupported: "recognised, but this format mode or version is not supported",
  "zstd-unavailable": "this Node.js build cannot decompress zstd",
  "changed-during-import": "the file changed while it was being read; try again",
  "source-unreadable": "the path could not be read",
  internal: "unexpected failure while importing this file",
};

const ATM_CODE: Readonly<Record<string, RejectCode>> = {
  "not-regular-file": "not-regular",
  "file-too-large": "too-large",
  "source-changed-during-import": "changed-during-import",
  "zstd-unavailable": "zstd-unavailable",
  "source-unreadable": "source-unreadable",
};

function severity(code: number): number {
  // 1 > 7 > 4 > 3 > 0
  switch (code) {
    case EXIT.internal:
      return 4;
    case EXIT.store:
      return 3;
    case EXIT.rejected:
      return 2;
    case EXIT.partial:
      return 1;
    default:
      return 0;
  }
}

function worse(a: number, b: number): number {
  return severity(b) > severity(a) ? b : a;
}

function isProvider(v: string): v is ProviderId {
  return (PROVIDERS as readonly string[]).includes(v);
}

export function runImportCommand(ctx: Ctx): number {
  const provider = flagValue(ctx, "--provider");
  if (provider !== undefined && !isProvider(provider)) {
    return usageError(ctx, `--provider must be one of: ${PROVIDERS.join(", ")}`);
  }
  const sourceKind = flagValue(ctx, "--source-kind");
  const maxFileRaw = flagValue(ctx, "--max-file-bytes");
  const maxFile =
    maxFileRaw === undefined
      ? DEFAULT_BOUNDS.maxFileBytes
      : parseCount(maxFileRaw, 1, ABSOLUTE_MAX_FILE_BYTES);
  if (maxFile === null) {
    return usageError(
      ctx,
      `--max-file-bytes must be an integer from 1 to ${ABSOLUTE_MAX_FILE_BYTES}`,
    );
  }
  const maxInlineRaw = flagValue(ctx, "--max-inline-bytes");
  const maxInline =
    maxInlineRaw === undefined
      ? DEFAULT_BOUNDS.maxInlineContentBytes
      : parseCount(maxInlineRaw, 0, MAX_INLINE_BYTES_CAP);
  if (maxInline === null) {
    return usageError(
      ctx,
      `--max-inline-bytes must be an integer from 0 to ${MAX_INLINE_BYTES_CAP}`,
    );
  }
  const include = flagOn(ctx, "--include-content");
  const reimport = flagOn(ctx, "--reimport");
  const bounds: Bounds = { ...DEFAULT_BOUNDS, maxFileBytes: maxFile };
  const contentPolicy = include
    ? ({ retention: "inline", maxInlineBytes: maxInline } as const)
    : ({ retention: "hash-only", maxInlineBytes: 0 } as const);
  const selection: Selection = {
    ...(provider === undefined ? {} : { provider }),
    ...(sourceKind === undefined ? {} : { sourceKind }),
  };

  const store = openStoreFor(ctx);
  if (store === null) return EXIT.usage;

  if (include) ctx.out("note: content is stored with best-effort secret masking\n");

  let exit: number = EXIT.ok;
  const counts: Record<PutStatus | "rejected" | "store-error", number> = {
    added: 0,
    unchanged: 0,
    replaced: 0,
    "skipped-version": 0,
    rejected: 0,
    "store-error": 0,
  };
  let anyExperimental = false;
  let anyHashOnlyStored = false;
  const where = (p: string): string => esc(maskPath(ctx, p));

  // Each positional is walked on its own: an unreadable explicit path is rejected for that path
  // only, and the others are still processed (SPEC-002 section 8).
  const found = new Set<string>();
  const skipped = { symlinks: 0, nonRegular: 0, unmatched: 0, depthOrCount: 0 };
  let unreadablePaths = 0;
  for (const p of ctx.inv.positionals) {
    let walked: ReturnType<typeof walkImportPaths>;
    try {
      walked = walkImportPaths([p], REGISTRATIONS, {
        ...DEFAULT_WALK_OPTIONS,
        maxFiles: Math.max(0, DEFAULT_WALK_OPTIONS.maxFiles - found.size),
      });
    } catch (e) {
      if (!(e instanceof AtmError)) throw e;
      unreadablePaths++;
      ctx.out(`rejected  source-unreadable  ${echoToken(maskPath(ctx, p))}\n`);
      ctx.out(`          ${REJECT_HINT["source-unreadable"]}\n`);
      exit = worse(exit, EXIT.rejected);
      continue;
    }
    for (const f of walked.files) found.add(f);
    skipped.symlinks += walked.skipped.symlinks;
    skipped.nonRegular += walked.skipped.nonRegular;
    skipped.unmatched += walked.skipped.unmatched;
    skipped.depthOrCount += walked.skipped.depthOrCount;
  }
  const walk = { files: [...found].sort(), skipped };

  const explicit = new Set(ctx.inv.positionals);
  for (const file of walk.files) {
    const reject = (code: RejectCode): void => {
      counts.rejected++;
      ctx.out(`rejected  ${code}  ${where(file)}\n`);
      ctx.out(`          ${REJECT_HINT[code]}\n`);
      exit = worse(exit, code === "internal" ? EXIT.internal : EXIT.rejected);
    };
    let result: ImportResult;
    let selected: ReturnType<typeof selectAdapter>;
    let src: ReturnType<typeof readSourceFile>;
    try {
      // Files found by the directory walk are opened with O_NOFOLLOW; explicit arguments are followed.
      src = readSourceFile(file, bounds, explicit.has(file) ? {} : { followSymlinks: false });
      selected = selectAdapter(src, REGISTRATIONS, selection, bounds);
      if (!selected.ok) {
        reject(selected.reason);
        if (selected.reason === "ambiguous" && selected.candidates.length > 0) {
          ctx.out(`          candidates: ${selected.candidates.map(esc).join(", ")}\n`);
        }
        continue;
      }
      result = runImport(src, selected.registration, selected.detect, { bounds, contentPolicy });
    } catch (e) {
      reject(e instanceof AtmError ? (ATM_CODE[e.code] ?? "internal") : "internal");
      continue;
    }
    const manifest = selected.registration.adapter.manifest;
    let put: ReturnType<typeof store.put>;
    try {
      put = store.put(result, {
        adapter: {
          id: manifest.id,
          version: manifest.adapterVersion,
          sourceStability: manifest.sourceStability,
          experimental: manifest.experimental,
        },
        sourcePath: file,
        container: src.container,
        contentRetention: contentPolicy.retention,
        reimport,
      });
    } catch (e) {
      if (!(e instanceof StoreError)) throw e;
      if (counts["store-error"]++ === 0) {
        ctx.err(`swain: store error (${e.code}): ${STORE_MESSAGES[e.code]}\n`);
      }
      ctx.out(`store-error  ${e.code}  ${where(file)}\n`);
      exit = worse(exit, EXIT.store);
      continue;
    }
    counts[put.status]++;
    const r = put.record;
    anyExperimental ||= r.adapter.experimental;
    if (put.status === "added" || put.status === "replaced") {
      anyHashOnlyStored ||= r.contentRetention === "hash-only";
    }
    const s = result.stats;
    const partial = result.outcome !== "complete" || s.gaps > 0 || s.unknowns > 0;
    if (partial) exit = worse(exit, EXIT.partial);
    ctx.out(
      `${put.status.padEnd(9)}  ${shortImportId(r.importId)}  ${esc(r.adapter.id)}  ${where(file)}\n`,
    );
    ctx.out(
      `           ${result.outcome}: ${plural(result.events.length, "event")}, ${plural(s.gaps, "gap")}, ${plural(s.unknowns, "unknown record")}, ${plural(result.warnings.length, "warning")}  ${labelText(r)}\n`,
    );
    if (put.status === "unchanged" && r.contentRetention !== contentPolicy.retention) {
      ctx.out(
        `           note: the stored import is ${r.contentRetention}; use --reimport to change it\n`,
      );
    }
    if (put.status === "skipped-version") {
      ctx.out(
        `           note: stored by adapter ${esc(r.adapter.version)}; use --reimport to re-import with ${esc(manifest.adapterVersion)}\n`,
      );
    }
  }

  const sk = walk.skipped;
  const skippedTotal = sk.symlinks + sk.nonRegular + sk.unmatched + sk.depthOrCount;
  if (skippedTotal > 0) {
    ctx.out(
      `skipped: ${plural(sk.symlinks, "symlink")}, ${plural(sk.nonRegular, "non-regular file")}, ${sk.unmatched} unmatched by name, ${sk.depthOrCount} beyond depth/count limits\n`,
    );
  }
  if (walk.files.length === 0) {
    if (unreadablePaths === 0) {
      ctx.out(
        "nothing to import: no file matched. Pass file paths directly, or see 'swain sources'.\n",
      );
    }
  } else {
    const done = [
      `${counts.added} added`,
      `${counts.unchanged} unchanged`,
      `${counts.replaced} replaced`,
      `${counts["skipped-version"]} skipped (adapter version)`,
      `${counts.rejected} rejected`,
      ...(counts["store-error"] > 0 ? [`${counts["store-error"]} store errors`] : []),
      ...(unreadablePaths > 0 ? [`${plural(unreadablePaths, "unreadable path")}`] : []),
    ].join(", ");
    ctx.out(`\n${plural(walk.files.length, "file")}: ${done}.\n`);
  }
  if (anyExperimental) {
    ctx.out(
      "note: these adapters are experimental. They were built from documentation and source research,\n" +
        "      not verified against real provider files; unrecognised records are kept as source.unknown.\n",
    );
  }
  if (anyHashOnlyStored) {
    ctx.out(
      "note: content is stored as hashes only. Use --include-content to keep (best-effort masked) text.\n",
    );
  }
  if (exit === EXIT.partial) {
    ctx.out(
      "result: at least one import has gaps, unknown records, or did not complete (exit code 3).\n",
    );
  }
  return exit;
}
