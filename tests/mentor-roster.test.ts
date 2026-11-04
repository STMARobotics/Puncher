import { afterEach, expect, it } from "vitest";
import { MemoryStore, atomic, all } from "../service/store";
import { key, row, uid } from "../service/model";
import { Puncher } from "../service/domain";
import { assignCard } from "../service/card-codes";
import {
  startRosterSync,
  runRosterSync,
  rosterStatus,
  pendingRoster,
  linkRosterMember,
  type DirectoryPerson,
} from "../service/roster";
import { dispatch } from "../service/api";
import { human, device as authenticateKiosk } from "../service/auth";
import { fixture, admin, mentor } from "./helpers";

const original = { ...process.env };
afterEach(() => {
  process.env = { ...original };
});
function env() {
  Object.assign(process.env, {
    APP_ENV: "local",
    TABLE_NAME: "mentor-test",
    DYNAMODB_ENDPOINT: "http://127.0.0.1:8766",
    LOCAL_AUTH_FIXTURES: "true",
    ALLOWED_ORIGIN: "http://localhost:5173",
    GOOGLE_CLIENT_ID: "test-client",
  });
}
const headers = (token = "local-mentor") => ({
  authorization: "Bearer " + token,
  origin: "http://localhost:5173",
  "content-type": "application/json",
});
const person = (id: string, active = true): DirectoryPerson => ({
  id,
  active,
  displayName: "Member " + id,
  email: id + "@stmarobotics.org",
});
async function empty() {
  const db = new MemoryStore({ orgId: "example-team" });
  await atomic(db, async (tx) => {
    for (const p of [admin, mentor])
      await tx.put(
        row("IDENTITY#" + p.id, "METADATA", { enabled: true, roles: p.roles }),
      );
  });
  return db;
}
async function sync(db: MemoryStore, users: DirectoryPerson[]) {
  const job = await startRosterSync(db, mentor, async () => {});
  await runRosterSync(db, job.jobId, async () => structuredClone(users));
  return rosterStatus(db);
}
it("provisions active directory members once with stable codes, without granting login or rewarding imports", async () => {
  const db = await empty();
  expect(
    (await sync(db, [person("one"), person("two"), person("suspended", false)]))
      .status,
  ).toBe("completed");
  const before = await all(db, "MEMBERS", { index: "GSI1" });
  expect(before).toHaveLength(2);
  expect(new Set(before.map((r) => r.barcode)).size).toBe(2);
  for (const r of before) {
    expect(r.barcode).toMatch(/^[1-9][0-9]{5}$/);
    expect(r.active).toBe(true);
  }
  expect(await db.get(key("IDENTITY#one"))).toBeUndefined();
  expect(
    [...db.rows.values()].filter((r) => r.recordType === "ACTIVITY_OUTBOX_V1"),
  ).toHaveLength(0);
  const renamed = {
    ...person("one"),
    displayName: "Changed Name",
    email: "renamed@stmarobotics.org",
  };
  await sync(db, [renamed, person("two")]);
  const after = await all(db, "MEMBERS", { index: "GSI1" });
  for (const r of after)
    expect(r.barcode).toBe(
      before.find((b) => b.memberId === r.memberId)?.barcode,
    );
  expect(after.find((r) => r.directoryUserId === "one")?.displayName).toBe(
    "Changed Name",
  );
});
it("preserves manual inactivity, follows confirmed suspensions and removals, and preserves history", async () => {
  const db = await empty();
  await sync(db, [person("one"), person("two")]);
  const member = (await all(db, "MEMBERS", { index: "GSI1" })).find(
    (r) => r.directoryUserId === "one",
  )!;
  await new Puncher(db).saveMember(
    mentor,
    { ...member, active: false },
    member.memberId,
  );
  await sync(db, [person("one"), person("two", false)]);
  expect((await db.get(key(member.pk)))?.active).toBe(false);
  const two = (await all(db, "MEMBERS", { index: "GSI1" })).find(
    (r) => r.directoryUserId === "two",
  )!;
  expect(two.active).toBe(false);
  await sync(db, [person("one"), person("two")]);
  expect((await db.get(key(two.pk)))?.active).toBe(true);
  await sync(db, [person("one")]);
  expect((await db.get(key(two.pk)))?.active).toBe(false);
  expect((await db.get(key(two.pk)))?.barcode).toBe(two.barcode);
});
it("never deactivates members on a failed, malformed or empty directory response", async () => {
  const db = await empty();
  await sync(db, [person("one")]);
  for (const source of [
    async () => {
      throw Error("do not log this credential");
    },
    async () => [],
    async () => [person("one"), person("one")],
  ]) {
    const job = await startRosterSync(db, mentor, async () => {});
    await runRosterSync(db, job.jobId, source);
    expect((await rosterStatus(db)).status).toBe("failed");
    expect((await all(db, "MEMBERS", { index: "GSI1" }))[0].active).toBe(true);
  }
});
it("does not match names; explicit legacy linking preserves the original member, card and Google-independent hours", async () => {
  const { db, app, advance } = await fixture();
  await app.scan(
    { kind: "device", id: "test-device", roles: [] },
    "000123",
    uid(),
  );
  advance(60);
  await app.scan(
    { kind: "device", id: "test-device", roles: [] },
    "000123",
    uid(),
  );
  const before = await all(db, "MEMBER#member-a", { prefix: "SHOP#" });
  const job = await startRosterSync(db, mentor, async () => {});
  await runRosterSync(db, job.jobId, async () => [
    { ...person("google-one"), displayName: "Alex Example" },
  ]);
  expect(await pendingRoster(db)).toHaveLength(1);
  expect(await all(db, "MEMBERS", { index: "GSI1" })).toHaveLength(2);
  await linkRosterMember(db, mentor, "google-one", "member-a");
  expect((await db.get(key("MEMBER#member-a")))?.barcode).toBe("000123");
  expect(await all(db, "MEMBER#member-a", { prefix: "SHOP#" })).toEqual(before);
  expect(await pendingRoster(db)).toHaveLength(0);
});
it("uses an existing explicit identity binding but never grants mentor access to new roster members", async () => {
  const { db } = await fixture();
  await atomic(db, async (tx) => {
    await tx.put(
      row("IDENTITY#verified-account", "METADATA", {
        memberId: "member-a",
        enabled: true,
        roles: ["student", "stats:student"],
      }),
    );
  });
  const job = await startRosterSync(db, mentor, async () => {});
  await runRosterSync(db, job.jobId, async () => [person("verified-account")]);
  expect((await db.get(key("DIRECTORY#verified-account")))?.memberId).toBe(
    "member-a",
  );
  expect((await db.get(key("IDENTITY#verified-account")))?.roles).toEqual([
    "student",
    "stats:student",
  ]);
  await expect(
    new Puncher(db).saveIdentity(admin, {
      googleSub: "different-google-user",
      email: "different@stmarobotics.org",
      enabled: true,
      roles: ["stats:student"],
      memberId: "member-a",
    }),
  ).rejects.toThrow("Directory account");
});
it("deduplicates queued sync requests and ignores obsolete/duplicate worker deliveries", async () => {
  const db = await empty(),
    enqueued: string[] = [];
  const jobs = await Promise.all([
    startRosterSync(db, mentor, async (id) => {
      enqueued.push(id);
    }),
    startRosterSync(db, mentor, async (id) => {
      enqueued.push(id);
    }),
  ]);
  expect(jobs[0].jobId).toBe(jobs[1].jobId);
  expect(new Set(enqueued).size).toBe(1);
  await runRosterSync(db, "obsolete", async () => {
    throw Error("should not fetch");
  });
  await runRosterSync(db, jobs[0].jobId, async () => [person("one")]);
  await runRosterSync(db, jobs[0].jobId, async () => {
    throw Error("completed job should not refetch");
  });
  expect((await rosterStatus(db)).status).toBe("completed");
});
it("only one concurrent delivery can claim the roster job", async () => {
  const db = await empty(),
    job = await startRosterSync(db, mentor, async () => {});
  let calls = 0;
  await Promise.all(
    [1, 2].map(() =>
      runRosterSync(db, job.jobId, async () => {
        calls++;
        return [person("one")];
      }),
    ),
  );
  expect(calls).toBe(1);
  expect((await rosterStatus(db)).status).toBe("completed");
});
it("reserves retired codes permanently and collision-checks allocations", async () => {
  const db = await empty();
  await atomic(db, async (tx) => {
    await assignCard(tx, "old-member", "123456");
    await tx.del(key("CARD#123456"));
  });
  let attempt = 0;
  const code = await atomic(db, (tx) =>
    assignCard(tx, "different-member", undefined, () =>
      ++attempt === 1 ? "123456" : "234567",
    ),
  );
  expect(code).toBe("234567");
  expect((await db.get(key("CARDCODE#123456")))?.memberId).toBe("old-member");
});
it("retries a replacement once and never randomly reactivates a retired code for the same member", async () => {
  const { app, db } = await fixture();
  const id = uid();
  const results = await Promise.all([
    app.replaceCard(mentor, "member-a", id),
    app.replaceCard(mentor, "member-a", id),
  ]);
  expect(results[0]).toEqual(results[1]);
  expect(results[0].barcode).not.toBe("000123");
  let calls = 0;
  expect(
    await atomic(db, (tx) =>
      assignCard(tx, "member-a", undefined, () =>
        ++calls === 1 ? "000123" : "654321",
      ),
    ),
  ).toBe("654321");
});
it("mentor approval preserves existing Stats access and member linkage", async () => {
  const { db } = await fixture();
  await atomic(db, async (tx) => {
    await tx.put(
      row("IDENTITY#existing-student", "METADATA", {
        memberId: "member-a",
        roles: ["stats:student"],
        enabled: true,
      }),
    );
    await tx.put(
      row("MENTOR_REQUEST#existing-student", "METADATA", {
        email: "existing@stmarobotics.org",
        ttl: Math.floor(Date.now() / 1000) + 600,
      }),
    );
  });
  await new Puncher(db).approveMentor(admin, "existing-student", false, false);
  expect(await db.get(key("IDENTITY#existing-student"))).toMatchObject({
    memberId: "member-a",
    roles: ["stats:student", "mentor"],
    enabled: true,
  });
});
it("allows mentors to manage basic members but not permissions, and denies student Puncher sign-in", async () => {
  env();
  const { db } = await fixture();
  await atomic(db, async (tx) => {
    await tx.put(
      row("IDENTITY#local-student", "METADATA", {
        enabled: true,
        roles: ["student", "stats:student"],
        memberId: "member-a",
      }),
    );
  });
  expect(
    (
      await dispatch(
        { method: "GET", path: "/api/me", headers: headers("local-student") },
        db,
      )
    ).statusCode,
  ).toBe(403);
  expect(
    (
      await dispatch(
        { method: "GET", path: "/api/mentor/members", headers: headers() },
        db,
      )
    ).statusCode,
  ).toBe(200);
  expect(
    (
      await dispatch(
        { method: "GET", path: "/api/admin/identities", headers: headers() },
        db,
      )
    ).statusCode,
  ).toBe(403);
  expect(
    (
      await dispatch(
        { method: "POST", path: "/api/mentor/roster/sync", headers: headers() },
        db,
      )
    ).statusCode,
  ).toBe(503);
});
it("captures verified mentor access requests without granting permissions; only an administrator approves", async () => {
  env();
  process.env.LOCAL_AUTH_FIXTURES = "false";
  const { db } = await fixture();
  const payload: any = {
    sub: "new-mentor",
    name: "New Mentor",
    email: "newmentor@stmarobotics.org",
    iss: "accounts.google.com",
    hd: "stmarobotics.org",
    aud: "test-client",
    email_verified: true,
    exp: Date.now() / 1000 + 300,
  };
  await expect(
    human({ authorization: "Bearer verified" }, db, async () => payload),
  ).rejects.toThrow("setup");
  expect(await db.get(key("IDENTITY#new-mentor"))).toBeUndefined();
  expect((await db.get(key("MENTOR_REQUEST#new-mentor")))?.email).toBe(
    payload.email,
  );
  process.env.LOCAL_AUTH_FIXTURES = "true";
  expect(
    (
      await dispatch(
        {
          method: "POST",
          path: "/api/admin/mentor-requests/new-mentor/approve",
          headers: headers(),
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
          method: "POST",
          path: "/api/admin/mentor-requests/new-mentor/approve",
          headers: headers("local-admin"),
          body: {},
        },
        db,
      )
    ).statusCode,
  ).toBe(200);
  expect(
    (await human({ authorization: "Bearer verified" }, db, async () => payload))
      .roles,
  ).toEqual(["mentor"]);
});
it("launches an isolated kiosk via mentor login, renews the same retry identity, rotates its secret and ends access", async () => {
  env();
  const { db } = await fixture();
  const first = await dispatch(
    {
      method: "POST",
      path: "/api/mentor/kiosk/launch",
      headers: headers(),
      body: {},
    },
    db,
  );
  expect(first.statusCode).toBe(200);
  expect([first.headers["set-cookie"]].flat().join(";")).toContain("HttpOnly");
  expect(first.body).not.toContain("credential");
  const cookie = [first.headers["set-cookie"]]
      .flat()
      .find((value) => value.startsWith("puncher-local-device="))!
      .split(";")[0],
    session = JSON.parse(first.body),
    op = uid();
  const scan = () =>
    dispatch(
      {
        method: "POST",
        path: "/api/kiosk/scan",
        headers: { ...headers(), cookie },
        body: { barcode: "000123", operationId: op },
      },
      db,
    );
  expect(JSON.parse((await scan()).body).state).toBe("in");
  const renewed = await dispatch(
    {
      method: "POST",
      path: "/api/mentor/kiosk/launch",
      headers: { ...headers(), cookie },
      body: {},
    },
    db,
  );
  expect(JSON.parse(renewed.body).sessionId).toBe(session.sessionId);
  expect(JSON.parse(renewed.body).resumed).toBe(true);
  const nextCookie = [renewed.headers["set-cookie"]]
    .flat()
    .find((value) => value.startsWith("puncher-local-device="))!
    .split(";")[0];
  await expect(authenticateKiosk({ cookie }, db)).rejects.toThrow();
  const retry = await dispatch(
    {
      method: "POST",
      path: "/api/kiosk/scan",
      headers: { ...headers(), cookie: nextCookie },
      body: { barcode: "000123", operationId: op },
    },
    db,
  );
  expect(JSON.parse(retry.body).state).toBe("in");
  expect(await all(db, "MEMBER#member-a", { prefix: "SHOP#" })).toHaveLength(1);
  expect(
    (
      await dispatch(
        {
          method: "GET",
          path: "/api/mentor/members",
          headers: { cookie: nextCookie },
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
          path: "/api/kiosk/setup",
          headers: headers(),
          body: {},
        },
        db,
      )
    ).statusCode,
  ).toBe(410);
  expect(
    (
      await dispatch(
        {
          method: "POST",
          path: "/api/kiosk/end",
          headers: { ...headers(), cookie: nextCookie },
          body: {},
        },
        db,
      )
    ).statusCode,
  ).toBe(200);
  await expect(authenticateKiosk({ cookie: nextCookie }, db)).rejects.toThrow();
});
it("immediately rejects kiosk sessions whose launching mentor loses access", async () => {
  env();
  const { db } = await fixture();
  const launch = await dispatch(
    {
      method: "POST",
      path: "/api/mentor/kiosk/launch",
      headers: headers(),
      body: {},
    },
    db,
  );
  const cookie = [launch.headers["set-cookie"]]
    .flat()
    .find((value) => value.startsWith("puncher-local-device="))!
    .split(";")[0];
  await atomic(db, async (tx) => {
    const r = await tx.get(key("IDENTITY#local-mentor"));
    await tx.put({ ...r!, roles: [] });
  });
  await expect(authenticateKiosk({ cookie }, db)).rejects.toThrow("mentor");
});
