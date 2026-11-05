import { readFileSync } from "node:fs";
import { store, runtime } from "../service/runtime";
import { atomic } from "../service/store";
import { key, row, assert, hash, uid } from "../service/model";
import { Puncher } from "../service/domain";
const db = store(),
  c = runtime(),
  [command, ...args] = process.argv.slice(2);
async function schema() {
  await atomic(db, async (tx) => {
    const old = await tx.get(key("APP#PUNCHER", "SCHEMA"));
    assert(!old || old.schemaVersion === 1, "Unsupported schema.");
    await tx.put(
      row("APP#PUNCHER", "SCHEMA", {
        timezone: "America/Chicago",
        durationUnit: "seconds",
        reportingYearConvention: "ending year; June 2 through June 1 inclusive",
      }),
    );
  });
}
if (command === "schema") await schema();
else if (command === "bootstrap-admin") {
  const [googleSub, email] = args;
  assert(
    googleSub && /^[^@]+@stmarobotics\.org$/.test(email || ""),
    "Usage: provision bootstrap-admin VERIFIED_GOOGLE_SUB email@stmarobotics.org",
  );
  assert(
    process.env.CONFIRM_BOOTSTRAP === "true",
    "Set CONFIRM_BOOTSTRAP=true after verifying the subject through Google. Use an authorized AWS SSO operational identity.",
  );
  await schema();
  await atomic(db, async (tx) => {
    assert(
      !(await tx.get(key("APP#PUNCHER", "BOOTSTRAP"))),
      "First administrator is already provisioned. Use the admin UI.",
    );
    await tx.put(
      row(`IDENTITY#${googleSub}`, "METADATA", {
        googleSub,
        email,
        roles: ["admin", "stats:staff"],
        enabled: true,
        gsi1pk: "IDENTITIES",
        gsi1sk: googleSub,
      }),
    );
    await tx.put(
      row("APP#PUNCHER", "BOOTSTRAP", {
        googleSub,
        at: new Date().toISOString(),
      }),
    );
    await tx.put(
      row("AUDIT", `${new Date().toISOString()}#${uid()}`, {
        action: "admin.bootstrap",
        actor: "aws-operator",
        target: googleSub,
      }),
    );
  });
  console.log("Administrator provisioned.");
} else if (command === "seed") {
  assert(c.fixtures && c.endpoint, "Synthetic seed is DynamoDB Local only.");
  await schema();
  for (const [sub, roles] of [
    ["local-admin", ["admin", "stats:staff"]],
    ["local-mentor", ["mentor"]],
    ["local-student", ["student", "stats:student"]],
  ] as const) {
    await atomic(db, async (tx) => {
      await tx.put(
        row(`IDENTITY#${sub}`, "METADATA", {
          googleSub: sub,
          email: `${sub}@stmarobotics.org`,
          enabled: true,
          roles: [...roles],
          gsi1pk: "IDENTITIES",
          gsi1sk: sub,
        }),
      );
    });
  }
  const p = {
    kind: "human" as const,
    id: "local-admin",
    roles: ["admin", "stats:staff"],
  };
  const app = new Puncher(db);
  for (const [id, name, card, email] of [
    [
      "11111111-1111-4111-8111-111111111111",
      "Alex Example",
      "000123",
      "alex@stmarobotics.org",
    ],
    [
      "22222222-2222-4222-8222-222222222222",
      "Jordan Sample",
      "000456",
      "jordan@stmarobotics.org",
    ],
  ])
    await app.saveMember(
      p,
      {
        displayName: name,
        email,
        barcode: card,
        active: true,
        memberKind: "student",
      },
      id,
    );
  await app.saveIdentity(p, {
    googleSub: "local-student",
    email: "local-student@stmarobotics.org",
    memberId: "11111111-1111-4111-8111-111111111111",
    roles: ["student", "stats:student"],
    enabled: true,
  });
  await atomic(db, async (tx) => {
    await tx.put(
      row("DEVICE#33333333-3333-4333-8333-333333333333", "METADATA", {
        deviceId: "33333333-3333-4333-8333-333333333333",
        label: "Synthetic shop kiosk",
        enabled: true,
        secretHash: hash("synthetic-local-device"),
        sessionType: "mentor-launch",
        launchedBy: "local-mentor",
        expiresAt: "2099-01-01T00:00:00.000Z",
        gsi1pk: "DEVICES",
        gsi1sk: "33333333-3333-4333-8333-333333333333",
      }),
    );
  });
  console.log(
    "Synthetic members: 000123, 000456. Open Start kiosk and generate an activation QR as a local mentor in a separate window. Fixture sign-in is enabled only locally.",
  );
} else if (command === "map-cards") {
  const mappings = JSON.parse(readFileSync(args[0], "utf8"));
  assert(
    Array.isArray(mappings),
    "Mapping file must contain an array of {memberId, barcode}.",
  );
  const sub = args[1];
  const identity = await db.get(key(`IDENTITY#${sub}`));
  assert(
    identity?.enabled && identity.roles.includes("admin"),
    "Supply an enabled admin subject as the second argument.",
  );
  const p = { kind: "human" as const, id: sub, roles: identity.roles };
  for (const m of mappings) {
    const member = await db.get(key(`MEMBER#${m.memberId}`));
    assert(member, "Unknown member.");
    await new Puncher(db).saveMember(
      p,
      { ...member, barcode: m.barcode },
      m.memberId,
    );
  }
  console.log("Explicit mappings saved and audited.");
} else
  throw new Error(
    "Commands: schema | seed | bootstrap-admin <verifiedSub> <email> | map-cards <json-file> <adminSub>",
  );
