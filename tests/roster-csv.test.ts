import { expect, it } from "vitest";
import { parseRosterCsv, rosterLimits } from "../service/roster-csv";
const header = "Member Name,Member Email,Member Role\n";
it("reads the supplied Google export layout, BOM, CRLF and quoted names without using roles as permissions", () => {
  expect(
    parseRosterCsv(
      '\uFEFFMember Role,Member Email,Member Name,Extra\r\nOWNER,Alex@STMARobotics.org,"Example, Alex",ignored\r\n',
    ),
  ).toEqual([
    { displayName: "Example, Alex", email: "alex@stmarobotics.org", line: 2 },
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
it("rejects duplicate emails, external domains, invalid roles and non-user member types", () => {
  for (const rows of [
    "Alex,alex@stmarobotics.org,MEMBER\nOther,ALEX@stmarobotics.org,MEMBER",
    "Alex,alex@example.com,MEMBER",
    "Alex,alex@stmarobotics.org,ADMIN",
    "Alex,,MEMBER",
  ])
    expect(() => parseRosterCsv(header + rows)).toThrow();
  expect(() =>
    parseRosterCsv(
      "Member Name,Member Email,Member Role,Member Type\nGroup,group@stmarobotics.org,MEMBER,GROUP",
    ),
  ).toThrow("individual users");
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
