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
  let verifiedEmail: string | undefined, verifiedName: string | undefined;
  let rosterEmail: string | undefined, rosterMemberId: string | undefined;
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
    verifiedEmail = t.email!.toLowerCase();
    verifiedName =
      typeof t.name === "string" ? t.name.slice(0, 100) : verifiedEmail;
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
    rosterEmail = session.rosterEmail;
    rosterMemberId = session.rosterMemberId;
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
    !identity || identity.enabled,
    "Your Puncher access is disabled.",
    403,
  );
  if (!identity?.roles?.some((r: string) => ["mentor", "admin"].includes(r))) {
    if (
      identity?.memberId &&
      identity.roles?.some((r: string) =>
        ["student", "stats:student"].includes(r),
      )
    ) {
      const member = await db.get(key("MEMBER#" + identity.memberId));
      assert(
        member?.active && member.memberKind === "student",
        "Your member account is inactive.",
        403,
      );
      return {
        kind: "human",
        id: sub,
        roles: ["student"],
        memberId: member.memberId,
      };
    }
    const email = verifiedEmail ?? rosterEmail;
    assert(email, "Your account is awaiting administrator setup.", 403);
    const claimKey = key("ROSTER_EMAIL#" + hash(email));
    const claim = await db.get(claimKey);
    assert(
      claim &&
        !claim.retired &&
        (!rosterMemberId || rosterMemberId === claim.memberId),
      "Your account is awaiting administrator setup. Ask a mentor to check the roster.",
      403,
    );
    const memberId = claim.memberId as string;
    const memberKey = key("MEMBER#" + memberId),
      loginKey = key("ROSTER_LOGIN#" + memberId),
      bindingKey = key("BINDING#" + memberId);
    if (verifiedEmail) {
      // The CSV suggests a match. Pin the first verified Google subject so
      // a later reassignment of that email cannot inherit this member's card.
      await atomic(db, async (tx) => {
        const current = await tx.get(claimKey),
          member = await tx.get(memberKey);
        const login = await tx.get(loginKey),
          binding = await tx.get(bindingKey);
        assert(
          current?.memberId === memberId &&
            !current.retired &&
            member?.active &&
            member.memberKind === "student" &&
            member.csvEmail === email,
          "Your member account is inactive or changed.",
          403,
        );
        const currentIdentity = await tx.get(key("IDENTITY#" + sub));
        assert(
          (!login || login.sub === sub) &&
            (!binding || binding.googleSub === sub) &&
            (!member.directoryUserId || member.directoryUserId === sub) &&
            (!currentIdentity ||
              (currentIdentity.enabled &&
                (!currentIdentity.memberId ||
                  currentIdentity.memberId === memberId))),
          "Ask a mentor to review your account link.",
          403,
        );
        if (!login) await tx.put(row(loginKey.pk, loginKey.sk, { sub }));
      });
    } else {
      const [member, login, binding] = await Promise.all([
        db.get(memberKey),
        db.get(loginKey),
        db.get(bindingKey),
      ]);
      assert(
        member?.active &&
          member.memberKind === "student" &&
          member.csvEmail === email &&
          login?.sub === sub &&
          (!binding || binding.googleSub === sub) &&
          (!member.directoryUserId || member.directoryUserId === sub),
        "Your member account is inactive or changed.",
        403,
      );
    }
    return {
      kind: "human",
      id: sub,
      roles: ["student"],
      memberId,
      rosterEmail: email,
    };
  }
  assert(identity, "Your account is awaiting administrator setup.", 403);
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
  assert(token, "Scan a mentor's kiosk activation code.", 401);
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
    const p = await human(
      {
        ...event.headers,
        cookie: event.cookies?.join("; ") || event.headers?.cookie,
      },
      store(),
    );
    const allowed =
      p.roles.includes("mentor") ||
      p.roles.includes("admin") ||
      event.routeKey?.endsWith(" /api/me");
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
