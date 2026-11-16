import { STRING_BOUNDS, type StringBoundName } from "../schema/constants.js";
import { utf8ByteLength } from "../text/index.js";
import type { IssueCode, IssueSink, PathSeg } from "./issues.js";
import type { Snap, SnapObject } from "./snapshot.js";

export interface Ctx {
  readonly sink: IssueSink;
}
export type Path = PathSeg[];
/** Returns the validated, freshly built value, or `undefined` after reporting an issue. */
export type Check = (v: Snap | undefined, ctx: Ctx, path: Path) => unknown;

const REGEXES = new Map<string, RegExp>();
for (const [name, sb] of Object.entries(STRING_BOUNDS)) {
  if (sb.pattern !== null) REGEXES.set(name, new RegExp(sb.pattern));
}
const POINTER = /^(?:[^~]|~[01])*$/;

export function fail(ctx: Ctx, path: Path, code: IssueCode): undefined {
  ctx.sink.add(path, code);
  return undefined;
}

export function setOwn(target: object, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

export function isSnapObject(v: Snap | undefined): v is SnapObject {
  return v !== null && v !== undefined && typeof v === "object" && !Array.isArray(v);
}

export function str(name: StringBoundName): Check {
  const sb = STRING_BOUNDS[name];
  const re = REGEXES.get(name);
  return (v, ctx, path) => {
    if (typeof v !== "string") return fail(ctx, path, "wrong-type");
    const n = v.length > sb.bytes ? sb.bytes + 1 : utf8ByteLength(v);
    if (sb.exact ? n !== sb.bytes : n > sb.bytes) {
      return fail(ctx, path, sb.exact ? "wrong-length" : "too-long");
    }
    if (!v.isWellFormed()) return fail(ctx, path, "ill-formed-string");
    if (re !== undefined && !re.test(v)) return fail(ctx, path, "bad-pattern");
    if (sb.rule === "rfc6901") {
      if (!(v === "" || v.startsWith("/")) || !POINTER.test(v)) {
        return fail(ctx, path, "bad-pattern");
      }
    } else if (sb.rule === "no-nul") {
      if (v.includes("\u0000")) return fail(ctx, path, "forbidden-char");
    } else if (sb.rule === "display-name") {
      if (v.includes("\u0000") || v.includes("/") || v.includes("\\")) {
        return fail(ctx, path, "forbidden-char");
      }
    }
    return v;
  };
}

export function oneOf(values: readonly string[], code: IssueCode = "bad-enum"): Check {
  return (v, ctx, path) => {
    if (typeof v !== "string") return fail(ctx, path, "wrong-type");
    return values.includes(v) ? v : fail(ctx, path, code);
  };
}

export function int(min: number, max: number = Number.MAX_SAFE_INTEGER): Check {
  return (v, ctx, path) => {
    if (typeof v !== "number") return fail(ctx, path, "wrong-type");
    if (!Number.isSafeInteger(v)) return fail(ctx, path, "not-integer");
    if (Object.is(v, -0)) return fail(ctx, path, "negative-zero");
    if (v < min || v > max) return fail(ctx, path, "out-of-range");
    return v;
  };
}

/** Finite, non-negative number (only `costUsdEstimate` may be a float). */
export const nonNegativeNumber: Check = (v, ctx, path) => {
  if (typeof v !== "number") return fail(ctx, path, "wrong-type");
  if (!Number.isFinite(v) || v < 0) return fail(ctx, path, "out-of-range");
  return v;
};

export function nullable(check: Check): Check {
  return (v, ctx, path) => (v === null ? null : check(v, ctx, path));
}

export interface Field {
  readonly name: string;
  readonly check: Check;
  readonly optional?: boolean;
}

export const f = (name: string, check: Check): Field => ({ name, check });
export const opt = (name: string, check: Check): Field => ({ name, check, optional: true });

export function obj(
  fields: readonly Field[],
  post?: (out: Record<string, unknown>, ctx: Ctx, path: Path) => void,
): Check {
  const names = new Set(fields.map((x) => x.name));
  return (v, ctx, path) => {
    if (!isSnapObject(v)) return fail(ctx, path, "wrong-type");
    const before = ctx.sink.total;
    for (const k of Object.keys(v)) {
      if (!names.has(k)) {
        path.push(k);
        ctx.sink.add(path, "unknown-key");
        path.pop();
      }
    }
    const out: Record<string, unknown> = {};
    for (const field of fields) {
      if (!Object.hasOwn(v, field.name)) {
        if (field.optional !== true) {
          path.push(field.name);
          ctx.sink.add(path, "missing-key");
          path.pop();
        }
        continue;
      }
      path.push(field.name);
      const r = field.check(v[field.name], ctx, path);
      path.pop();
      if (r !== undefined) setOwn(out, field.name, r);
    }
    if (ctx.sink.total !== before) return undefined;
    if (post !== undefined) {
      post(out, ctx, path);
      if (ctx.sink.total !== before) return undefined;
    }
    return out;
  };
}

export function arr(item: Check, max: number, min = 0): Check {
  return (v, ctx, path) => {
    if (!Array.isArray(v)) return fail(ctx, path, "wrong-type");
    const list: readonly Snap[] = v;
    if (list.length > max) return fail(ctx, path, "too-many-items");
    if (list.length < min) return fail(ctx, path, "too-few-items");
    const before = ctx.sink.total;
    const out: unknown[] = [];
    for (let i = 0; i < list.length; i++) {
      path.push(i);
      const r = item(list[i], ctx, path);
      path.pop();
      if (r !== undefined) out.push(r);
    }
    return ctx.sink.total === before ? out : undefined;
  };
}
