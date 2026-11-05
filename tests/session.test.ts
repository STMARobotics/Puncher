import { afterEach, describe, expect, it } from "vitest";
import { human } from "../service/auth";
import { beginOAuth, endSession, finishOAuth } from "../service/session";
import { hash, key, row } from "../service/model";
import { atomic } from "../service/store";
import { dispatch } from "../service/api";
import { device as authenticateKiosk } from "../service/auth";
import { fixture } from "./helpers";

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
    GOOGLE_CLIENT_ID: "test-client",
    ALLOWED_ORIGIN: "http://localhost:5173",
  });
}

describe("server-managed OAuth sessions", () => {
  it("atomically exchanges a persisted mentor session for kiosk-only access", async () => {
    env();
    const { db } = await fixture();
    const token = "synthetic-seven-day-mentor-session",
      cookie = "puncher-local-session=" + token;
    await atomic(db, (tx) =>
      tx.put(
        row("SESSION#" + hash(token), "METADATA", {
          sub: "local-mentor",
          expiresAt: new Date(Date.now() + 7 * 86400000).toISOString(),
        }),
      ),
    );
    expect((await human({ cookie }, db)).id).toBe("local-mentor");
    const launch = await dispatch(
      {
        method: "POST",
        path: "/api/mentor/kiosk/launch",
        headers: {
          cookie,
          origin: "http://localhost:5173",
          "content-type": "application/json",
        },
        body: {},
      },
      db,
    );
    expect(launch.statusCode).toBe(200);
    expect(await db.get(key("SESSION#" + hash(token)))).toBeUndefined();
    const cookies = [launch.headers["set-cookie"]].flat();
    expect(cookies).toContainEqual(
      expect.stringMatching(/^puncher-local-session=;.*Max-Age=0/),
    );
    const kioskCookie = cookies
      .find((value) => value.startsWith("puncher-local-device="))!
      .split(";")[0];
    expect((await authenticateKiosk({ cookie: kioskCookie }, db)).kind).toBe(
      "device",
    );
    await expect(human({ cookie }, db)).rejects.toThrow("expired");
    expect(
      (
        await dispatch(
          {
            method: "GET",
            path: "/api/mentor/members",
            headers: { cookie: kioskCookie },
          },
          db,
        )
      ).statusCode,
    ).toBe(401);
  });
  it("keeps student and expired backend sessions out of mentor tools", async () => {
    env();
    const { db } = await fixture();
    await atomic(db, async (tx) => {
      await tx.put(
        row("IDENTITY#legacy-student", "METADATA", {
          enabled: true,
          roles: ["student"],
          memberId: "member-a",
        }),
      );
      await tx.put(
        row("SESSION#" + hash("student"), "METADATA", {
          sub: "legacy-student",
          expiresAt: "2099-01-01T00:00:00.000Z",
        }),
      );
      await tx.put(
        row("SESSION#" + hash("expired"), "METADATA", {
          sub: "local-mentor",
          expiresAt: "2000-01-01T00:00:00.000Z",
        }),
      );
    });
    for (const [token, status] of [
      ["student", 403],
      ["expired", 401],
    ] as const) {
      const result = await dispatch(
        {
          method: "POST",
          path: "/api/mentor/kiosk/launch",
          body: {},
          headers: {
            cookie: "puncher-local-session=" + token,
            origin: "http://localhost:5173",
            "content-type": "application/json",
          },
        },
        db,
      );
      expect(result.statusCode).toBe(status);
    }
  });
  it("checks Origin before revoking a browser login session", async () => {
    env();
    const { db } = await fixture(),
      k = key("SESSION#" + hash("logout-session"));
    await atomic(db, (tx) =>
      tx.put(
        row(k.pk, k.sk, {
          sub: "local-mentor",
          expiresAt: "2099-01-01T00:00:00.000Z",
        }),
      ),
    );
    const headers = {
      cookie: "puncher-local-session=logout-session",
      origin: "https://other.example",
      "content-type": "application/json",
    };
    expect(
      (
        await dispatch(
          { method: "POST", path: "/api/auth/logout", headers, body: {} },
          db,
        )
      ).statusCode,
    ).toBe(403);
    expect(await db.get(k)).toBeDefined();
    expect(
      (
        await dispatch(
          {
            method: "POST",
            path: "/api/auth/logout",
            headers: { ...headers, origin: "http://localhost:5173" },
            body: {},
          },
          db,
        )
      ).statusCode,
    ).toBe(200);
    expect(await db.get(k)).toBeUndefined();
  });
  it("uses state, PKCE and nonce, then restores and revokes a database session", async () => {
    env();
    const { db } = await fixture();
    const start = await beginOAuth(db);
    const authorization = new URL(start.headers.location as string);
    expect(authorization.origin).toBe("https://accounts.google.com");
    expect(authorization.searchParams.get("code_challenge_method")).toBe(
      "S256",
    );
    expect(authorization.searchParams.get("prompt")).toBeNull();
    expect(authorization.searchParams.get("redirect_uri")).toBe(
      "http://localhost:5173/api/auth/callback",
    );
    const state = authorization.searchParams.get("state")!;
    const pending = await db.get(key(`OAUTH#${hash(state)}`));
    const stateCookie = (start.headers["set-cookie"] as string[])[0].split(
      ";",
    )[0];
    const payload: any = {
      sub: "local-admin",
      iss: "https://accounts.google.com",
      aud: "test-client",
      hd: "stmarobotics.org",
      email: "admin@stmarobotics.org",
      email_verified: true,
      exp: Date.now() / 1000 + 300,
      nonce: pending!.nonce,
    };
    const finish = await finishOAuth(
      { code: "authorization-code", state },
      { cookie: stateCookie },
      db,
      {
        secret: async () => "synthetic-client-secret",
        exchange: async () =>
          new Response(JSON.stringify({ id_token: "synthetic-id-token" }), {
            status: 200,
          }),
        verify: async () => payload,
      },
    );
    expect(finish.statusCode).toBe(303);
    const cookies = finish.headers["set-cookie"] as string[];
    const sessionCookie = cookies.find((value) =>
      value.startsWith("puncher-local-session="),
    )!;
    expect(sessionCookie).toContain("HttpOnly");
    expect(sessionCookie).toContain("SameSite=Lax");
    const sessionHeaders = { cookie: sessionCookie.split(";")[0] };
    expect((await human(sessionHeaders, db)).id).toBe("local-admin");

    await endSession(sessionHeaders, db);
    await expect(human(sessionHeaders, db)).rejects.toThrow("expired");
    const replay = await finishOAuth(
      { code: "authorization-code", state },
      { cookie: stateCookie },
      db,
      {
        secret: async () => "synthetic-client-secret",
        exchange: async () => {
          throw new Error("replayed OAuth state should fail before exchange");
        },
        verify: async () => payload,
      },
    );
    expect(replay.statusCode).toBe(401);
    expect(replay.headers["set-cookie"]).toEqual(
      expect.arrayContaining([expect.stringContaining("Max-Age=0")]),
    );
  });
});
