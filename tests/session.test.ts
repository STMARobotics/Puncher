import { afterEach, describe, expect, it } from "vitest";
import { human } from "../service/auth";
import { beginOAuth, endSession, finishOAuth } from "../service/session";
import { hash, key } from "../service/model";
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
