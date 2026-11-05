import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  assertGoogleIdentity,
  human,
  cookieValue,
  sessionCookieName,
  verifyGoogle,
  type Verify,
} from "./auth";
import { Puncher } from "./domain";
import { type Store, atomic } from "./store";
import { assert, Fault, hash, key, row } from "./model";
import { runtime } from "./runtime";

const SESSION_SECONDS = 7 * 24 * 60 * 60;
const OAUTH_SECONDS = 10 * 60;
const STATE_COOKIE = (local: boolean) =>
  local ? "puncher-local-oauth-state" : "__Host-puncher-oauth-state";
const ssm = new SSMClient({});
let cachedSecret: string | undefined;

export type HttpResult = {
  statusCode: number;
  headers: Record<string, string | string[]>;
  body: string;
};

const cookie = (name: string, value: string, maxAge: number, local: boolean) =>
  `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${local ? "" : "; Secure"}`;
const clearCookie = (name: string, local: boolean) =>
  cookie(name, "", 0, local);
export const clearedSessionCookies = (local: boolean) => [
  clearCookie(sessionCookieName(local), local),
  clearCookie(STATE_COOKIE(local), local),
];
const redirect = (location: string, cookies: string[] = []): HttpResult => ({
  statusCode: 303,
  headers: {
    location,
    "cache-control": "no-store",
    ...(cookies.length ? { "set-cookie": cookies } : {}),
  },
  body: "",
});

async function clientSecret() {
  const c = runtime();
  if (c.local) {
    assert(
      process.env.GOOGLE_CLIENT_SECRET,
      "Google client secret is not configured.",
      503,
    );
    return process.env.GOOGLE_CLIENT_SECRET;
  }
  assert(
    c.googleClientSecretParameter,
    "Google client secret parameter is not configured.",
    503,
  );
  if (cachedSecret) return cachedSecret;
  const parameter = await ssm.send(
    new GetParameterCommand({
      Name: c.googleClientSecretParameter,
      WithDecryption: true,
    }),
  );
  assert(
    parameter.Parameter?.Value,
    "Google client secret is unavailable.",
    503,
  );
  cachedSecret = parameter.Parameter.Value;
  return cachedSecret;
}

export async function beginGoogleSignIn(
  db: Store,
  query: { member?: string; invite?: string } = {},
): Promise<HttpResult> {
  const c = runtime();
  assert(c.googleClientId, "Google sign-in is not configured.", 503);
  const { member, invite } = query;
  if (member !== undefined || invite !== undefined)
    assert(
      member && member.length <= 254 && invite && /^[\w-]{43}$/.test(invite),
      "Invalid administrator invitation.",
    );
  const state = randomBytes(32).toString("base64url");
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const nonce = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + OAUTH_SECONDS * 1000).toISOString();
  await atomic(db, async (tx) => {
    await tx.put(
      row(`OAUTH#${hash(state)}`, "METADATA", {
        verifier,
        nonce,
        ...(member && invite && {
          adminInvite: { memberId: member, tokenHash: hash(invite) },
        }),
        expiresAt,
        ttl: Math.floor(Date.now() / 1000) + OAUTH_SECONDS,
      }),
    );
  });
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({
    client_id: c.googleClientId,
    redirect_uri: `${c.origin}/api/auth/callback`,
    response_type: "code",
    scope: "openid email",
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: "S256",
    hd: "stmarobotics.org",
    ...(invite && { prompt: "select_account" }),
  }).toString();
  return redirect(url.toString(), [
    cookie(STATE_COOKIE(c.local), state, OAUTH_SECONDS, c.local),
  ]);
}

type OAuthOptions = {
  secret?: () => Promise<string>;
  exchange?: typeof fetch;
  verify?: Verify;
  now?: () => Date;
};

