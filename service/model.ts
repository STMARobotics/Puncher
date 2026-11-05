import { Temporal } from "@js-temporal/polyfill";
import { createHash, randomUUID } from "node:crypto";
export type Row = {
  pk: string;
  sk: string;
  v: number;
  schemaVersion: 1;
  [key: string]: any;
};
export type Key = Pick<Row, "pk" | "sk">;
export type Principal = {
  kind: "human" | "device";
  id: string;
  roles: string[];
  memberId?: string;
  rosterEmail?: string;
};
export class Fault extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export function assert(ok: unknown, message: string, status = 400): asserts ok {
  if (!ok) throw new Fault(status, message);
}
export const key = (pk: string, sk = "METADATA"): Key => ({ pk, sk });
export const row = (
  pk: string,
  sk: string,
  fields: Record<string, any>,
): Row => ({ pk, sk, v: 1, schemaVersion: 1, ...fields });
export const hash = (s: string) => createHash("sha256").update(s).digest("hex");
export const uid = (): string => randomUUID();
export const ZONE = "America/Chicago";
export function validDate(s: unknown): string {
  assert(
    typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s),
    "Use a YYYY-MM-DD date.",
  );
  try {
    return Temporal.PlainDate.from(s).toString();
  } catch {
    throw new Fault(400, "Invalid calendar date.");
  }
}
export function reportingYear(date: string) {
  validDate(date);
  const y = Number(date.slice(0, 4));
  return date.slice(5) <= "06-01" ? y : y + 1;
}
export function localDay(now: Date) {
  return Temporal.Instant.from(now.toISOString())
    .toZonedDateTimeISO(ZONE)
    .toPlainDate()
    .toString();
}
export function cutoff(date: string) {
  return Temporal.PlainDate.from(validDate(date))
    .add({ days: 1 })
    .toZonedDateTime({ timeZone: ZONE, plainTime: "00:00" })
    .toInstant()
    .toString({ smallestUnit: "millisecond" });
}
// Decimal string -> exact integer seconds. Half-seconds round away from zero once, at import.
export function hoursToSeconds(value: unknown): number {
  const s = String(value ?? "").trim();
  assert(
    /^-?\d+(\.\d{1,9})?$/.test(s),
    "Hours must be a decimal number with at most nine decimal places.",
  );
  const neg = s.startsWith("-");
  const [whole, frac = ""] = (neg ? s.slice(1) : s).split(".");
  const scale = 10n ** BigInt(frac.length);
  const n = (BigInt(whole) * scale + BigInt(frac || 0)) * 3600n;
  const sec = (n + scale / 2n) / scale;
  const result = Number(neg ? -sec : sec);
  assert(Number.isSafeInteger(result), "Duration is too large.");
  return result;
}
export function barcode(value: unknown): string {
  assert(
    typeof value === "string" && /^[0-9]{6}$/.test(value),
    "Card must contain exactly six digits.",
  );
  return value;
}
export function text(value: unknown, label: string, max = 200): string {
  assert(
    typeof value === "string" &&
      value.trim().length > 0 &&
      value.trim().length <= max,
    `${label} is required (maximum ${max} characters).`,
  );
  return value.trim();
}
export function admin(p: Principal) {
  assert(
    p.kind === "human" && p.roles.includes("admin"),
    "Administrator access required.",
    403,
  );
}
export function mentor(p: Principal) {
  assert(
    p.kind === "human" &&
      (p.roles.includes("admin") || p.roles.includes("mentor")),
    "Mentor access required.",
    403,
  );
}
export function owns(p: Principal, e: Row) {
  mentor(p);
  assert(
    p.roles.includes("admin") || e.mentorSub === p.id,
    "This event belongs to another mentor.",
    403,
  );
}
export function eligible(r: Row) {
  if (r.sk.startsWith("SHOP#"))
    return (
      r.status === "completed" &&
      r.endedAt < r.cutoffAt &&
      r.creditedSeconds >= 0
    );
  return (
    ["LEGACYSHOP#", "VOLUNTEER#"].some((p) => r.sk.startsWith(p)) &&
    r.status === "approved" &&
    !!(r.shopDate || r.eventDate) &&
    Number.isSafeInteger(r.creditedSeconds) &&
    r.creditedSeconds >= 0
  );
}
