import { OAuth2Client, type TokenPayload } from "google-auth-library";
import { timingSafeEqual } from "node:crypto";
import { type Store } from "./store";
import {
  type Human,
  type Principal,
  key,
  hash,
  assert,
  Fault,
  kioskExpiry,
  roles,
  staffsShop,
} from "./model";
import { runtime, store } from "./runtime";
export type Verify = (
  token: string,
  audience: string,
) => Promise<TokenPayload | undefined>;
const google = new OAuth2Client();
export const verifyGoogle: Verify = async (token, audience) =>
  (await google.verifyIdToken({ idToken: token, audience })).getPayload();

export function assertGoogleIdentity(
  payload: TokenPayload | undefined,
  audience: string,
): asserts payload is TokenPayload & { email: string } {
  assert(
    payload?.sub &&
      ["accounts.google.com", "https://accounts.google.com"].includes(
        payload.iss,
      ) &&
      payload.aud === audience &&
      payload.exp > Date.now() / 1000 &&
      payload.email_verified === true &&
      payload.hd === "stmarobotics.org" &&
      payload.email?.toLowerCase().endsWith("@stmarobotics.org"),
    "A verified stmarobotics.org Google identity is required.",
    401,
  );
}

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
): Promise<Human> {
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
    assertGoogleIdentity(t, c.googleClientId);
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
  const user = await db.get(key("USER#" + sub));
  assert(user, "Sign in with Google to create your Puncher account.", 403);
  assert(
    user.active && roles.includes(user.role),
    "Your Puncher access is disabled.",
    403,
  );
  return { kind: "human", id: sub, role: user.role, barcode: user.barcode };
}
export async function device(
  headers: Record<string, string | undefined>,
  db: Store,
): Promise<Extract<Principal, { kind: "device" }>> {
  const token = kioskCredential(headers);
  assert(token, "Scan a mentor's kiosk activation code.", 401);
  const [id, secret] = token.split(".");
  assert(
    id && secret && id.length <= 100 && secret.length <= 200,
    "Invalid kiosk session.",
    401,
  );
  const d = await db.get(key(`DEVICE#${id}`));
  const expiresAt = d && kioskExpiry(d.launchedAt, d.expiresAt);
  const actual = Buffer.from(hash(secret)),
    expected = Buffer.from(d?.secretHash || "");
  assert(
    d?.enabled &&
      d.sessionType === "mentor-launch" &&
      d.launchedBy &&
      expected.length === actual.length &&
      timingSafeEqual(expected, actual) &&
      expiresAt &&
      expiresAt > new Date().toISOString(),
    "Kiosk session expired or was ended. Ask a mentor to launch it again.",
    401,
  );
  const owner = await db.get(key("USER#" + d.launchedBy));
  assert(
    owner?.active && staffsShop(owner.role),
    "The mentor who launched this kiosk no longer has access.",
    401,
  );
  return { kind: "device", id, expiresAt };
}
export function kioskCredential(headers: Record<string, string | undefined>) {
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
  return (
    headers["x-device-token"] ||
    cookie ||
    (runtime().local ? localCookie : undefined)
  );
}
// API Gateway invokes separate authorizers. Integrations also recheck persisted permissions on every request.
export async function humanAuthorizer(event: any) {
  try {
    const p = await human(
      {
        ...event.headers,
        cookie: event.cookies?.join("; ") || event.headers?.cookie,
      },
      store(),
    );
    const allowed =
      staffsShop(p.role) ||
      event.routeKey?.endsWith(" /api/me") ||
      event.routeKey?.endsWith(" /api/wallet/save");
    return { isAuthorized: !!allowed, context: { principalId: p.id } };
  } catch {
    return { isAuthorized: false };
  }
}
export async function deviceAuthorizer(event: any) {
  try {
    const p = await device(
      {
        ...event.headers,
        cookie: event.cookies?.join("; ") || event.headers?.cookie,
      },
      store(),
    );
    return { isAuthorized: true, context: { principalId: p.id } };
  } catch {
    return { isAuthorized: false };
  }
}
