import { Temporal } from "@js-temporal/polyfill";
import { createHash, randomUUID } from "node:crypto";
export type Row = {
  pk: string;
  sk: string;
  v: number;
  schemaVersion: 1 | typeof SCHEMA_VERSION;
  [key: string]: any;
};
export type Key = Pick<Row, "pk" | "sk">;
export const SCHEMA_VERSION = 2;
export const roles = ["STUDENT", "MENTOR", "ADMIN"] as const;
export type Role = (typeof roles)[number];
export const eventTypes = ["OUTREACH", "COMPETITION"] as const;
export type EventType = (typeof eventTypes)[number];
export type Human = {
  kind: "human";
  id: string;
  role: Role;
  barcode?: string;
  picture?: string;
  displayName?: string;
};
export type Principal =
  Human | { kind: "device"; id: string; expiresAt?: string };
export const staffsShop = (role: unknown) =>
  role === "MENTOR" || role === "ADMIN";
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
): Row => ({ pk, sk, v: 1, schemaVersion: SCHEMA_VERSION, ...fields });
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
export function kioskExpiry(launchedAt: string | undefined, expiresAt: string) {
  if (!launchedAt) return expiresAt;
  const midnight = cutoff(localDay(new Date(launchedAt)));
  return expiresAt < midnight ? expiresAt : midnight;
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
export function admin(p: Principal): asserts p is Human {
  assert(
    p.kind === "human" && p.role === "ADMIN",
    "Administrator access required.",
    403,
  );
}
export function mentor(p: Principal): asserts p is Human {
  assert(
    p.kind === "human" && staffsShop(p.role),
    "Mentor access required.",
    403,
  );
}
export function owns(p: Principal, e: Row) {
  mentor(p);
  assert(
    p.role === "ADMIN" || e.mentorSub === p.id,
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
