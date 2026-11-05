import { parse } from "csv-parse/sync";
import { assert, Fault } from "./model";

export const rosterLimits = { bytes: 128 * 1024, rows: 500, batch: 10 };
export type CsvPerson = { displayName: string; email: string; line: number };
export function rosterEmail(value: unknown): string {
  assert(typeof value === "string", "An email address is required.");
  const email = value.trim().toLowerCase();
  assert(
    email.length <= 254 &&
      /^[a-z0-9][a-z0-9._%+\-]*@stmarobotics\.org$/.test(email),
    "Use a stmarobotics.org member email address.",
  );
  return email;
}
export function parseRosterCsv(csv: unknown): CsvPerson[] {
  assert(
    typeof csv === "string" &&
      Buffer.byteLength(csv, "utf8") <= rosterLimits.bytes,
    "Choose a UTF-8 CSV file no larger than 128 KB.",
  );
  assert(
    !csv.includes("\uFFFD") && !csv.includes("\0"),
    "The CSV must contain valid UTF-8 text.",
  );
  let records: Record<string, string>[];
  try {
    records = parse(csv, {
      bom: true,
      trim: true,
      skip_empty_lines: true,
      max_record_size: 8192,
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
    "Upload between 1 and 500 members per CSV.",
  );
  const seen = new Set<string>();
  return records!.map((record, index) => {
    const line = index + 2,
      displayName = record["member name"].trim().replace(/\s+/g, " ");
    assert(
      displayName.length > 0 &&
        displayName.length <= 100 &&
        !/[\u0000-\u001f\u007f]/.test(displayName),
      `Row ${line}: Member Name must contain 1–100 characters.`,
    );
    let email: string;
    try {
      email = rosterEmail(record["member email"]);
    } catch {
      assert(false, `Row ${line}: use a valid stmarobotics.org Member Email.`);
    }
    assert(
      !seen.has(email!),
      `Row ${line}: duplicate Member Email. Remove duplicate rows before uploading.`,
    );
    seen.add(email!);
    assert(
      ["MEMBER", "MANAGER", "OWNER"].includes(
        record["member role"].toUpperCase(),
      ),
      `Row ${line}: invalid Member Role.`,
    );
    assert(
      !record["member type"] || record["member type"].toUpperCase() === "USER",
      `Row ${line}: only individual users can be imported.`,
    );
    // Google group roles are deliberately discarded. This is attendance enrollment,
    // not proof of a Google subject or a grant of Puncher/Stats permissions.
    return { displayName, email: email!, line };
  });
}
