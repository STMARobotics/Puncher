import { describe, it, expect } from "vitest";
import { fixture, admin, mentor, device } from "./helpers";
import { all, atomic } from "../service/store";
import {
  key,
  uid,
  reportingYear,
  cutoff,
  hoursToSeconds,
  eligible,
  row,
} from "../service/model";
describe("shop attendance", () => {
  it("preserves leading zeros, credits exact seconds and multiple visits", async () => {
    const { app, db, advance } = await fixture();
    expect((await app.scan(device, "000123", uid())).state).toBe("in");
    advance(3661);
    expect(await app.scan(device, "000123", uid())).toMatchObject({
      state: "out",
      creditedSeconds: 3661,
      todaySeconds: 3661,
    });
    advance(6);
    await app.scan(device, "000123", uid());
    advance(120);
    expect(await app.scan(device, "000123", uid())).toMatchObject({
      state: "out",
      creditedSeconds: 120,
      todaySeconds: 3781,
    });
    expect(
      (await all(db, "MEMBER#member-a", { prefix: "SHOP#" })).filter(eligible),
    ).toHaveLength(2);
  });
  it("rejects malformed, unknown and inactive cards without attendance mutation", async () => {
    const { app, db } = await fixture();
    for (const card of ["123", "1234567", "123\n", "abcdef", "999999"])
      await expect(app.scan(device, card, uid())).rejects.toThrow();
    await app.saveMember(
      admin,
      {
        displayName: "Alex Example",
        memberKind: "student",
        active: false,
        barcode: "000123",
      },
      "member-a",
    );
    await expect(app.scan(device, "000123", uid())).rejects.toThrow("inactive");
    expect(await all(db, "MEMBER#member-a", { prefix: "SHOP#" })).toHaveLength(
      0,
    );
  });
  it("returns saved retries after cooldown, binds payload, fails closed after response expiry", async () => {
    const { app, advance } = await fixture();
    const id = uid(),
      first = await app.scan(device, "000123", id);
    advance(100);
    expect(await app.scan(device, "000123", id)).toEqual(first);
    await expect(app.scan(device, "000456", id)).rejects.toThrow(
      "different payload",
    );
    advance(86400);
    await expect(app.scan(device, "000123", id)).rejects.toThrow("expired");
  });
  it("suppresses rapid reads per member while allowing another student", async () => {
    const { app, db } = await fixture();
    await app.scan(device, "000123", uid());
    expect((await app.scan(device, "000123", uid())).state).toBe("cooldown");
    expect((await app.scan(device, "000456", uid())).state).toBe("in");
    expect((await all(db, "ACTIVE")).length).toBe(3);
  });
  it("handles concurrent toggles and concurrent duplicate operation retries", async () => {
    const { app, db } = await fixture();
    const id = uid();
    const same = await Promise.all(
      Array.from({ length: 5 }, () => app.scan(device, "000123", id)),
    );
    expect(same.every((r) => r.state === "in")).toBe(true);
    const rapid = await Promise.all(
      Array.from({ length: 5 }, () => app.scan(device, "000123", uid())),
    );
    expect(rapid.every((r) => r.state === "cooldown")).toBe(true);
    expect(await all(db, "MEMBER#member-a", { prefix: "SHOP#" })).toHaveLength(
      1,
    );
  });
  it("enforces transactional card uniqueness during concurrent assignment", async () => {
    const { app } = await fixture();
    const rs = await Promise.allSettled(
      ["new-a", "new-b"].map((id) =>
        app.saveMember(
          admin,
          {
            displayName: id,
            memberKind: "student",
            active: true,
            barcode: "009999",
          },
          id,
        ),
      ),
    );
    expect(rs.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  });
  it("expires only unfinished visits and retains warnings until delivery is confirmed", async () => {
    const { app, db, advance, set, openShop } = await fixture();
    await app.scan(device, "000123", uid());
    advance(600);
    await app.scan(device, "000123", uid());
    advance(6);
    await app.scan(device, "000123", uid());
    set("2026-06-01T05:00:00.000Z");
    await openShop();
    const id = uid(),
      result = await app.scan(device, "000123", id);
    expect(result.state).toBe("in");
    expect(result.warning.shopDate).toBe("2026-05-31");
    const sessions = await all(db, "MEMBER#member-a", { prefix: "SHOP#" });
    expect(
      sessions.filter(eligible).reduce((n, r) => n + r.creditedSeconds, 0),
    ).toBe(600);
    expect(
      sessions.find((r) => r.status === "forfeited_missing_checkout")
        ?.creditedSeconds,
    ).toBe(0);
    expect(
      (await db.get(key("MEMBER#member-a", "CURRENT")))?.warning,
    ).toBeTruthy();
    await app.acknowledge(device, id, result.warning.id);
    expect(
      (await db.get(key("MEMBER#member-a", "CURRENT")))?.warning,
    ).toBeNull();
  });
  it("starts a new visit after cutoff even within the cooldown", async () => {
    const { app, set, openShop } = await fixture();
    set("2026-06-01T04:59:59.000Z");
    await app.scan(device, "000123", uid());
    set("2026-06-01T05:00:00.000Z");
    await openShop();
    expect((await app.scan(device, "000123", uid())).state).toBe("in");
  });
  it("starts after scheduler expiration even if the prior scan was one second before midnight", async () => {
    const { app, set, openShop } = await fixture();
    set("2026-06-01T04:59:59.000Z");
    await app.scan(device, "000123", uid());
    set("2026-06-01T05:00:00.000Z");
    await openShop();
    await app.cleanup();
    const result = await app.scan(device, "000123", uid());
    expect(result.state).toBe("in");
    expect(result.warning.shopDate).toBe("2026-05-31");
  });
  it("catches up multiple dates, cleanup reruns and concurrent cleanup/scan do not clear a new session", async () => {
    const { app, db, set, openShop } = await fixture();
    await app.scan(device, "000123", uid());
    await app.scan(device, "000456", uid());
    set("2026-06-04T05:00:01.000Z");
    const opening = await openShop();
    await Promise.all([app.cleanup(), app.scan(device, "000123", uid())]);
    await app.cleanup();
    const current = await db.get(key("MEMBER#member-a", "CURRENT"));
    expect(current?.sessionId).toBeTruthy();
    expect((await all(db, "ACTIVE")).length).toBe(2);
    const mentorCard = await db.get(key("CARD#" + opening.barcode));
    expect((await app.roster(admin)).map((r) => r.memberId).sort()).toEqual(
      ["member-a", mentorCard!.memberId].sort(),
    );
  });
  it("logically excludes expired active visits before scheduler cleanup", async () => {
    const { app, set } = await fixture();
    await app.scan(device, "000123", uid());
    set("2026-06-01T05:00:01.000Z");
    expect(await app.roster(admin)).toEqual([]);
  });
  it("forbids device and student operational mutations and disabled devices", async () => {
    const { app, db } = await fixture();
    await expect(app.saveMember(device, {}, "x")).rejects.toThrow("Mentor");
    await expect(app.award(device, "x", "000123")).rejects.toThrow("Mentor");
    await atomic(db, async (tx) => {
      const d = await tx.get(key("DEVICE#test-device"));
      await tx.put({ ...d!, enabled: false });
    });
    await expect(app.scan(device, "000123", uid())).rejects.toThrow("disabled");
  });
});
describe("volunteer", () => {
  it("uniquely awards event credit across phones, locks snapshots, audits removal", async () => {
    const { app, db } = await fixture();
    const e = await app.saveEvent(mentor, {
      title: "Synthetic open house",
      eventDate: "2026-06-01",
      hours: "1.25",
    });
    const rs = await Promise.all([
      app.award(mentor, e.eventId, "000123"),
      app.award(mentor, e.eventId, "000123"),
    ]);
    expect(rs.map((r) => r.state).sort()).toEqual(["already", "logged"]);
    expect(
      (await all(db, "MEMBER#member-a", { prefix: "VOLUNTEER#" })).reduce(
        (n, r) => n + r.creditedSeconds,
        0,
      ),
    ).toBe(4500);
    await expect(
      app.saveEvent(
        mentor,
        { title: e.title, eventDate: e.eventDate, hours: "2" },
        e.eventId,
      ),
    ).rejects.toThrow("locked");
    await app.removeAward(
      mentor,
      e.eventId,
      "member-a",
      "Wrong student scanned",
    );
    expect(
      (await all(db, "MEMBER#member-a", { prefix: "VOLUNTEER#" }))[0].status,
    ).toBe("voided");
    expect(
      await all(db, `EVENT#${e.eventId}`, { prefix: "PARTICIPANT#" }),
    ).toHaveLength(0);
  });
  it("enforces ownership, server event duration and explicit role binding uniqueness", async () => {
    const { app } = await fixture();
    const e = await app.saveEvent(admin, {
      title: "Admin event",
      eventDate: "2026-06-01",
      hours: "2",
    });
    await expect(app.award(mentor, e.eventId, "000123")).rejects.toThrow(
      "another mentor",
    );
    await app.saveIdentity(admin, {
      googleSub: "sub-a",
      email: "example@stmarobotics.org",
      memberId: "member-a",
      roles: ["student"],
      enabled: true,
    });
    await expect(
      app.saveIdentity(admin, {
        googleSub: "sub-b",
        email: "second@stmarobotics.org",
        memberId: "member-a",
        roles: ["student"],
        enabled: true,
      }),
    ).rejects.toThrow("already linked");
  });
  it("does not offer a forfeited-shop restore path through import review", async () => {
    const { app } = await fixture();
    await expect(
      app.review(admin, {
        pk: "MEMBER#member-a",
        sk: "CURRENT",
        status: "approved",
        reason: "Attempt",
      }),
    ).rejects.toThrow("Only imported");
  });
});
describe("calendar and precision", () => {
  it("uses June 1 inclusive ending years", () => {
    expect(reportingYear("2026-06-01")).toBe(2026);
    expect(reportingYear("2026-06-02")).toBe(2027);
    expect(() => reportingYear("2026-02-30")).toThrow();
  });
  it("handles spring and fall midnight cutoffs without fixed day arithmetic", () => {
    expect(cutoff("2026-03-08")).toBe("2026-03-09T05:00:00.000Z");
    expect(cutoff("2026-11-01")).toBe("2026-11-02T06:00:00.000Z");
    expect(
      Date.parse(cutoff("2026-03-08")) - Date.parse(cutoff("2026-03-07")),
    ).toBe(23 * 3600000);
    expect(
      Date.parse(cutoff("2026-11-01")) - Date.parse(cutoff("2026-10-31")),
    ).toBe(25 * 3600000);
  });
  it("converts decimal hours once without floating total drift", () => {
    expect(hoursToSeconds("0.1") + hoursToSeconds("0.2")).toBe(1080);
    expect(hoursToSeconds("1.2345")).toBe(4444);
    expect(hoursToSeconds("-0.1")).toBe(-360);
    expect(() => hoursToSeconds("")).toThrow();
  });
});
