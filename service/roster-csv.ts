import { parse } from "csv-parse/sync";
import { assert, Fault } from "./model";

export const rosterLimits = { bytes: 128 * 1024, rows: 500, batch: 10 };
const groupRoles = {
  "frc.students@stmarobotics.org": "student",
  "frc.mentors@stmarobotics.org": "mentor",
  "ftc.mentors@stmarobotics.org": "mentor",
} as const;
export type CsvPerson = {
  displayName: string;
  email: string;
  line: number;
  memberKind: (typeof groupRoles)[keyof typeof groupRoles];
};
export type SkippedRosterRow = { line: number; reason: string };

function groupRole(group: unknown) {
  if (typeof group !== "string") return undefined;
  const email = group.trim().toLowerCase();
  if (Object.hasOwn(groupRoles, email))
    return groupRoles[email as keyof typeof groupRoles];
}

export function parseRosterCsv(csv: unknown, fallbackGroup?: unknown) {
  assert(
    typeof csv === "string" &&
      Buffer.byteLength(csv, "utf8") <= rosterLimits.bytes,
    "Choose a UTF-8 CSV file no larger than 128 KB.",
  );
  assert(
    !csv.includes("\uFFFD") && !csv.includes("\0"),
    "The CSV must contain valid UTF-8 text.",
  );
  let records: {
    record: Record<string, string>;
    info: { lines: number; error?: unknown };
  }[];
  try {
    records = parse(csv, {
      bom: true,
      trim: true,
      skip_empty_lines: true,
      max_record_size: 8192,
      info: true,
      relax_column_count: true,
      columns: (headers: string[]) => {
        const columns = headers.map((h) => h.trim().toLowerCase());
        assert(
          new Set(columns).size === columns.length,
          "Duplicate CSV column headings.",
        );
        for (const required of ["member name", "member email", "member role"])
          assert(
            columns.includes(required),
            "Expected Google group export columns: Member Name, Member Email, Member Role.",
          );
        return columns;
      },
    });
  } catch (e: any) {
    // Do not echo parser diagnostics: they can include private source values.
    assert(
      false,
      e instanceof Fault
        ? e.message
        : "CSV could not be read. Check its headings, commas and quoted fields.",
    );
  }
  assert(
    records!.length > 0 && records!.length <= rosterLimits.rows,
    "Upload between 1 and 500 rows per CSV.",
  );
  const fallbackRole = groupRole(fallbackGroup);
  if (
    records!.some(
      ({ record, info }) =>
        !info.error &&
        !Object.hasOwn(record, "group email [required]") &&
        !Object.hasOwn(record, "group email"),
    )
  )
    assert(fallbackRole, "Select the source group for this older CSV export.");

  const people: CsvPerson[] = [];
  const skipped: SkippedRosterRow[] = [];
  const seen = new Set<string>();
  for (const { record, info } of records!) {
    const line = info.lines;
    if (info.error) {
      skipped.push({ line, reason: "Wrong number of columns." });
      continue;
    }
    const type = record["member type"]?.trim().toUpperCase();
    const displayName = record["member name"].trim().replace(/\s+/g, " ");
    const email = record["member email"].trim().toLowerCase();
    const role = record["member role"].trim().toUpperCase();
    const group = record["group email [required]"] ?? record["group email"];
    const memberKind = group === undefined ? fallbackRole : groupRole(group);
    let reason: string | undefined;
    if (type && type !== "USER")
      reason = "Only individual users can be imported.";
    else if (
      !displayName ||
      displayName.length > 100 ||
      /[\u0000-\u001f\u007f]/.test(displayName)
    )
      reason = "Member Name must contain 1–100 characters.";
    else if (
      email.length > 254 ||
      !/^[a-z0-9][a-z0-9._%+\-]*@stmarobotics\.org$/.test(email)
    )
      reason = "Use a valid stmarobotics.org Member Email.";
    else if (!["MEMBER", "MANAGER", "OWNER"].includes(role))
      reason = "Invalid Member Role.";
    else if (!memberKind)
      reason = "Group Email must be frc.students, frc.mentors, or ftc.mentors.";
    else if (seen.has(email)) reason = "Duplicate Member Email.";
    if (reason || !memberKind) {
      skipped.push({ line, reason: reason ?? "Unknown attendance role." });
      continue;
    }
    seen.add(email);
    people.push({ displayName, email, line, memberKind });
  }
  return { people, skipped };
}
