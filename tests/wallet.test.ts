import { afterEach, describe, expect, it } from "vitest";
import { generateKeyPairSync, verify } from "node:crypto";
import { dispatch } from "../service/api";
import { signWalletPass } from "../service/wallet";
import { fixture, seedUser } from "./helpers";

const original = { ...process.env };
afterEach(() => {
  process.env = { ...original };
});

function signingKey() {
  return generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
}

describe("Google Wallet attendance passes", () => {
  it("creates a signed generic pass JWT with the member's barcode", () => {
    const { privateKey, publicKey } = signingKey();
    const token = signWalletPass(
      {
        client_email: "wallet@example.iam.gserviceaccount.com",
        private_key: privateKey,
      },
      "BCR2DN6D6CVPJD2U.attendance",
      "member-a",
      "000123",
      "https://puncher.7028robotics.com",
      new Date("2026-11-05T12:00:00.000Z"),
    );
    const [header, payload, signature] = token.split(".");
    const input = `${header}.${payload}`;
    expect(
      verify(
        "RSA-SHA256",
        Buffer.from(input),
        publicKey,
        Buffer.from(signature, "base64url"),
      ),
    ).toBe(true);
    expect(JSON.parse(Buffer.from(header, "base64url").toString())).toEqual({
      alg: "RS256",
      typ: "JWT",
    });
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
    expect(claims).toMatchObject({
      iss: "wallet@example.iam.gserviceaccount.com",
      aud: "google",
      typ: "savetowallet",
      iat: 1793880000,
      origins: ["puncher.7028robotics.com"],
      payload: {
        genericObjects: [
          {
            classId: "BCR2DN6D6CVPJD2U.attendance",
            state: "ACTIVE",
            barcode: { type: "CODE_128", value: "000123" },
          },
        ],
      },
    });
    expect(claims.payload.genericObjects[0].id).toMatch(
      /^BCR2DN6D6CVPJD2U\.member-[a-f0-9]{64}$/,
    );
    expect(claims.payload.genericObjects[0].id).not.toContain("member-a");
  });

  it("returns a signed save URL to any authenticated member with an active barcode", async () => {
    Object.assign(process.env, {
      APP_ENV: "local",
      TABLE_NAME: "puncher-test",
      DYNAMODB_ENDPOINT: "http://127.0.0.1:8000",
      LOCAL_AUTH_FIXTURES: "true",
      GOOGLE_WALLET_CLASS_ID: "BCR2DN6D6CVPJD2U.attendance",
      GOOGLE_WALLET_SERVICE_ACCOUNT_JSON: JSON.stringify({
        client_email: "wallet@example.iam.gserviceaccount.com",
        private_key: signingKey().privateKey,
      }),
    });
    const { db } = await fixture();
    await seedUser(db, "local-student", "Local Student", "STUDENT", "009999");

    const result = await dispatch(
      {
        method: "GET",
        path: "/api/wallet/save",
        headers: { authorization: "Bearer local-student" },
      },
      db,
    );
    expect(result.statusCode).toBe(200);
    expect(result.headers["cache-control"]).toBe("no-store");
    expect(result.headers["referrer-policy"]).toBe("no-referrer");
    const location = new URL(JSON.parse(result.body).url);
    expect(location.origin).toBe("https://pay.google.com");
    expect(location.pathname).toMatch(/^\/gp\/v\/save\/[^/]+$/);

    const adminResult = await dispatch(
      {
        method: "GET",
        path: "/api/wallet/save",
        headers: { authorization: "Bearer local-admin" },
      },
      db,
    );
    expect(adminResult.statusCode).toBe(200);

    const denied = await dispatch(
      {
        method: "GET",
        path: "/api/wallet/save",
        headers: {},
      },
      db,
    );
    expect(denied.statusCode).toBe(401);
  });

  it("rejects malformed configuration and barcode input", () => {
    const { privateKey } = signingKey();
    const credential = {
      client_email: "wallet@example.iam.gserviceaccount.com",
      private_key: privateKey,
    };
    expect(() =>
      signWalletPass(
        credential,
        "not-an-issuer-class",
        "member-a",
        "000123",
        "https://puncher.7028robotics.com",
      ),
    ).toThrow("class is not configured");
    expect(() =>
      signWalletPass(
        credential,
        "BCR2DN6D6CVPJD2U.attendance",
        "member-a",
        "123",
        "https://puncher.7028robotics.com",
      ),
    ).toThrow("Invalid attendance barcode");
  });
});
