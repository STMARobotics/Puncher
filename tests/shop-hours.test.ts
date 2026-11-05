import { expect, it } from "vitest";
import { admin, device, fixture, mentor } from "./helpers";
import { all, atomic, MemoryStore } from "../service/store";
import { hash, key, row, uid } from "../service/model";

it("starts the mentor only when the QR is redeemed, without duplicating an active visit", async () => {
  const { app, db, advance } = await fixture(new MemoryStore(), false);
  const pass = await app.issueKioskActivation(mentor);
  const member = await db.get(key("CARD#" + pass.barcode));
  expect((await app.kioskOccupants(device)).shopOpen).toBe(false);
  expect(
    await db.get(key("MEMBER#" + member!.memberId, "CURRENT")),
  ).toBeUndefined();
  const second = await app.issueKioskActivation(mentor);
  expect(second.barcode).toBe(pass.barcode);
  await Promise.all([
    app.activateKiosk(pass.code),
    app.activateKiosk(second.code),
  ]);
  expect(await app.kioskOccupants(device)).toMatchObject({
    shopOpen: true,
    mentors: [{ displayName: "Taylor Mentor" }],
    occupants: [],
  });
  expect(
    await all(db, "MEMBER#" + member!.memberId, { prefix: "SHOP#" }),
  ).toHaveLength(1);
  advance(30);
  expect(await app.scan(device, pass.barcode, uid())).toMatchObject({
    state: "out",
    creditedSeconds: 30,
  });
  expect((await app.kioskOccupants(device)).shopOpen).toBe(false);
});

it("preserves active visits, permits closed-shop checkouts, and resumes credit when reopened", async () => {
  const { app, db, advance, openShop } = await fixture(
    new MemoryStore(),
    false,
  );
  const scan = (card: string) => app.scan(device, card, uid());
  await expect(scan("000123")).rejects.toThrow("Shop closed");
  const lead = await openShop();
  const other = await openShop(admin);
  await scan("000123");
  await scan("000456");
  const before = await db.get(key("MEMBER#member-a", "CURRENT"));
  advance(60);
  await scan(lead.barcode);
  expect((await app.kioskOccupants(device)).shopOpen).toBe(true);
  advance(30);
  await scan(other.barcode);
  expect(await app.kioskOccupants(device)).toMatchObject({
    shopOpen: false,
    mentors: [],
    occupants: [
      { displayName: "Alex Example" },
      { displayName: "Jordan Sample" },
    ],
  });
  advance(120);
  expect(await scan("000456")).toMatchObject({
    state: "out",
    creditedSeconds: 90,
  });
  await expect(scan("000456")).rejects.toThrow("Shop closed");
  await expect(scan(lead.barcode)).rejects.toThrow("Shop closed");
  expect(await db.get(key("MEMBER#member-a", "CURRENT"))).toEqual(before);
  await openShop();
  advance(40);
  expect(await scan("000123")).toMatchObject({
    state: "out",
    creditedSeconds: 130,
  });
});

it("reuses an already rostered mentor's card and promotes their active visit without losing credit", async () => {
  const { app, db, advance, openShop } = await fixture();
  await atomic(db, async (tx) => {
    const identity = await tx.get(key("IDENTITY#" + admin.id));
    await tx.put({ ...identity!, email: "casey@stmarobotics.org" });
    await tx.put(
      row("ROSTER_EMAIL#" + hash("casey@stmarobotics.org"), "METADATA", {
        memberId: "member-a",
      }),
    );
    await tx.put(row("ROSTER_LOGIN#member-a", "METADATA", { sub: admin.id }));
  });
  await app.scan(device, "000123", uid());
  advance(25);
  expect((await openShop(admin)).barcode).toBe("000123");
  expect((await app.kioskOccupants(device)).mentors).toContainEqual({
    displayName: "Alex Example",
  });
  advance(30);
  expect(await app.scan(device, "000123", uid())).toMatchObject({
    state: "out",
    creditedSeconds: 55,
  });
});

it("ends the kiosk at Chicago midnight and forfeits unfinished mentor and student visits", async () => {
  const { app, db, set, openShop } = await fixture(new MemoryStore(), false);
  set("2026-06-01T04:59:00.000Z");
  const kiosk = await openShop();
  const devicePrincipal = {
    kind: "device" as const,
    id: kiosk.sessionId,
    roles: [],
  };
  expect(kiosk.expiresAt).toBe("2026-06-01T05:00:00.000Z");
  await app.scan(devicePrincipal, "000123", uid());
  set(kiosk.expiresAt);
  await expect(app.scan(devicePrincipal, "000123", uid())).rejects.toThrow(
    "Access disabled",
  );
  await app.cleanup();
  const mentorCard = await db.get(key("CARD#" + kiosk.barcode));
  for (const memberId of ["member-a", mentorCard!.memberId]) {
    const [visit] = await all(db, "MEMBER#" + memberId, { prefix: "SHOP#" });
    expect(visit).toMatchObject({
      status: "forfeited_missing_checkout",
      creditedSeconds: 0,
    });
  }
});
