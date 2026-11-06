import { test, after } from "node:test";
import assert from "node:assert/strict";
import {
  DynamoDBClient,
  CreateTableCommand,
  DeleteTableCommand,
} from "@aws-sdk/client-dynamodb";
import { DynamoStore, all } from "../service/store";
import { fixture, seedUser, device, admin, mentor } from "./helpers";
import { uid, eligible, key, hash } from "../service/model";
import { row } from "../service/model";
import { atomic } from "../service/store";
import { shopTotals } from "../service/shop-totals";
import { assignCard } from "../service/card-codes";
import { registerUser } from "../service/users";
const endpoint = process.env.DYNAMODB_ENDPOINT || "http://127.0.0.1:8000";
assert.ok(["localhost", "127.0.0.1"].includes(new URL(endpoint).hostname));
const client = new DynamoDBClient({
    endpoint,
    region: "us-east-2",
    credentials: { accessKeyId: "local", secretAccessKey: "local" },
  }),
  tables: string[] = [];
async function setup(integration?: { orgId: string }) {
  const table = `puncher-test-${uid()}`;
  tables.push(table);
  await client.send(
    new CreateTableCommand({
      TableName: table,
      BillingMode: "PAY_PER_REQUEST",
      AttributeDefinitions: ["pk", "sk", "gsi1pk", "gsi1sk"].map(
        (AttributeName) => ({ AttributeName, AttributeType: "S" }),
      ),
      KeySchema: [
        { AttributeName: "pk", KeyType: "HASH" },
        { AttributeName: "sk", KeyType: "RANGE" },
      ],
      GlobalSecondaryIndexes: [
        {
          IndexName: "GSI1",
          KeySchema: [
            { AttributeName: "gsi1pk", KeyType: "HASH" },
            { AttributeName: "gsi1sk", KeyType: "RANGE" },
          ],
          Projection: { ProjectionType: "ALL" },
        },
      ],
    }),
  );
  return fixture(new DynamoStore(table, endpoint, integration));
}
after(async () => {
  for (const TableName of tables)
    await client.send(new DeleteTableCommand({ TableName: TableName }));
  client.destroy();
});

test("mentor session revocation commits with kiosk launch on real DynamoDB", async () => {
  const { db, app } = await setup();
  const token = "synthetic-browser-session",
    k = key("SESSION#" + hash(token));
  await atomic(db, (tx) =>
    tx.put(
      row(k.pk, k.sk, {
        sub: mentor.id,
        expiresAt: "2099-01-01T00:00:00.000Z",
      }),
    ),
  );
  const issued = await app.issueKioskActivation(mentor);
  const launched = await app.activateKiosk(issued.code, undefined, token);
  await assert.rejects(
    app.activateKiosk(issued.code),
    /expired or was already used/,
  );
  assert.equal(await db.get(k), undefined);
  assert.equal(
    (await db.get(key("DEVICE#" + launched.sessionId)))?.sessionType,
    "mentor-launch",
  );
  // A failed launch cannot consume the browser session before a kiosk exists.
  await atomic(db, (tx) =>
    tx.put(
      row(k.pk, k.sk, {
        sub: mentor.id,
        expiresAt: "2099-01-01T00:00:00.000Z",
      }),
    ),
  );
  await assert.rejects(app.launchKiosk(mentor, undefined, "", token));
  assert.ok(await db.get(k));
});

test("real DynamoDB preserves a member visit through a cross-kiosk shop closure", async () => {
  const { app, db, advance, openShop } = await setup();
  const opening = await openShop();
  const secondKiosk = {
    kind: "device" as const,
    id: opening.sessionId,
  };
  await app.scan(device, "000123", uid());
  advance(60);
  const before = await db.get(key("ATTENDANCE#member-a", "CURRENT"));
  await app.scan(secondKiosk, opening.barcode, uid());
  assert.equal((await app.kioskOccupants(device)).shopOpen, false);
  assert.deepEqual(await db.get(key("ATTENDANCE#member-a", "CURRENT")), before);
  advance(120);
  await assert.rejects(app.scan(device, "000456", uid()), /Shop closed/);
  assert.equal((await app.scan(device, "000123", uid())).creditedSeconds, 60);
});

