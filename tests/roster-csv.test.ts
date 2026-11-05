import { expect, it } from "vitest";
import { parseRosterCsv, rosterLimits } from "../service/roster-csv";
const studentGroup = "frc.students@stmarobotics.org";
const header = "Member Name,Member Email,Member Role\n";
it("reads the supplied Google export layout, BOM, CRLF and quoted names without using roles as permissions", () => {
  expect(
    parseRosterCsv(
      '\uFEFFMember Role,Member Email,Member Name,Extra\r\nOWNER,Alex@STMARobotics.org,"Example, Alex",ignored\r\n',
      studentGroup,
    ).people,
  ).toEqual([
    {
      displayName: "Example, Alex",
      email: "alex@stmarobotics.org",
      line: 2,
      memberKind: "student",
    },
  ]);
});
it("rejects malformed or missing/duplicate headings without echoing source contents", () => {
  for (const csv of [
    "Name,Email\nAlex,alex@stmarobotics.org",
    "Member Name,Member Email,Member Email,Member Role\nAlex,a@stmarobotics.org,b@stmarobotics.org,MEMBER",
    header + '"private-source-value,alex@stmarobotics.org,MEMBER',
  ]) {
    expect(() => parseRosterCsv(csv)).toThrow();
    try {
      parseRosterCsv(csv);
    } catch (e: any) {
      expect(e.message).not.toContain("private-source-value");
    }
  }
});
it("skips invalid rows and keeps valid students and mentors from the same file", () => {
  const { people, skipped } = parseRosterCsv(
    [
      "Group Email [Required],Member Email,Member Name,Member Role,Member Type",
      "frc.students@stmarobotics.org,alex@stmarobotics.org,Alex,MEMBER,GROUP",
      "frc.students@stmarobotics.org,alex@stmarobotics.org,Alex,MEMBER,USER",
      "",
      "frc.students@stmarobotics.org,ALEX@STMAROBOTICS.ORG,Duplicate,MEMBER,USER",
      "frc.students@stmarobotics.org,external@example.com,External,MEMBER,USER",
      "frc.students@stmarobotics.org,role@stmarobotics.org,Wrong role,ADMIN,USER",
      "wrong-group@stmarobotics.org,group@stmarobotics.org,Wrong group,MEMBER,USER",
      "frc.students@stmarobotics.org,missing@stmarobotics.org",
      "ftc.mentors@stmarobotics.org,mentor@stmarobotics.org,Taylor,OWNER,USER",
    ].join("\n"),
  );
  expect(
    people.map(({ displayName, memberKind }) => [displayName, memberKind]),
  ).toEqual([
    ["Alex", "student"],
    ["Taylor", "mentor"],
  ]);
  expect(skipped).toEqual([
    { line: 2, reason: "Only individual users can be imported." },
    { line: 5, reason: "Duplicate Member Email." },
    { line: 6, reason: "Use a valid stmarobotics.org Member Email." },
    { line: 7, reason: "Invalid Member Role." },
    {
      line: 8,
      reason: "Group Email must be frc.students, frc.mentors, or ftc.mentors.",
    },
    { line: 9, reason: "Wrong number of columns." },
  ]);
});
it("bounds file/row sizes and rejects empty or invalid text", () => {
  expect(() => parseRosterCsv(header)).toThrow("between 1 and 500");
  expect(() => parseRosterCsv("x".repeat(rosterLimits.bytes + 1))).toThrow(
    "128 KB",
  );
  expect(() =>
    parseRosterCsv(header + "Alex,alex@stmarobotics.org,MEMBER\uFFFD"),
  ).toThrow("UTF-8");
  expect(() =>
    parseRosterCsv(
      header +
        Array.from(
          { length: 501 },
          (_, i) => `Person ${i},person${i}@stmarobotics.org,MEMBER`,
        ).join("\n"),
    ),
  ).toThrow("500");
});
