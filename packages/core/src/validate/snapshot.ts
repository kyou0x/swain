import { LIMITS } from "../schema/constants.js";
import type { IssueSink, PathSeg } from "./issues.js";

export type Snap = null | boolean | number | string | readonly Snap[] | SnapObject;
export interface SnapObject {
  readonly [key: string]: Snap;
}

function isAccessor(d: PropertyDescriptor): boolean {
  return Object.hasOwn(d, "get") || Object.hasOwn(d, "set");
}

/**
 * Copies untrusted input into a null-prototype snapshot (C7, C12).
 * - Only plain objects/arrays (exact prototypes) and typeof-exact primitives pass.
 * - Key counts and array lengths are bounded BEFORE iteration.
 * - Every property is read exactly once through getOwnPropertyDescriptor; accessors
 *   are rejected. Proxy traps therefore run at most once per property and later
 *   validation works on this copy only.
 * Failures are recorded in `sink`; the failed position holds `null`.
 */
export function snapshot(v: unknown, sink: IssueSink, path: PathSeg[], depth: number): Snap {
  switch (typeof v) {
    case "string":
    case "boolean":
    case "number":
      return v;
    case "object":
      if (v === null) return null;
      break;
    default:
      sink.add(path, "wrong-type");
      return null;
  }
  const obj: object = v;
  if (depth + 1 > LIMITS.maxDepth) {
    sink.add(path, "depth-exceeded");
    return null;
  }
  if (Array.isArray(obj)) {
    if (Object.getPrototypeOf(obj) !== Array.prototype) {
      sink.add(path, "not-plain-data");
      return null;
    }
    const len = obj.length;
    if (len > LIMITS.maxArrayLength) {
      sink.add(path, "too-many-items");
      return null;
    }
    if (Object.getOwnPropertyNames(obj).length !== len + 1) {
      sink.add(path, "not-plain-data");
      return null;
    }
    const items: Snap[] = [];
    for (let i = 0; i < len; i++) {
      path.push(i);
      const d = Object.getOwnPropertyDescriptor(obj, String(i));
      if (d === undefined) {
        sink.add(path, "not-plain-data");
        items.push(null);
      } else if (isAccessor(d)) {
        sink.add(path, "accessor-property");
        items.push(null);
      } else {
        items.push(snapshot(d.value, sink, path, depth + 1));
      }
      path.pop();
      if (sink.full) break;
    }
    return items;
  }
  const proto = Object.getPrototypeOf(obj);
  if (proto !== Object.prototype && proto !== null) {
    sink.add(path, "not-plain-data");
    return null;
  }
  const names = Object.getOwnPropertyNames(obj);
  if (names.length > LIMITS.maxObjectKeys) {
    sink.add(path, "too-many-keys");
    return null;
  }
  const out: Record<string, Snap> = Object.create(null);
  for (const name of names) {
    path.push(name);
    const d = Object.getOwnPropertyDescriptor(obj, name);
    if (d === undefined) {
      sink.add(path, "not-plain-data");
    } else if (isAccessor(d)) {
      sink.add(path, "accessor-property");
    } else if (d.enumerable === true) {
      Object.defineProperty(out, name, {
        value: snapshot(d.value, sink, path, depth + 1),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    path.pop();
    if (sink.full) break;
  }
  return out;
}
