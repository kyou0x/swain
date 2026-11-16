import type { EventTime } from "../schema/types.js";

const RE =
  /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(?:([Zz])|([+-])(\d{2}):(\d{2}))$/;
const ASCII = /^[\x20-\x7E]+$/;
const MAX_LENGTH = 64;

const MISSING: EventTime = { value: null, origin: "none", status: "missing" };

function invalid(): EventTime {
  return { value: null, origin: "source", status: "invalid" };
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    return leap ? 29 : 28;
  }
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

/**
 * Normalize a source timestamp to `YYYY-MM-DDTHH:mm:ss.sssZ` (UTC, sub-ms truncated).
 * Never uses `Date.parse` and never reads the clock (SPEC-001 section 4, C5).
 */
export function normalizeTimestamp(raw: unknown): EventTime {
  if (raw === null || raw === undefined) return { ...MISSING };
  if (typeof raw !== "string") return invalid();
  if (raw.length > MAX_LENGTH) return invalid();
  if (!ASCII.test(raw)) return invalid();
  const m = RE.exec(raw);
  if (m === null) return invalid();
  const num = (i: number): number => Number(m[i] ?? "");
  const year = num(1);
  const month = num(2);
  const day = num(3);
  const hour = num(4);
  const minute = num(5);
  const second = num(6);
  if (year < 1970 || year > 2999) return invalid();
  if (month < 1 || month > 12) return invalid();
  if (day < 1 || day > daysInMonth(year, month)) return invalid();
  if (hour > 23 || minute > 59 || second > 59) return invalid();
  let offsetMinutes = 0;
  if (m[9] !== undefined) {
    const oh = num(10);
    const om = num(11);
    if (oh > 23 || om > 59) return invalid();
    offsetMinutes = (m[9] === "+" ? 1 : -1) * (oh * 60 + om);
  }
  const ms = Number((m[7] ?? "").padEnd(3, "0").slice(0, 3));
  const t = Date.UTC(year, month - 1, day, hour, minute, second, ms) - offsetMinutes * 60000;
  if (!(t >= 0 && t < Date.UTC(3000, 0, 1))) return invalid();
  return { value: new Date(t).toISOString(), origin: "source", status: "valid" };
}