test("concurrent first sign-ins create one Student and one card on real DynamoDB", async () => {
  const { db } = await setup();
  const profile = {
    sub: "new-google-sub",
    email: "new@stmarobotics.org",
    name: "New Member",
  };
  const users = await Promise.all(
    Array.from({ length: 5 }, () => registerUser(db, profile)),
  );
  assert.equal(new Set(users.map((user) => user.barcode)).size, 1);
  const user = await db.get(key("USER#" + profile.sub));
  assert.equal(user?.role, "STUDENT");
  assert.equal(
    (await db.get(key("CARD#" + user?.barcode)))?.memberId,
    profile.sub,
  );
});

test("card replacement preserves canonical attendance on real DynamoDB", async () => {
  const { db, app, advance } = await setup();
  await app.scan(device, "000123", uid());
  advance(60);
  await app.scan(device, "000123", uid());
  const hours = await all(db, "ATTENDANCE#member-a", { prefix: "SHOP#" });
  const operationId = uid();
  const replacements = await Promise.all([
    app.replaceCard(admin, "member-a", operationId),
    app.replaceCard(admin, "member-a", operationId),
  ]);
  assert.equal(replacements[0].barcode, replacements[1].barcode);
  assert.notEqual(replacements[0].barcode, "000123");
  assert.deepEqual(
    await all(db, "ATTENDANCE#member-a", { prefix: "SHOP#" }),
    hours,
  );
  const retired = await db.get(key("CARD#000123"));
  assert.equal(retired?.memberId, "member-a");
  assert.equal(retired?.retired, true);
  await assert.rejects(
    atomic(db, (tx) => assignCard(tx, "member-b", "000123")),
  );
});
test("concurrent code allocation retries collisions against real DynamoDB conditions", async () => {
  const { db } = await setup();
  const allocate = (id: string, fallback: string) => {
    let calls = 0;
    return atomic(db, (tx) =>
      assignCard(tx, id, undefined, () =>
        ++calls === 1 ? "654321" : fallback,
      ),
    );
  };
  const codes = await Promise.all([
    allocate("new-a", "654322"),
    allocate("new-b", "654323"),
  ]);
  assert.equal(new Set(codes).size, 2);
  for (const code of codes) assert.ok(await db.get(key("CARD#" + code)));
});
test("activity outbox commits once with checkout and voided volunteer credit on real DynamoDB", async () => {
  const { app, db, advance } = await setup({ orgId: "example-team" });
  const checkout = uid();
  await app.scan(device, "000123", uid());
  advance(3600);
  await Promise.all([
    app.scan(device, "000123", checkout),
    app.scan(device, "000123", checkout),
  ]);
  const event = await app.saveEvent(mentor, {
    title: "Synthetic outreach",
    eventDate: "2026-05-31",
    hours: "0.5",
  });
  await app.award(mentor, event.eventId, "000123");
  await app.removeAward(
    mentor,
    event.eventId,
    "member-a",
    "Synthetic correction",
  );
  const date = new Date().toISOString().slice(0, 10);
  const rows = await all(db, "OUTBOX#example-team#puncher#" + date);
  assert.equal(rows.length, 3);
  assert.equal(rows.filter((r) => r.shopSeconds === 3600).length, 1);
  assert.deepEqual(
    rows
      .filter(
        (r) =>
          r.volunteerSeconds !== 0 ||
          (r.entityVersion === 2 && r.shopSeconds === 0),
      )
      .map((r) => [r.entityVersion, r.volunteerSeconds])
      .sort(),
    [
      [1, 1800],
      [2, 0],
    ],
  );
});
test("real DynamoDB transactions: concurrent scans, durable retry and per-member cooldown", async () => {
  const { app, db, advance } = await setup();
  const id = uid();
  const rs = await Promise.all(
    Array.from({ length: 6 }, () => app.scan(device, "000123", id)),
  );
  assert.ok(rs.every((r) => r.state === "in"));
  assert.equal((await app.scan(device, "000456", uid())).state, "in");
  advance(60);
  assert.equal((await app.scan(device, "000123", id)).state, "in");
  assert.equal((await app.scan(device, "000123", uid())).creditedSeconds, 60);
  assert.equal(
    (await all(db, "ATTENDANCE#member-a", { prefix: "SHOP#" })).filter(eligible)
      .length,
    1,
  );
});
test("kiosk name display follows authoritative current sessions and midnight cutoff", async () => {
  const { app, advance, set } = await setup();
  await app.scan(device, "000123", uid());
  await app.scan(device, "000456", uid());
  assert.deepEqual((await app.kioskOccupants(device)).occupants, [
    { displayName: "Alex Example" },
    { displayName: "Jordan Sample" },
  ]);
  advance(6);
  await app.scan(device, "000123", uid());
  assert.deepEqual((await app.kioskOccupants(device)).occupants, [
    { displayName: "Jordan Sample" },
  ]);
  set("2026-06-01T05:00:00.000Z");
  assert.deepEqual((await app.kioskOccupants(device)).occupants, []);
});
test("aggregate shop totals use real paginated canonical queries and a durable refresh lease", async () => {
  const { db, app, advance } = await setup();
  await atomic(db, async (tx) => {
    await tx.put(row("APP#PUNCHER", "SCHEMA", {}));
  });
  await app.scan(device, "000123", uid());
  advance(120);
  await app.scan(device, "000123", uid());
  const result = await shopTotals(
    db,
    device,
    () => new Date("2026-05-31T19:00:00Z"),
  );
  assert.equal(result.weekSeconds, 120);
  assert.equal(result.yearSeconds, 120);
  assert.equal(result.allTimeSeconds, 120);
  assert.equal(
    (await db.get(key("SUMMARY#SHOP", "TOTALS")))?.allTimeSeconds,
    120,
  );
  assert.equal(await db.get(key("SUMMARY#SHOP", "REFRESH")), undefined);
});
test("real conditional card claim and event uniqueness across competing writers", async () => {
  const { app, db } = await setup();
  const rs = await Promise.allSettled(
    ["c", "d"].map((id) => seedUser(db, id, id, "STUDENT", "999999")),
  );
  assert.equal(rs.filter((r) => r.status === "fulfilled").length, 1);
  const e = await app.saveEvent(mentor, {
    title: "Synthetic outreach",
    eventDate: "2026-06-01",
    hours: "2.1",
  });
  const awards = await Promise.all(
    Array.from({ length: 5 }, () => app.award(mentor, e.eventId, "000123")),
  );
  assert.equal(awards.filter((r) => r.state === "logged").length, 1);
  assert.equal(
    (await all(db, "ATTENDANCE#member-a", { prefix: "VOLUNTEER#" })).length,
    1,
  );
});
test("real cleanup racing a new scan preserves completed credit and new session", async () => {
  const { app, db, set, advance, openShop } = await setup();
  await app.scan(device, "000123", uid());
  advance(300);
  await app.scan(device, "000123", uid());
  advance(6);
  await app.scan(device, "000123", uid());
  set("2026-06-03T05:00:01.000Z");
  await openShop();
  const [, scan] = await Promise.all([
    app.cleanup(),
    app.scan(device, "000123", uid()),
  ]);
  assert.equal(scan.state, "in");
  await app.cleanup();
  assert.ok((await db.get(key("ATTENDANCE#member-a", "CURRENT")))?.sessionId);
  const sessions = await all(db, "ATTENDANCE#member-a", { prefix: "SHOP#" });
  assert.equal(
    sessions.filter(eligible).reduce((n, r) => n + r.creditedSeconds, 0),
    300,
  );
  assert.equal(
    sessions.filter((r) => r.status === "forfeited_missing_checkout").length,
    1,
  );
});
test("paginated catch-up processes more than one DynamoDB page", async () => {
  const { app, db, set } = await setup();
  for (let i = 0; i < 105; i++)
    await db.commit([
      {
        key: { pk: "ACTIVE", sk: `2000-01-01#orphan${i}` },
        before: undefined,
        after: {
          pk: "ACTIVE",
          sk: `2000-01-01#orphan${i}`,
          v: 1,
          schemaVersion: 2,
          cutoffAt: "2000-01-01T00:00:00Z",
          memberId: `orphan${i}`,
          sessionId: `old${i}`,
        },
      },
    ]);
  set("2026-06-03T05:00:01.000Z");
  await app.cleanup();
  assert.equal((await all(db, "ACTIVE")).length, 0);
});
