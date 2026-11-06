import { afterEach, expect, it } from "vitest";
import { MemoryStore, atomic, all } from "../service/store";
import { key, row, uid } from "../service/model";
import { assignCard } from "../service/card-codes";
import { dispatch } from "../service/api";
import { device as authenticateKiosk } from "../service/auth";
import { fixture, admin, mentor } from "./helpers";

const original = { ...process.env };
afterEach(() => {
  process.env = { ...original };
});
function env() {
  Object.assign(process.env, {
    APP_ENV: "local",
    TABLE_NAME: "mentor-test",
    DYNAMODB_ENDPOINT: "http://127.0.0.1:8766",
    LOCAL_AUTH_FIXTURES: "true",
    ALLOWED_ORIGIN: "http://localhost:5173",
    GOOGLE_CLIENT_ID: "test-client",
  });
}
const headers = (token = "local-mentor") => ({
  authorization: "Bearer " + token,
  origin: "http://localhost:5173",
  "content-type": "application/json",
});
it("reserves retired codes permanently and collision-checks allocations", async () => {
  const { db } = await fixture();
  await atomic(db, async (tx) => {
    await assignCard(tx, "old-member", "123456");
    const card = await tx.get(key("CARD#123456"));
    await tx.put({ ...card!, retired: true });
  });
  let attempt = 0;
  const code = await atomic(db, (tx) =>
    assignCard(tx, "different-member", undefined, () =>
      ++attempt === 1 ? "123456" : "234567",
    ),
  );
  expect(code).toBe("234567");
  expect(await db.get(key("CARD#123456"))).toMatchObject({
    memberId: "old-member",
    retired: true,
  });
});
it("retries a replacement once and never randomly reactivates a retired code for the same member", async () => {
  const { app, db } = await fixture();
  const id = uid();
  const results = await Promise.all([
    app.replaceCard(admin, "member-a", id),
    app.replaceCard(admin, "member-a", id),
  ]);
  expect(results[0]).toEqual(results[1]);
  expect(results[0].barcode).not.toBe("000123");
  let calls = 0;
  expect(
    await atomic(db, (tx) =>
      assignCard(tx, "member-a", undefined, () =>
        ++calls === 1 ? "000123" : "654321",
      ),
    ),
  ).toBe("654321");
});
it("allows only admins to change an existing member role and keeps their barcode", async () => {
  env();
  const { db } = await fixture();
  const userKey = key("USER#member-a");
  const before = (await db.get(userKey))!;
  const request = (actor: string, role: unknown, version = before.v) =>
    dispatch(
      {
        method: "PATCH",
        path: "/api/admin/members/member-a",
        headers: headers(actor),
        body: { displayName: before.displayName, active: true, role, version },
      },
      db,
    );
  expect((await request("local-mentor", "ADMIN")).statusCode).toBe(403);
  expect((await request("local-admin", ["MENTOR", "ADMIN"])).statusCode).toBe(
    400,
  );
  expect((await request("local-admin", "ADMIN")).statusCode).toBe(200);
  expect(await db.get(userKey)).toMatchObject({
    role: "ADMIN",
    barcode: before.barcode,
  });
  expect((await request("local-admin", "MENTOR")).statusCode).toBe(409);
});
async function activate(
  db: Awaited<ReturnType<typeof fixture>>["db"],
  cookie?: string,
) {
  const issued = await dispatch(
    {
      method: "POST",
      path: "/api/mentor/kiosk/activation",
      headers: headers(),
      body: {},
    },
    db,
  );
  expect(issued.statusCode).toBe(201);
  return dispatch(
    {
      method: "POST",
      path: "/api/kiosk/activate",
      headers: {
        origin: "http://localhost:5173",
        "content-type": "application/json",
        cookie,
      },
      body: { code: JSON.parse(issued.body).code },
    },
    db,
  );
}
it("launches an isolated kiosk via mentor login, renews the same retry identity, rotates its secret and ends access", async () => {
  env();
  const { db } = await fixture();
  const first = await activate(db);
  expect(first.statusCode).toBe(200);
  expect([first.headers["set-cookie"]].flat().join(";")).toContain("HttpOnly");
  expect(first.body).not.toContain("credential");
  const cookie = [first.headers["set-cookie"]]
      .flat()
      .find((value) => value.startsWith("puncher-local-device="))!
      .split(";")[0],
    session = JSON.parse(first.body),
    op = uid();
  const scan = () =>
    dispatch(
      {
        method: "POST",
        path: "/api/kiosk/scan",
        headers: { ...headers(), cookie },
        body: { barcode: "000123", operationId: op },
      },
      db,
    );
  expect(JSON.parse((await scan()).body).state).toBe("in");
  const renewed = await activate(db, cookie);
  expect(JSON.parse(renewed.body).sessionId).toBe(session.sessionId);
  expect(JSON.parse(renewed.body).resumed).toBe(true);
  const nextCookie = [renewed.headers["set-cookie"]]
    .flat()
    .find((value) => value.startsWith("puncher-local-device="))!
    .split(";")[0];
  await expect(authenticateKiosk({ cookie }, db)).rejects.toThrow();
  const retry = await dispatch(
    {
      method: "POST",
      path: "/api/kiosk/scan",
      headers: { ...headers(), cookie: nextCookie },
      body: { barcode: "000123", operationId: op },
    },
    db,
  );
  expect(JSON.parse(retry.body).state).toBe("in");
  expect(
    await all(db, "ATTENDANCE#member-a", { prefix: "SHOP#" }),
  ).toHaveLength(1);
  expect(
    (
      await dispatch(
        {
          method: "GET",
          path: "/api/admin/members",
          headers: { cookie: nextCookie },
        },
        db,
      )
    ).statusCode,
  ).toBe(401);
  expect(
    (
      await dispatch(
        {
          method: "POST",
          path: "/api/kiosk/setup",
          headers: headers(),
          body: {},
        },
        db,
      )
    ).statusCode,
  ).toBe(410);
  expect(
    (
      await dispatch(
        {
          method: "POST",
          path: "/api/kiosk/end",
          headers: { ...headers(), cookie: nextCookie },
          body: {},
        },
        db,
      )
    ).statusCode,
  ).toBe(200);
  await expect(authenticateKiosk({ cookie: nextCookie }, db)).rejects.toThrow();
});
it("immediately rejects kiosk sessions whose launching mentor loses access", async () => {
  env();
  const { db } = await fixture();
  const launch = await activate(db);
  const cookie = [launch.headers["set-cookie"]]
    .flat()
    .find((value) => value.startsWith("puncher-local-device="))!
    .split(";")[0];
  await atomic(db, async (tx) => {
    const r = await tx.get(key("USER#local-mentor"));
    await tx.put({ ...r!, role: "STUDENT" });
  });
  await expect(authenticateKiosk({ cookie }, db)).rejects.toThrow("mentor");
});

it("accepts a kiosk QR once and checks expiry and the issuing mentor's current access", async () => {
  const { app, db, advance } = await fixture();
  const issued = await app.issueKioskActivation(mentor);
  const results = await Promise.allSettled([
    app.activateKiosk(issued.code),
    app.activateKiosk(issued.code),
  ]);
  const accepted = results.filter((result) => result.status === "fulfilled");
  expect(accepted).toHaveLength(1);
  expect(
    await db.get(key("DEVICE#" + accepted[0].value.sessionId)),
  ).toMatchObject({ launchedBy: mentor.id, launchedAt: expect.any(String) });
  const expiring = await app.issueKioskActivation(mentor);
  advance(121);
  await expect(app.activateKiosk(expiring.code)).rejects.toThrow("expired");
  const revoked = await app.issueKioskActivation(mentor);
  await atomic(db, async (tx) => {
    const user = await tx.get(key("USER#" + mentor.id));
    await tx.put({ ...user!, active: false });
  });
  await expect(app.activateKiosk(revoked.code)).rejects.toThrow(
    "no longer has access",
  );
});
