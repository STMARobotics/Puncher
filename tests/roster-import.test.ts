import { expect, it } from "vitest";
import {
  previewRoster,
  applyRosterBatch,
  rosterImportStatus,
} from "../service/roster-import";
import { MemoryStore, atomic, all } from "../service/store";
import { Puncher } from "../service/domain";
import { row, key, uid, type Principal } from "../service/model";
import { admin, mentor, device, fixture } from "./helpers";
const csv = (names: string[]) =>
  "Member Name,Member Email,Member Role\n" +
  names
    .map(
      (name, i) =>
        `${name},person${i}@stmarobotics.org,${i ? "MEMBER" : "OWNER"}`,
    )
    .join("\n");
async function empty() {
  const db = new MemoryStore({ orgId: "example-team" });
  await atomic(db, async (tx) => {
    for (const p of [admin, mentor])
      await tx.put(
        row("IDENTITY#" + p.id, "METADATA", { enabled: true, roles: p.roles }),
      );
  });
  return db;
}
const selections = (job: any) =>
  job.people.map((p: any) =>
    p.suggested.memberId ? p.suggested : { memberId: "new" },
  );
it("enrolls members with stable codes on reimport and never grants login or activity rewards", async () => {
  const db = await empty(),
    job = await previewRoster(db, mentor, uid(), csv(["Alex", "Jordan"]));
  expect(await all(db, "MEMBERS", { index: "GSI1" })).toHaveLength(0);
  const first = await applyRosterBatch(
    db,
    mentor,
    job.importId,
    0,
    selections(job),
  );
  expect(first.counts.created).toBe(2);
  const members = await all(db, "MEMBERS", { index: "GSI1" });
  for (const m of members)
    expect(m).toMatchObject({
      active: true,
      memberKind: "student",
      barcode: expect.stringMatching(/^[1-9]\d{5}$/),
    });
  const again = await previewRoster(
    db,
    mentor,
    uid(),
    csv(["Alex Renamed", "Jordan"]),
  );
  expect(
    (await applyRosterBatch(db, mentor, again.importId, 0, selections(again)))
      .counts,
  ).toEqual({ created: 0, updated: 1, unchanged: 1 });
  for (const m of await all(db, "MEMBERS", { index: "GSI1" }))
    expect(m.barcode).toBe(
      members.find((b) => b.memberId === m.memberId)!.barcode,
    );
  expect(
    [...db.rows.values()].filter((r) => r.pk.startsWith("IDENTITY#")),
  ).toHaveLength(2);
  expect(
    [...db.rows.values()].filter((r) => r.recordType === "ACTIVITY_OUTBOX_V1"),
  ).toHaveLength(0);
});
it("requires explicit legacy linking, preserves hours/inactivity and never disables absent members", async () => {
  const { db, app, advance } = await fixture();
  await app.scan(device, "000123", uid());
  advance(60);
  await app.scan(device, "000123", uid());
  const hours = await all(db, "MEMBER#member-a", { prefix: "SHOP#" });
  await app.saveMember(
    mentor,
    { displayName: "Alex Example", memberKind: "student", active: false },
    "member-a",
  );
  const job = await previewRoster(db, mentor, uid(), csv(["Alex Changed"]));
  expect(job.people[0].suggested.memberId).toBe("");
  const before = await db.get(key("MEMBER#member-a"));
  await applyRosterBatch(db, mentor, job.importId, 0, [
    { memberId: "member-a", version: before!.v },
  ]);
  expect(await db.get(key("MEMBER#member-a"))).toMatchObject({
    barcode: "000123",
    active: false,
  });
  expect((await db.get(key("MEMBER#member-b")))?.active).toBe(true);
  expect(await all(db, "MEMBER#member-a", { prefix: "SHOP#" })).toEqual(hours);
});
it("makes duplicate batch deliveries and resumed multi-batch imports idempotent", async () => {
  const db = await empty(),
    text = csv(Array.from({ length: 12 }, (_, i) => "Person " + i));
  const job = await previewRoster(db, mentor, uid(), text);
  const results = await Promise.all([
    applyRosterBatch(db, mentor, job.importId, 0, selections(job)),
    applyRosterBatch(db, mentor, job.importId, 0, selections(job)),
  ]);
  expect(results[0]).toEqual(results[1]);
  expect(results[0].processed).toBe(10);
  const status = await rosterImportStatus(db, mentor, job.importId);
  expect(status.selections).toHaveLength(12);
  expect(
    (await applyRosterBatch(db, mentor, job.importId, 10)).counts.created,
  ).toBe(12);
  expect((await applyRosterBatch(db, mentor, job.importId, 0)).processed).toBe(
    12,
  );
  expect(await all(db, "MEMBERS", { index: "GSI1" })).toHaveLength(12);
});
it("rejects racing new-account claims instead of creating duplicate people", async () => {
  const db = await empty(),
    a = await previewRoster(db, mentor, uid(), csv(["Alex"])),
    b = await previewRoster(db, mentor, uid(), csv(["Alex"]));
  await applyRosterBatch(db, mentor, a.importId, 0, selections(a));
  await expect(
    applyRosterBatch(db, mentor, b.importId, 0, selections(b)),
  ).rejects.toThrow("reserved");
  expect(await all(db, "MEMBERS", { index: "GSI1" })).toHaveLength(1);
});
it("rolls back a whole batch on stale member data and validates every selection before writing", async () => {
  const { db, app } = await fixture(),
    job = await previewRoster(db, mentor, uid(), csv(["First", "Second"]));
  const a = await db.get(key("MEMBER#member-a")),
    b = await db.get(key("MEMBER#member-b"));
  await expect(
    applyRosterBatch(db, mentor, job.importId, 0, [
      { memberId: "member-a", version: a!.v },
      { memberId: "member-a", version: a!.v },
    ]),
  ).rejects.toThrow("Two CSV rows");
  await app.saveMember(
    mentor,
    { ...b, displayName: "Concurrent edit" },
    "member-b",
  );
  await expect(
    applyRosterBatch(db, mentor, job.importId, 0, [
      { memberId: "member-a", version: a!.v },
      { memberId: "member-b", version: b!.v },
    ]),
  ).rejects.toThrow("changed since preview");
  expect(await db.get(key("MEMBER#member-a"))).toEqual(a);
  expect((await rosterImportStatus(db, mentor, job.importId)).processed).toBe(
    0,
  );
});
it("isolates import ownership, checks live mentor revocation and enforces preview expiry", async () => {
  const db = await empty(),
    job = await previewRoster(db, mentor, uid(), csv(["Alex"]));
  await expect(rosterImportStatus(db, admin, job.importId)).rejects.toThrow(
    "another mentor",
  );
  await expect(previewRoster(db, device, uid(), csv(["Alex"]))).rejects.toThrow(
    "Mentor",
  );
  await atomic(db, async (tx) => {
    const i = await tx.get(key("IDENTITY#" + mentor.id));
    await tx.put({ ...i!, enabled: false });
  });
  await expect(
    applyRosterBatch(db, mentor, job.importId, 0, selections(job)),
  ).rejects.toThrow("disabled");
  await atomic(db, async (tx) => {
    const j = await tx.get(key("ROSTER_IMPORT#" + job.importId));
    await tx.put({ ...j!, expiresAt: "2000-01-01T00:00:00.000Z" });
  });
  await expect(rosterImportStatus(db, mentor, job.importId)).rejects.toThrow(
    "expired",
  );
});
