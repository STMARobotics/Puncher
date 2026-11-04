import { OAuth2Client, type TokenPayload } from "google-auth-library";
import { timingSafeEqual } from "node:crypto";
import { type Store } from "./store";
import { type Principal, key, hash, assert, Fault } from "./model";
import { runtime, store } from "./runtime";
import { atomic } from "./store";
import { row } from "./model";
export type Verify = (
  token: string,
  audience: string,
) => Promise<TokenPayload | undefined>;
const google = new OAuth2Client();
export const verifyGoogle: Verify = async (token, audience) =>
  (await google.verifyIdToken({ idToken: token, audience })).getPayload();
export async function human(
  headers: Record<string, string | undefined>,
  db: Store,
  verify: Verify = verifyGoogle,
): Promise<Principal> {
  const c = runtime();
  const bearer = headers.authorization?.match(/^Bearer (\S+)$/)?.[1];
  assert(bearer, "Sign in with your robotics Google account.", 401);
  let sub: string;
  let verifiedEmail: string | undefined, verifiedName: string | undefined;
  if (
    c.fixtures &&
    ["local-admin", "local-mentor", "local-student"].includes(bearer)
  )
    sub = bearer;
  else {
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
    verifiedEmail = t.email!.toLowerCase();
    verifiedName =
      typeof t.name === "string" ? t.name.slice(0, 100) : verifiedEmail;
  }
  const identity = await db.get(key(`IDENTITY#${sub}`));
  if (
    verifiedEmail &&
    (!identity?.enabled ||
      !identity.roles?.some((r: string) => ["mentor", "admin"].includes(r)))
  ) {
    await atomic(db, async (tx) => {
      const k = key("MENTOR_REQUEST#" + sub);
      const request = await tx.get(k);
      if (!request || request.ttl <= Date.now() / 1000)
        await tx.put(
          row(k.pk, k.sk, {
            googleSub: sub,
            email: verifiedEmail,
            displayName: verifiedName,
            requestedAt: new Date().toISOString(),
            ttl: Math.floor(Date.now() / 1000) + 30 * 86400,
            gsi1pk: "MENTOR_REQUESTS",
            gsi1sk: sub,
          }),
        );
    });
  }
  assert(
    identity?.enabled,
    "Your mentor access is disabled or awaiting administrator setup.",
    403,
  );
  assert(
    identity.roles?.some((r: string) => ["mentor", "admin"].includes(r)),
    "Puncher sign-in is available to mentors only.",
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
  const token = kioskCredential(headers);
  assert(token, "A mentor must log in and launch this kiosk.", 401);
  const [id, secret] = token.split(".");
  assert(
    id && secret && id.length <= 100 && secret.length <= 200,
    "Invalid kiosk session.",
    401,
  );
  const d = await db.get(key(`DEVICE#${id}`));
  const actual = Buffer.from(hash(secret)),
    expected = Buffer.from(d?.secretHash || "");
  assert(
    d?.enabled &&
      d.sessionType === "mentor-launch" &&
      d.launchedBy &&
      expected.length === actual.length &&
      timingSafeEqual(expected, actual) &&
      d.expiresAt > new Date().toISOString(),
    "Kiosk session expired or was ended. Ask a mentor to launch it again.",
    401,
  );
  const owner = await db.get(key("IDENTITY#" + d.launchedBy));
  assert(
    owner?.enabled &&
      owner.roles?.some((r: string) => ["mentor", "admin"].includes(r)),
    "The mentor who launched this kiosk no longer has access.",
    401,
  );
  if (owner.memberId)
    assert(
      (await db.get(key("MEMBER#" + owner.memberId)))?.active,
      "Mentor account is inactive.",
      401,
    );
  return { kind: "device", id, roles: [] };
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
