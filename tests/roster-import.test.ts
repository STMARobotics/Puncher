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
  "Group Email [Required],Member Email,Member Name,Member Role,Member Type\n" +
  names
    .map(
      (name, i) =>
        `frc.students@stmarobotics.org,person${i}@stmarobotics.org,${name},${i ? "MEMBER" : "OWNER"},USER`,
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
it("enrolls members with stable codes on reimport and never grants login or activity rewards", async () => {
  const db = await empty(),
    job = await previewRoster(db, mentor, uid(), csv(["Alex", "Jordan"]));
  expect(await all(db, "MEMBERS", { index: "GSI1" })).toHaveLength(0);
  const first = await applyRosterBatch(db, mentor, job.importId, 0);
  expect(first.counts.created).toBe(2);
  const members = await all(db, "MEMBERS", { index: "GSI1" });
  for (const m of members)
    expect(m).toMatchObject({
      active: true,
      memberKind: "student",
      barcode: expect.stringMatching(/^[1-9]\d{5}$/),
    });
  const again = await previewRoster(db, mentor, uid(), csv(["Alex", "Jordan"]));
  expect(
    (await applyRosterBatch(db, mentor, again.importId, 0)).counts,
  ).toEqual({ created: 0, updated: 0, unchanged: 2 });
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
it("automatically matches normalized names and emails and preserves existing role, cards, hours and inactive status", async () => {
  const { db, app, advance } = await fixture();
  await app.scan(device, "000123", uid());
  advance(60);
  await app.scan(device, "000123", uid());
  const hours = await all(db, "MEMBER#member-a", { prefix: "SHOP#" });
  await app.saveMember(
    mentor,
    {
      displayName: "Alex Example",
      email: "alex@stmarobotics.org",
      memberKind: "student",
      active: false,
    },
    "member-a",
  );
  const job = await previewRoster(
    db,
    mentor,
    uid(),
    "Group Email [Required],Member Email,Member Name,Member Role,Member Type\n" +
      "frc.mentors@stmarobotics.org,ALEX@STMAROBOTICS.ORG,alex  example,MEMBER,USER\n" +
      "frc.mentors@stmarobotics.org,new.mentor@stmarobotics.org,New Mentor,OWNER,USER\n",
  );
  expect(job.people[0].match.memberId).toBe("member-a");
  await applyRosterBatch(db, mentor, job.importId, 0);
  expect(await db.get(key("MEMBER#member-a"))).toMatchObject({
    barcode: "000123",
    active: false,
    memberKind: "student",
  });
  expect(
    await db.get(key("MEMBER#" + job.people[1].newMemberId)),
  ).toMatchObject({
    active: true,
    memberKind: "mentor",
  });
  expect((await db.get(key("MEMBER#member-b")))?.active).toBe(true);
  expect(await all(db, "MEMBER#member-a", { prefix: "SHOP#" })).toEqual(hours);
});

it("creates a separate card when just the email matches and keeps the existing login binding", async () => {
  const db = await empty();
  const first = await previewRoster(db, mentor, uid(), csv(["Original"]));
  await applyRosterBatch(db, mentor, first.importId, 0);
  const second = await previewRoster(
    db,
    mentor,
    uid(),
    csv(["Different Person"]),
  );
  expect(second.people[0]).toMatchObject({ canEnroll: false });
  expect(second.people[0].match).toBeUndefined();
  await applyRosterBatch(db, mentor, second.importId, 0);
  const [original, newer] = await Promise.all([
    db.get(key("MEMBER#" + first.people[0].newMemberId)),
    db.get(key("MEMBER#" + second.people[0].newMemberId)),
  ]);
  expect(original?.csvEmail).toBe("person0@stmarobotics.org");
  expect(newer?.csvEmail).toBeUndefined();
  expect(newer?.barcode).not.toBe(original?.barcode);
  const repeat = await previewRoster(
    db,
    mentor,
    uid(),
    csv(["Different Person"]),
  );
  expect(repeat.people[0].match.memberId).toBe(newer?.memberId);
});

it("makes duplicate batch deliveries and resumed multi-batch imports idempotent", async () => {
  const db = await empty(),
    text = csv(Array.from({ length: 12 }, (_, i) => "Person " + i));
  const job = await previewRoster(db, mentor, uid(), text);
  const results = await Promise.all([
    applyRosterBatch(db, mentor, job.importId, 0),
    applyRosterBatch(db, mentor, job.importId, 0),
  ]);
  expect(results[0]).toEqual(results[1]);
  expect(results[0].processed).toBe(10);
  const status = await rosterImportStatus(db, mentor, job.importId);
  expect(status.people).toHaveLength(12);
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
  await applyRosterBatch(db, mentor, a.importId, 0);
  await expect(applyRosterBatch(db, mentor, b.importId, 0)).rejects.toThrow(
    "imported since preview",
  );
  expect(await all(db, "MEMBERS", { index: "GSI1" })).toHaveLength(1);
});
it("rolls back a whole batch if an exact match changes after preview", async () => {
  const { db, app } = await fixture();
  const job = await previewRoster(
    db,
    mentor,
    uid(),
    "Member Name,Member Email,Member Role\nAlex Example,alex@stmarobotics.org,MEMBER\nJordan Sample,jordan@stmarobotics.org,MEMBER",
    "frc.students@stmarobotics.org",
  );
  const a = await db.get(key("MEMBER#member-a"));
  const b = await db.get(key("MEMBER#member-b"));
  await app.saveMember(
    mentor,
    { ...b, displayName: "Concurrent edit" },
    "member-b",
  );
  await expect(applyRosterBatch(db, mentor, job.importId, 0)).rejects.toThrow(
    "changed since preview",
  );
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
  await expect(applyRosterBatch(db, mentor, job.importId, 0)).rejects.toThrow(
    "disabled",
  );
  await atomic(db, async (tx) => {
    const j = await tx.get(key("ROSTER_IMPORT#" + job.importId));
    await tx.put({ ...j!, expiresAt: "2000-01-01T00:00:00.000Z" });
  });
  await expect(rosterImportStatus(db, mentor, job.importId)).rejects.toThrow(
    "expired",
  );
});

it("reports skipped rows on preview and reload and imports only valid entries", async () => {
  const db = await empty();
  const source =
    csv(["Alex"]) +
    "\nfrc.students@stmarobotics.org,group@stmarobotics.org,Nested group,MEMBER,GROUP";
  const job = await previewRoster(db, mentor, uid(), source);
  expect(job.total).toBe(1);
  expect(job.skipped).toEqual([
    { line: 3, reason: "Only individual users can be imported." },
  ]);
  expect(
    (await applyRosterBatch(db, mentor, job.importId, 0)).counts.created,
  ).toBe(1);
  expect((await rosterImportStatus(db, mentor, job.importId)).skipped).toEqual(
    job.skipped,
  );

  const skippedOnly = await previewRoster(
    db,
    mentor,
    uid(),
    source
      .split("\n")
      .filter((_, index) => index !== 1)
      .join("\n"),
  );
  expect(skippedOnly).toMatchObject({
    status: "completed",
    total: 0,
    skipped: [{ line: 2 }],
  });
  expect(await all(db, "MEMBERS", { index: "GSI1" })).toHaveLength(1);
});