export async function finishGoogleSignIn(
  query: Record<string, string | undefined>,
  headers: Record<string, string | undefined>,
  db: Store,
  options: OAuthOptions = {},
): Promise<HttpResult> {
  const c = runtime();
  const stateCookie = STATE_COOKIE(c.local);
  const clearState = clearCookie(stateCookie, c.local);
  try {
    assert(!query.error, "Google sign-in was cancelled.", 401);
    const state = query.state;
    const stateFromCookie = cookieValue(headers, stateCookie);
    assert(
      state &&
        stateFromCookie &&
        Buffer.byteLength(state) === Buffer.byteLength(stateFromCookie) &&
        timingSafeEqual(Buffer.from(state), Buffer.from(stateFromCookie)),
      "Sign-in could not be verified. Please try again.",
      401,
    );
    const pending = await atomic(db, async (tx) => {
      const current = await tx.get(key(`OAUTH#${hash(state)}`));
      assert(
        current,
        "Sign-in expired or was already used. Please try again.",
        401,
      );
      await tx.del(key(`OAUTH#${hash(state)}`));
      return current;
    });
    assert(
      pending.expiresAt > (options.now?.() || new Date()).toISOString(),
      "Sign-in expired. Please try again.",
      401,
    );
    assert(query.code, "Google did not return an authorization code.", 401);
    const secret = await (options.secret || clientSecret)();
    const response = await (options.exchange || fetch)(
      "https://oauth2.googleapis.com/token",
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code: query.code,
          client_id: c.googleClientId,
          client_secret: secret,
          redirect_uri: `${c.origin}/api/auth/callback`,
          grant_type: "authorization_code",
          code_verifier: pending.verifier,
        }),
        signal: AbortSignal.timeout(10000),
      },
    );
    assert(
      response.ok,
      "Google sign-in could not be completed. Please try again.",
      401,
    );
    const tokens = (await response.json()) as { id_token?: string };
    assert(tokens.id_token, "Google did not return an identity token.", 401);
    const verify = options.verify || verifyGoogle;
    const payload = await verify(tokens.id_token, c.googleClientId);
    assert(
      payload?.nonce &&
        Buffer.byteLength(payload.nonce) === Buffer.byteLength(pending.nonce) &&
        timingSafeEqual(Buffer.from(payload.nonce), Buffer.from(pending.nonce)),
      "Google sign-in could not be verified. Please try again.",
      401,
    );
    if (pending.adminInvite) {
      assertGoogleIdentity(payload, c.googleClientId);
      const { memberId, tokenHash } = pending.adminInvite;
      await new Puncher(db, options.now).acceptAdministratorInvite(
        memberId,
        tokenHash,
        payload,
      );
    }
    const principal = await human(
      { authorization: `Bearer ${tokens.id_token}` },
      db,
      async () => payload,
    );
    const sessionToken = randomBytes(32).toString("base64url");
    const now = options.now?.() || new Date();
    const expires = new Date(now.getTime() + SESSION_SECONDS * 1000);
    await atomic(db, async (tx) => {
      await tx.put(
        row(`SESSION#${hash(sessionToken)}`, "METADATA", {
          sub: payload.sub,
          ...(principal.rosterEmail
            ? {
                rosterEmail: principal.rosterEmail,
                rosterMemberId: principal.memberId,
              }
            : {}),
          expiresAt: expires.toISOString(),
          ttl: Math.floor(expires.getTime() / 1000),
        }),
      );
    });
    return redirect("/", [
      clearState,
      cookie(
        sessionCookieName(c.local),
        sessionToken,
        SESSION_SECONDS,
        c.local,
      ),
    ]);
  } catch (error) {
    if (error instanceof Fault)
      return {
        statusCode: error.status,
        headers: {
          "content-type": "application/json",
          "cache-control": "no-store",
          "set-cookie": [clearState],
        },
        body: JSON.stringify({ message: error.message }),
      };
    console.error(
      JSON.stringify({
        event: "oauth.callback.failure",
        errorType: error instanceof Error ? error.name : "unknown",
      }),
    );
    return {
      statusCode: 503,
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
        "set-cookie": [clearState],
      },
      body: JSON.stringify({
        message: "Google sign-in is temporarily unavailable. Please try again.",
      }),
    };
  }
}

export async function endSession(
  headers: Record<string, string | undefined>,
  db: Store,
): Promise<HttpResult> {
  const c = runtime();
  const name = sessionCookieName(c.local);
  const sessionToken = cookieValue(headers, name);
  if (sessionToken)
    await atomic(db, async (tx) => {
      const sessionKey = key(`SESSION#${hash(sessionToken)}`);
      if (await tx.get(sessionKey)) await tx.del(sessionKey);
    });
  return {
    statusCode: 200,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      "set-cookie": clearedSessionCookies(c.local),
    },
    body: JSON.stringify({ signedOut: true }),
  };
}
