import { OAuth2Client, type TokenPayload } from "google-auth-library";
import { timingSafeEqual } from "node:crypto";
import { type Store } from "./store";
import { type Principal, key, hash, assert, Fault } from "./model";
import { runtime, store } from "./runtime";
export type Verify = (
  token: string,
  audience: string,
) => Promise<TokenPayload | undefined>;
const google = new OAuth2Client();
export const verifyGoogle: Verify = async (token, audience) =>
  (await google.verifyIdToken({ idToken: token, audience })).getPayload();

export function cookieValue(
  headers: Record<string, string | undefined>,
  name: string,
) {
  return headers.cookie
    ?.split(";")
    .map((x) => x.trim())
    .find((x) => x.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}

export function sessionCookieName(local: boolean) {
  return local ? "puncher-local-session" : "__Host-puncher-session";
}

export async function human(
  headers: Record<string, string | undefined>,
  db: Store,
  verify: Verify = verifyGoogle,
): Promise<Principal> {
  const c = runtime();
  const bearer = headers.authorization?.match(
    new RegExp("^Bearer\\s+(.+)$", "i"),
  )?.[1];
  let sub: string;
  if (
    c.fixtures &&
    bearer &&
    ["local-admin", "local-mentor", "local-student"].includes(bearer)
  )
    sub = bearer;
  else if (bearer) {
    assert(c.googleClientId, "Google client is not configured.", 503);
    let t: TokenPayload | undefined;
    try {
      t = await verify(bearer, c.googleClientId);
    } catch {
      throw new Fault(401, "Sign-in expired or invalid. Please sign in again.");
    }
    assert(
      t?.sub &&
        ["accounts.google.com", "https://accounts.google.com"].includes(
          t.iss,
        ) &&
        t.aud === c.googleClientId &&
        t.exp > Date.now() / 1000 &&
        t.email_verified === true &&
        t.hd === "stmarobotics.org" &&
        t.email?.toLowerCase().endsWith("@stmarobotics.org"),
      "A verified stmarobotics.org Google identity is required.",
      401,
    );
    sub = t.sub;
  } else {
    const cookie = cookieValue(headers, sessionCookieName(c.local));
    assert(cookie, "Sign in with your robotics Google account.", 401);
    const session = await db.get(key(`SESSION#${hash(cookie)}`));
    assert(
      session?.sub && session.expiresAt > new Date().toISOString(),
      "Your sign-in expired. Please sign in again.",
      401,
    );
    sub = session.sub;
  }
  const identity = await db.get(key(`IDENTITY#${sub}`));
  assert(
    identity?.enabled,
    "Your identity is disabled or awaiting administrator setup.",
    403,
  );
  if (
    identity.roles?.some((r: string) =>
      ["student", "stats:student"].includes(r),
    )
  )
    assert(
      identity.memberId,
      "Your identity needs an administrator-approved member link.",
      403,
    );
  if (identity.memberId) {
    const m = await db.get(key(`MEMBER#${identity.memberId}`));
    assert(m?.active, "Your member account is inactive.", 403);
  }
  return {
    kind: "human",
    id: sub,
    roles: identity.roles || [],
    memberId: identity.memberId,
  };
}
export async function device(
  headers: Record<string, string | undefined>,
  db: Store,
): Promise<Principal> {
  const cookie = headers.cookie
    ?.split(";")
    .map((x) => x.trim())
    .find((x) => x.startsWith("__Host-puncher-device="))
    ?.slice("__Host-puncher-device=".length);
  const localCookie = headers.cookie
    ?.split(";")
    .map((x) => x.trim())
    .find((x) => x.startsWith("puncher-local-device="))
    ?.slice("puncher-local-device=".length);
  const token =
    headers["x-device-token"] ||
    cookie ||
    (runtime().local ? localCookie : undefined);
  assert(token, "Kiosk needs adult device setup.", 401);
  const [id, secret] = token.split(".");
  assert(id && secret, "Invalid device credential.", 401);
  const d = await db.get(key(`DEVICE#${id}`));
  const actual = Buffer.from(hash(secret)),
    expected = Buffer.from(d?.secretHash || "");
  assert(
    d?.enabled &&
      expected.length === actual.length &&
      timingSafeEqual(expected, actual) &&
      d.expiresAt > new Date().toISOString(),
    "Kiosk authorization expired or was revoked. Ask an adult.",
    401,
  );
  return { kind: "device", id, roles: [] };
}
// API Gateway invokes separate authorizers. Integrations also recheck persisted permissions on every request.
export async function humanAuthorizer(event: any) {
  try {
    const p = await human(event.headers || {}, store());
    return { isAuthorized: true, context: { principalId: p.id } };
  } catch {
    return { isAuthorized: false };
  }
}
export async function deviceAuthorizer(event: any) {
  try {
    const p = await device(event.headers || {}, store());
    return { isAuthorized: true, context: { principalId: p.id } };
  } catch {
    return { isAuthorized: false };
  }
}
