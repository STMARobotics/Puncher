import { it, expect } from "vitest";
import { shopTotals } from "../service/shop-totals";
import { fixture, device, admin } from "./helpers";
import { atomic } from "../service/store";
import { row, key, uid } from "../service/model";
async function setup() {
  const f = await fixture();
  await atomic(f.db, async (tx) => {
    await tx.put(row("APP#PUNCHER", "SCHEMA", { timezone: "America/Chicago" }));
  });
  return f;
}
it("returns only aggregate eligible shop credit, including inactive members and approved legacy history", async () => {
  const { db, app, advance } = await setup();
  await app.scan(device, "000123", uid());
  advance(3600);
  await app.scan(device, "000123", uid());
  await app.scan(device, "000456", uid());
  await atomic(db, async (tx) => {
    for (const [id, date, seconds, status] of [
      ["current", "2026-06-01", 1800, "approved"],
      ["old", "2025-06-01", 900, "approved"],
      ["pending", "2026-06-01", 90000, "pending_review"],
      ["negative", "2026-06-01", -100, "approved"],
      ["bad-date", "2026-02-30", 100, "approved"],
    ] as const)
      await tx.put(
        row("ATTENDANCE#member-a", `LEGACYSHOP#${date}#${id}`, {
          memberId: "member-a",
          shopDate: date,
          status,
          creditedSeconds: seconds,
        }),
      );
    await tx.put(
      row("ATTENDANCE#member-a", "VOLUNTEER#2026-06-01#volunteer", {
        eventDate: "2026-06-01",
        status: "approved",
        creditedSeconds: 99999,
      }),
    );
    await tx.put(
      row("ATTENDANCE#member-a", "SHOP#forfeit#id", {
        shopDate: "2026-06-01",
        status: "forfeited_missing_checkout",
        creditedSeconds: 99999,
      }),
    );
  });
  const member = (await db.get(key("USER#member-a")))!;
  await app.updateMember(admin, "member-a", { displayName: member.displayName, role: member.role, active: false, version: member.v });
  const result = await shopTotals(
    db,
    device,
    () => new Date("2026-06-01T18:00:00Z"),
  );
  expect(result).toMatchObject({
    weekSeconds: 1800,
    yearSeconds: 5400,
    allTimeSeconds: 6300,
    weekStart: "2026-06-01",
    reportingYear: 2026,
  });
  expect(Object.keys(result).sort()).toEqual(
    [
      "weekSeconds",
      "yearSeconds",
      "allTimeSeconds",
      "weekStart",
      "reportingYear",
      "updatedAt",
    ].sort(),
  );
  expect(JSON.stringify(result)).not.toMatch(/Alex|member-a|000123/);
});
it("uses a bounded cache, rebuilds after review changes, and rejects a new schema even while cached", async () => {
  const { db } = await setup();
  let now = new Date("2026-06-01T18:00:00Z");
  const clock = () => now;
  expect((await shopTotals(db, device, clock)).allTimeSeconds).toBe(0);
  await atomic(db, async (tx) => {
    await tx.put(
      row("ATTENDANCE#member-a", "LEGACYSHOP#2026-06-01#approved", {
        shopDate: "2026-06-01",
        status: "approved",
        creditedSeconds: 600,
      }),
    );
  });
  expect((await shopTotals(db, device, clock)).allTimeSeconds).toBe(0);
  now = new Date(now.getTime() + 61000);
  expect((await shopTotals(db, device, clock)).allTimeSeconds).toBe(600);
  await atomic(db, async (tx) => {
    const schema = await tx.get(key("APP#PUNCHER", "SCHEMA"));
    await tx.put({ ...schema!, schemaVersion: 1 } as any);
  });
  await expect(shopTotals(db, device, clock)).rejects.toThrow("Unsupported");
});
it("rolls over June 2 and Monday in Chicago, including the fall DST boundary", async () => {
  const { db } = await setup();
  await atomic(db, async (tx) => {
    for (const date of ["2026-06-01", "2026-11-01"])
      await tx.put(
        row("ATTENDANCE#member-a", `LEGACYSHOP#${date}#test`, {
          shopDate: date,
          status: "approved",
          creditedSeconds: 600,
        }),
      );
  });
  const before = await shopTotals(
    db,
    device,
    () => new Date("2026-06-02T04:59:59Z"),
  );
  expect(before).toMatchObject({ reportingYear: 2026, yearSeconds: 600 });
  const after = await shopTotals(
    db,
    device,
    () => new Date("2026-06-02T05:00:00Z"),
  );
  expect(after).toMatchObject({ reportingYear: 2027, yearSeconds: 600 });
  const sunday = await shopTotals(
    db,
    device,
    () => new Date("2026-11-02T05:59:59Z"),
  );
  expect(sunday).toMatchObject({ weekStart: "2026-10-26", weekSeconds: 600 });
  const monday = await shopTotals(
    db,
    device,
    () => new Date("2026-11-02T06:00:00Z"),
  );
  expect(monday).toMatchObject({ weekStart: "2026-11-02", weekSeconds: 0 });
});
it("requires an enabled device and recovers an abandoned database refresh lease", async () => {
  const { db } = await setup();
  const clock = () => new Date("2026-06-01T18:00:00Z");
  await expect(shopTotals(db, admin, clock)).rejects.toThrow("device");
  await atomic(db, async (tx) => {
    await tx.put(
      row("SUMMARY#SHOP", "REFRESH", {
        leaseId: "old-worker",
        expiresAt: "2026-06-01T18:00:20.000Z",
      }),
    );
  });
  await expect(shopTotals(db, device, clock)).rejects.toThrow("updating");
  expect(
    (await shopTotals(db, device, () => new Date("2026-06-01T18:00:21Z")))
      .allTimeSeconds,
  ).toBe(0);
  await atomic(db, async (tx) => {
    const d = await tx.get(key("DEVICE#test-device"));
    await tx.put({ ...d!, enabled: false });
  });
  await expect(shopTotals(db, device, clock)).rejects.toThrow("disabled");
});
