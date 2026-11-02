import { test, after } from "node:test";
import assert from "node:assert/strict";
import {
  DynamoDBClient,
  CreateTableCommand,
  DeleteTableCommand,
} from "@aws-sdk/client-dynamodb";
import { DynamoStore, all } from "../service/store";
import { fixture, device, admin, mentor } from "./helpers";
import { uid, eligible, key } from "../service/model";
import { row } from "../service/model";
import { atomic } from "../service/store";
import { shopTotals } from "../service/shop-totals";
const endpoint = process.env.DYNAMODB_ENDPOINT || "http://127.0.0.1:8000";
assert.ok(["localhost", "127.0.0.1"].includes(new URL(endpoint).hostname));
const client = new DynamoDBClient({
    endpoint,
    region: "us-east-2",
    credentials: { accessKeyId: "local", secretAccessKey: "local" },
  }),
  tables: string[] = [];
async function setup() {
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
  return fixture(new DynamoStore(table, endpoint));
}
after(async () => {
  for (const TableName of tables)
    await client.send(new DeleteTableCommand({ TableName: TableName }));
  client.destroy();
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
    (await all(db, "MEMBER#member-a", { prefix: "SHOP#" })).filter(eligible)
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
    ["c", "d"].map((id) =>
      app.saveMember(
        admin,
        {
          displayName: id,
          memberKind: "student",
          active: true,
          barcode: "999999",
        },
        id,
      ),
    ),
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
    (await all(db, "MEMBER#member-a", { prefix: "VOLUNTEER#" })).length,
    1,
  );
});
test("real cleanup racing a new scan preserves completed credit and new session", async () => {
  const { app, db, set, advance } = await setup();
  await app.scan(device, "000123", uid());
  advance(300);
  await app.scan(device, "000123", uid());
  advance(6);
  await app.scan(device, "000123", uid());
  set("2026-06-03T05:00:01.000Z");
  const [, scan] = await Promise.all([
    app.cleanup(),
    app.scan(device, "000123", uid()),
  ]);
  assert.equal(scan.state, "in");
  await app.cleanup();
  assert.ok((await db.get(key("MEMBER#member-a", "CURRENT")))?.sessionId);
  const sessions = await all(db, "MEMBER#member-a", { prefix: "SHOP#" });
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
          schemaVersion: 1,
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
