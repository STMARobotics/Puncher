import { expect, it } from "vitest";
import { admin, device, fixture, mentor } from "./helpers";
import { all, MemoryStore } from "../service/store";
import { key, uid } from "../service/model";

it("starts the mentor only when the QR is redeemed, without duplicating an active visit", async () => {
  const { app, db, advance } = await fixture(new MemoryStore(), false);
  const pass = await app.issueKioskActivation(mentor);
  const member = await db.get(key("CARD#" + pass.barcode));
  expect((await app.kioskOccupants(device)).shopOpen).toBe(false);
  expect(
    await db.get(key("ATTENDANCE#" + member!.memberId, "CURRENT")),
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
    await all(db, "ATTENDANCE#" + member!.memberId, { prefix: "SHOP#" }),
  ).toHaveLength(1);
  advance(30);
  expect(await app.scan(device, pass.barcode, uid())).toMatchObject({
    state: "out",
    creditedSeconds: 30,
    shopClosed: true,
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
  const before = await db.get(key("ATTENDANCE#member-a", "CURRENT"));
  advance(60);
  expect(await scan(lead.barcode)).not.toHaveProperty("shopClosed");
  expect((await app.kioskOccupants(device)).shopOpen).toBe(true);
  advance(30);
  expect(await scan(other.barcode)).toHaveProperty("shopClosed", true);
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
  expect(await db.get(key("ATTENDANCE#member-a", "CURRENT"))).toEqual(before);
  await openShop();
  advance(40);
  expect(await scan("000123")).toMatchObject({
    state: "out",
    creditedSeconds: 130,
  });
});

it("blocks role changes during an active visit and allows them after checkout", async () => {
  const { app, db, advance } = await fixture();
  await app.scan(device, "000123", uid());
  const member = (await db.get(key("USER#member-a")))!;
  const edit = {
    displayName: member.displayName,
    role: "MENTOR",
    active: true,
    version: member.v,
  };
  await expect(app.updateMember(admin, "member-a", edit)).rejects.toThrow(
    "clock out",
  );
  advance(30);
  await app.scan(device, "000123", uid());
  await app.updateMember(admin, "member-a", edit);
  expect(await db.get(key("USER#member-a"))).toMatchObject({
    role: "MENTOR",
    barcode: "000123",
  });
});
it("ends the kiosk at Chicago midnight and forfeits unfinished mentor and student visits", async () => {
  const { app, db, set, openShop } = await fixture(new MemoryStore(), false);
  set("2026-06-01T04:59:00.000Z");
  const kiosk = await openShop();
  const devicePrincipal = {
    kind: "device" as const,
    id: kiosk.sessionId,
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
    const [visit] = await all(db, "ATTENDANCE#" + memberId, {
      prefix: "SHOP#",
    });
    expect(visit).toMatchObject({
      status: "forfeited_missing_checkout",
      creditedSeconds: 0,
    });
  }
});
