import { describe, it, expect, afterEach } from "vitest";
import { human, device as authenticateDevice } from "../service/auth";
import { runtime } from "../service/runtime";
import { fixture, admin, device } from "./helpers";
import { atomic } from "../service/store";
import { row, key, uid } from "../service/model";
import { dispatch } from "../service/api";
const original = { ...process.env };
afterEach(() => {
  process.env = { ...original };
});
function env() {
  Object.assign(process.env, {
    APP_ENV: "local",
    TABLE_NAME: "puncher-test",
    DYNAMODB_ENDPOINT: "http://127.0.0.1:8000",
    LOCAL_AUTH_FIXTURES: "false",
    LOCAL_ROSTER_FIXTURES: "false",
    GOOGLE_CLIENT_ID: "test-client",
    ALLOWED_ORIGIN: "http://localhost:5173",
  });
}
describe("verified identity and route boundaries", () => {
  it("validates issuer audience domain verification subject expiry after signature verification", async () => {
    env();
    const { db } = await fixture();
    const good: any = {
      sub: "local-admin",
      iss: "https://accounts.google.com",
      aud: "test-client",
      hd: "stmarobotics.org",
      email: "admin@stmarobotics.org",
      email_verified: true,
      exp: Date.now() / 1000 + 300,
    };
    expect(
      (await human({ authorization: "Bearer valid" }, db, async () => good)).id,
    ).toBe("local-admin");
    for (const patch of [
      { sub: "" },
      { iss: "bad" },
      { aud: "other" },
      { hd: "other.org" },
      { email_verified: false },
      { exp: 1 },
      { email: "x@other.org" },
    ])
      await expect(
        human({ authorization: "Bearer valid" }, db, async () => ({
          ...good,
          ...patch,
        })),
      ).rejects.toThrow();
    await expect(
      human({ authorization: "Bearer invalid" }, db, async () => {
        throw new Error("signature mismatch");
      }),
    ).rejects.toThrow("invalid");
  });
  it("rejects unmapped and disabled subjects", async () => {
    env();
    const { db } = await fixture();
    const payload: any = {
      sub: "unmapped",
      iss: "accounts.google.com",
      aud: "test-client",
      hd: "stmarobotics.org",
      email: "x@stmarobotics.org",
      email_verified: true,
      exp: Date.now() / 1000 + 300,
    };
    await expect(
      human({ authorization: "Bearer t" }, db, async () => payload),
    ).rejects.toThrow("setup");
    await atomic(db, async (tx) => {
      const r = await tx.get(key("IDENTITY#local-admin"));
      await tx.put({ ...r!, enabled: false });
    });
    await expect(
      human({ authorization: "Bearer t" }, db, async () => ({
        ...payload,
        sub: "local-admin",
      })),
    ).rejects.toThrow("disabled");
  });
  it("makes development fixtures impossible in production or Lambda", () => {
    env();
    process.env.LOCAL_AUTH_FIXTURES = "true";
    expect(runtime().fixtures).toBe(true);
    process.env.LOCAL_ROSTER_FIXTURES = "true";
    expect(runtime().rosterLocalFixtures).toBe(true);
    process.env.LOCAL_AUTH_FIXTURES = "false";
    expect(runtime).toThrow("Roster fixtures are forbidden");
    process.env.LOCAL_AUTH_FIXTURES = "true";
    process.env.AWS_LAMBDA_FUNCTION_NAME = "deployed";
    expect(runtime).toThrow("forbidden");
    delete process.env.AWS_LAMBDA_FUNCTION_NAME;
    process.env.APP_ENV = "prod";
    expect(runtime).toThrow();
  });
  it("isolates staff and kiosk routes and requires origin protection", async () => {
    env();
    process.env.LOCAL_AUTH_FIXTURES = "true";
    const { db } = await fixture();
    expect(
      (
        await dispatch(
          {
            method: "GET",
            path: "/api/admin/members",
            headers: { "x-device-token": "test-device.test" },
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
            path: "/api/kiosk/scan",
            headers: {
              authorization: "Bearer local-admin",
              origin: "http://localhost:5173",
              "content-type": "application/json",
            },
            body: { barcode: "000123", operationId: uid() },
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
            path: "/api/admin/members",
            headers: {
              authorization: "Bearer local-admin",
              origin: "https://evil.example",
              "content-type": "application/json",
            },
            body: {},
          },
          db,
        )
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await dispatch(
          {
            method: "GET",
            path: "/api/admin/members",
            headers: { authorization: "Bearer local-admin" },
          },
          db,
        )
      ).statusCode,
    ).toBe(200);
  });
});
