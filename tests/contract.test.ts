import { it, expect } from "vitest";
import Ajv from "ajv";
import schema from "../contracts/stats-reader.v1.json";
import fixtures from "../contracts/fixtures/reader-v1.json";
import { eligible, type Row } from "../service/model";
import { fixture, device, mentor } from "./helpers";
import { uid } from "../service/model";
import { all } from "../service/store";
const ajv = new Ajv({ strict: false }),
  validate = ajv.compile(schema);
it("language-neutral fixtures validate and have the specified eligible totals", () => {
  for (const r of fixtures.records)
    expect(validate(r), JSON.stringify(validate.errors)).toBe(true);
  const rows = fixtures.records as Row[];
  expect(
    rows
      .filter((r) => eligible(r) && !r.sk.startsWith("VOLUNTEER#"))
      .reduce((n, r) => n + r.creditedSeconds, 0),
  ).toBe(fixtures.expected.careerShopSeconds);
  expect(
    rows
      .filter((r) => eligible(r) && r.sk.startsWith("VOLUNTEER#"))
      .reduce((n, r) => n + r.creditedSeconds, 0),
  ).toBe(fixtures.expected.careerVolunteerSeconds);
});
it("actual writer sessions and awards satisfy the reader schema", async () => {
  const { app, db, advance } = await fixture();
  await app.scan(device, "000123", uid());
  advance(60);
  await app.scan(device, "000123", uid());
  const e = await app.saveEvent(mentor, {
    title: "Synthetic contract",
    eventDate: "2026-06-02",
    hours: "1",
  });
  await app.award(mentor, e.eventId, "000123");
  for (const r of (await all(db, "MEMBER#member-a")).filter(
    (r) => r.sk !== "CURRENT",
  ))
    expect(validate(r), JSON.stringify(validate.errors)).toBe(true);
});
