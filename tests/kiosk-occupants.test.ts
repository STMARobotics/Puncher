import { it, expect } from "vitest";
import { fixture, device, admin } from "./helpers";
import { atomic } from "../service/store";
import { key, row, uid } from "../service/model";
import { dispatch } from "../service/api";
it("shows current names only, sorted, and removes people after checkout", async () => {
  const { app, db, advance } = await fixture();
  await atomic(db, async (tx) => {
    const member = (await tx.get(key("USER#member-a")))!;
    await tx.put({
      ...member,
      picture: "https://lh3.googleusercontent.com/a/alex",
    });
  });
  await app.scan(device, "000456", uid());
  await app.scan(device, "000123", uid());
  const result = await app.kioskOccupants(device);
  expect(result.occupants).toEqual([
    {
      displayName: "Alex Example",
      picture: "https://lh3.googleusercontent.com/a/alex",
    },
    { displayName: "Jordan Sample" },
  ]);
  expect(Object.keys(result).sort()).toEqual([
    "asOf",
    "mentors",
    "occupants",
    "shopOpen",
    "validUntil",
  ]);
  expect(result.mentors).toEqual([{ displayName: "Taylor Mentor" }]);
  expect(result.shopOpen).toBe(true);
  expect(Date.parse(result.validUntil) - Date.parse(result.asOf)).toBe(15000);
  expect(JSON.stringify(result)).not.toMatch(
    /member-a|member-b|000123|000456|sessionId|startedAt|email|barcode/,
  );
  await atomic(db, async (tx) => {
    const user = (await tx.get(key("USER#member-a")))!;
    const email = "alex.smith-jones@stmarobotics.org";
    await tx.put({ ...user, email, displayName: email });
  });
  expect((await app.kioskOccupants(device)).occupants).toEqual([
    {
      displayName: "Alex Smith-Jones",
      picture: "https://lh3.googleusercontent.com/a/alex",
    },
    { displayName: "Jordan Sample" },
  ]);
  advance(6);
  await app.scan(device, "000123", uid());
  expect((await app.kioskOccupants(device)).occupants).toEqual([
    { displayName: "Jordan Sample" },
  ]);
});
it("excludes expired visits before cleanup and expires the display precisely at midnight", async () => {
  const { app, set, db } = await fixture();
  set("2026-06-01T04:59:58.000Z");
  await app.scan(device, "000123", uid());
  expect((await app.kioskOccupants(device)).validUntil).toBe(
    "2026-06-01T05:00:00.000Z",
  );
  set("2026-06-01T05:00:00.000Z");
  expect((await app.kioskOccupants(device)).occupants).toEqual([]);
  expect(
    (await db.get(key("ATTENDANCE#member-a", "CURRENT")))?.sessionId,
  ).toBeTruthy();
});
it("ignores stale active pointers, completed sessions, and deactivated members", async () => {
  const { app, db, advance } = await fixture();
  await app.scan(device, "000123", uid());
  await app.scan(device, "000456", uid());
  const current = await db.get(key("ATTENDANCE#member-a", "CURRENT"));
  await atomic(db, async (tx) => {
    await tx.put(
      row("ACTIVE", "2099-01-01#stale", {
        memberId: "member-a",
        sessionId: "old-session",
        cutoffAt: "2099-01-01T00:00:00.000Z",
      }),
    );
    const session = await tx.get(
      key("ATTENDANCE#member-a", current!.sessionSk),
    );
    await tx.put({ ...session!, status: "completed" });
  });
  await atomic(db, async (tx) => {
    const member = await tx.get(key("USER#member-b"));
    await tx.put({ ...member!, active: false });
  });
  expect((await app.kioskOccupants(device)).occupants).toEqual([]);
});
it("requires device authentication and immediately enforces revocation", async () => {
  const { app, db } = await fixture();
  await expect(app.kioskOccupants(admin)).rejects.toThrow("device");
  const old = { ...process.env };
  try {
    Object.assign(process.env, {
      APP_ENV: "local",
      TABLE_NAME: "puncher-test",
      DYNAMODB_ENDPOINT: "http://127.0.0.1:8000",
      LOCAL_AUTH_FIXTURES: "true",
    });
    expect(
      (
        await dispatch(
          { method: "GET", path: "/api/kiosk/occupants", headers: {} },
          db,
        )
      ).statusCode,
    ).toBe(401);
    const response = await dispatch(
      {
        method: "GET",
        path: "/api/kiosk/occupants",
        headers: { "x-device-token": "test-device.test" },
      },
      db,
    );
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).occupants).toEqual([]);
  } finally {
    process.env = old;
  }
  await atomic(db, async (tx) => {
    const d = await tx.get(key("DEVICE#test-device"));
    await tx.put({ ...d!, enabled: false });
  });
  await expect(app.kioskOccupants(device)).rejects.toThrow("disabled");
});
