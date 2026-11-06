import { Puncher } from "./domain";
import { shopTotals } from "./shop-totals";
import {
  human,
  device,
  kioskCredential,
  cookieValue,
  sessionCookieName,
} from "./auth";
import { store, runtime, publicConfig } from "./runtime";
import { all, atomic, type Store } from "./store";
import {
  Fault,
  assert,
  admin,
  mentor,
  owns,
  key,
  hash,
  kioskExpiry,
  SCHEMA_VERSION,
} from "./model";
import {
  beginGoogleSignIn,
  endSession,
  finishGoogleSignIn,
  clearedSessionCookies,
} from "./session";
export type Request = {
  method: string;
  path: string;
  headers: Record<string, string | undefined>;
  body?: any;
  query?: Record<string, string | undefined>;
};
const response = (
  statusCode: number,
  body: any,
  headers: Record<string, string | string[]> = {},
) => ({
  statusCode,
  headers: {
    "content-type": "application/json",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...headers,
  } as Record<string, string | string[]>,
  body: JSON.stringify(body),
});
export async function dispatch(req: Request, db: Store = store()) {
  try {
    const c = runtime();
    const cooldown = Number(process.env.SCAN_COOLDOWN_SECONDS || 5);
    assert(
      Number.isFinite(cooldown) && cooldown >= 1 && cooldown <= 60,
      "Invalid scan cooldown configuration.",
      500,
    );
    const app = new Puncher(db, () => new Date(), cooldown);
    const { method, path, headers } = req;
    if (process.env.API_SCOPE === "kiosk")
      assert(
        (path.startsWith("/api/kiosk/") && path !== "/api/kiosk/activate") ||
          path === "/api/health",
        "Device route unavailable.",
        403,
      );
    if (process.env.API_SCOPE === "staff")
      assert(
        !path.startsWith("/api/kiosk/") || path === "/api/kiosk/activate",
        "Mentor credentials do not authorize kiosk routes.",
        403,
      );
    const b = req.body || {};
    const cookieName = c.local
      ? "puncher-local-device"
      : "__Host-puncher-device";
    const kioskCookie = (value: string, maxAge: number) =>
      `${cookieName}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${c.local ? "" : "; Secure"}`;
    if (method === "GET" && path === "/config.json")
      return response(200, publicConfig());
    if (method === "GET" && path === "/api/health") {
      const schema = await db.get(key("APP#PUNCHER", "SCHEMA"));
      assert(
        schema?.schemaVersion === SCHEMA_VERSION,
        "Unsupported or missing attendance schema. Run provisioning.",
        503,
      );
      return response(200, { status: "ok", schemaVersion: SCHEMA_VERSION });
    }
    if (method === "GET" && path === "/api/auth/login")
      return beginGoogleSignIn(db);
    if (method === "GET" && path === "/api/auth/callback")
      return finishGoogleSignIn(req.query || {}, headers, db);
    if (method !== "GET") {
      assert(
        headers.origin === c.origin,
        "Request origin is not allowed.",
        403,
      );
      assert(
        headers["content-type"]?.startsWith("application/json"),
        "JSON content type required.",
        415,
      );
    }
    if (method === "POST" && path === "/api/auth/logout")
      return endSession(headers, db);
    if (path === "/api/kiosk/setup" && method === "POST") {
      return response(410, {
        message: "Start the kiosk and scan a mentor's activation code.",
      });
    }
    if (path === "/api/kiosk/end" && method === "POST") {
      try {
        const p = await device(headers, db),
          token = kioskCredential(headers)!;
        await atomic(db, async (tx) => {
          const session = await tx.get(key("DEVICE#" + p.id));
          if (session?.secretHash === hash(token.split(".")[1])) {
            await tx.put({ ...session, enabled: false });
            await app.audit(tx, p, "kiosk.ended", p.id);
          }
        });
      } catch (error) {
        if (!(error instanceof Fault && [401, 403].includes(error.status)))
          throw error;
      }
      return response(
        200,
        { ended: true },
        { "set-cookie": kioskCookie("", 0) },
      );
    }
    if (path === "/api/kiosk/activate" && method === "POST") {
      const session = await app.activateKiosk(
        b.code,
        kioskCredential(headers),
        cookieValue(headers, sessionCookieName(c.local)),
      );
      return response(
        200,
        {
          ready: true,
          sessionId: session.sessionId,
          resumed: session.resumed,
          expiresAt: session.expiresAt,
        },
        {
          "set-cookie": [
            kioskCookie(session.credential, 30 * 86400),
            ...clearedSessionCookies(c.local),
          ],
        },
      );
    }
    if (path.startsWith("/api/kiosk/")) {
      const p = await device(headers, db);
      if (method === "GET" && path === "/api/kiosk/status")
        return response(200, {
          ready: true,
          sessionId: p.id,
          expiresAt: p.expiresAt,
          asOf: new Date().toISOString(),
        });
      if (method === "GET" && path === "/api/kiosk/totals")
        return response(200, await shopTotals(db, p));
      if (method === "GET" && path === "/api/kiosk/occupants")
        return response(200, await app.kioskOccupants(p));
      if (method === "POST" && path === "/api/kiosk/scan") {
        await atomic(db, (tx) => app.rate(tx, p));
        try {
          return response(200, await app.scan(p, b.barcode, b.operationId));
        } catch (error) {
          if (
            error instanceof Fault &&
            [400, 403, 404, 429].includes(error.status)
          )
            await atomic(db, (tx) =>
              app.audit(tx, p, "shop.rejected", "scan", {
                status: error.status,
              }),
            );
          throw error;
        }
      }
      const op = path.match(/^\/api\/kiosk\/operations\/([0-9a-f-]+)$/);
      if (op && method === "GET")
        return response(200, await app.operation(p, op[1]));
      if (op && method === "POST")
        return response(200, await app.acknowledge(p, op[1], b.warningId));
      throw new Fault(404, "Route not found.");
    }
    const p = await human(headers, db);
    if (path === "/api/me" && method === "GET")
      return response(200, { id: p.id, role: p.role, barcode: p.barcode });
    mentor(p);
    if (path === "/api/mentor/kiosk/activation" && method === "POST")
      return response(201, await app.issueKioskActivation(p));
    if (path === "/api/mentor/kiosks" && method === "GET")
      return response(
        200,
        (await all(db, "DEVICES", { index: "GSI1" }))
          .filter(
            (d) =>
              d.sessionType === "mentor-launch" &&
              (p.role === "ADMIN" || d.launchedBy === p.id),
          )
          .map(({ deviceId, label, enabled, expiresAt, launchedAt }) => ({
            sessionId: deviceId,
            label,
            enabled,
            expiresAt: kioskExpiry(launchedAt, expiresAt),
            launchedAt,
          })),
      );
    const sessionToEnd = path.match(/^\/api\/mentor\/kiosks\/([^/]+)$/);
    if (sessionToEnd && method === "DELETE")
      return response(200, await app.revokeDevice(p, sessionToEnd[1]));
    if (path === "/api/events" && method === "GET") {
      mentor(p);
      const es = await all(db, "EVENTS", { index: "GSI1" });
      return response(
        200,
        es
          .filter((e) => p.role === "ADMIN" || e.mentorSub === p.id)
          .map(
            ({
              eventId,
              title,
              eventDate,
              durationSeconds,
              notes,
              participantCount,
              version,
            }) => ({
              eventId,
              title,
              eventDate,
              durationSeconds,
              notes,
              participantCount,
              version,
            }),
          ),
      );
    }
    if (path === "/api/events" && method === "POST")
      return response(201, await app.saveEvent(p, b));
    const event = path.match(
      /^\/api\/events\/([^/]+)(?:\/(participants|scan))?(?:\/([^/]+))?$/,
    );
    if (event) {
      const id = event[1];
      if (!event[2] && method === "PATCH")
        return response(200, await app.saveEvent(p, b, id));
      if (event[2] === "scan" && method === "POST")
        return response(200, await app.award(p, id, b.barcode));
      if (event[2] === "participants") {
        const e = await db.get(key(`EVENT#${id}`));
        assert(e, "Event not found.", 404);
        owns(p, e);
        if (method === "DELETE" && event[3])
          return response(
            200,
            await app.removeAward(p, id, event[3], b.reason),
          );
        if (method === "GET")
          return response(
            200,
            (await all(db, e.pk, { prefix: "PARTICIPANT#" })).map(
              ({ memberId, displayName, creditedSeconds, recordedAt }) => ({
                memberId,
                displayName,
                creditedSeconds,
                recordedAt,
              }),
            ),
          );
      }
    }
    admin(p);
    if (path === "/api/admin/members" && method === "GET")
      return response(
        200,
        (await all(db, "USERS", { index: "GSI1" })).map(
          ({ memberId, displayName, email, active, role, barcode, v }) => ({
            memberId,
            displayName,
            email,
            active,
            role,
            barcode,
            version: v,
          }),
        ),
      );
    const member = path.match(
      /^\/api\/admin\/members\/([^/]+)(?:\/(replace-card))?$/,
    );
    if (member && method === "PATCH" && !member[2])
      return response(200, await app.updateMember(p, member[1], b));
    if (member?.[2] && method === "POST")
      return response(200, await app.replaceCard(p, member[1], b.operationId));
    if (path === "/api/admin/active" && method === "GET")
      return response(200, await app.roster(p));
    if (path === "/api/admin/devices" && method === "POST")
      return response(410, {
        message: "Use Launch kiosk from the mentor dashboard.",
      });
    if (path === "/api/admin/devices" && method === "GET")
      return response(
        200,
        (await all(db, "DEVICES", { index: "GSI1" })).map(
          ({ deviceId, label, enabled, expiresAt }) => ({
            deviceId,
            label,
            enabled,
            expiresAt,
          }),
        ),
      );
    const dev = path.match(/^\/api\/admin\/devices\/([^/]+)$/);
    if (dev && method === "DELETE")
      return response(200, await app.revokeDevice(p, dev[1]));
    if (path === "/api/admin/review" && method === "POST")
      return response(200, await app.review(p, b));
    if (
      method === "GET" &&
      ["/api/admin/audit", "/api/admin/review"].includes(path)
    ) {
      let cursor;
      try {
        cursor = req.query?.cursor
          ? JSON.parse(Buffer.from(req.query.cursor, "base64url").toString())
          : undefined;
      } catch {
        throw new Fault(400, "Invalid pagination cursor.");
      }
      const page = await db.query(
        path.endsWith("audit") ? "AUDIT" : "REVIEWS",
        { cursor, limit: 50, reverse: path.endsWith("audit") },
      );
      return response(200, {
        items: page.items.map(({ pk, sk, v, schemaVersion, ...safe }) => safe),
        cursor: page.cursor
          ? Buffer.from(JSON.stringify(page.cursor)).toString("base64url")
          : undefined,
      });
    }
    throw new Fault(404, "Route not found.");
  } catch (e) {
    if (e instanceof Fault) return response(e.status, { message: e.message });
    console.error(
      JSON.stringify({
        event: "request.failure",
        errorType: e instanceof Error ? e.name : "unknown",
      }),
    );
    return response(500, {
      message: req.path.startsWith("/api/auth/")
        ? "Sign-in is temporarily unavailable. Please try again."
        : "Unable to confirm a saved result. Retry the same operation.",
    });
  }
}
export async function handler(event: any) {
  let body;
  try {
    body = event.body ? JSON.parse(event.body) : undefined;
  } catch {
    return response(400, { message: "Invalid JSON." });
  }
  const result = await dispatch({
    method: event.requestContext.http.method,
    path: event.rawPath,
    headers: {
      ...event.headers,
      cookie: event.cookies?.join("; ") || event.headers?.cookie,
    },
    query: event.queryStringParameters,
    body,
  });
  const cookie = result.headers["set-cookie"];
  if (cookie) {
    delete result.headers["set-cookie"];
    return {
      ...result,
      cookies: Array.isArray(cookie) ? cookie : [cookie],
    };
  }
  return result;
}
