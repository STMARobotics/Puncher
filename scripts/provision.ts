import { store, runtime } from "../service/runtime";
import { assignCard } from "../service/card-codes";
import { atomic } from "../service/store";
import { SCHEMA_VERSION, key, row, assert, hash, uid } from "../service/model";

const db = store();
const config = runtime();
const [command, ...args] = process.argv.slice(2);

async function initializeSchema() {
  await atomic(db, async (tx) => {
    const schemaKey = key("APP#PUNCHER", "SCHEMA");
    const schema = await tx.get(schemaKey);
    assert(
      !schema || schema.schemaVersion === SCHEMA_VERSION,
      "Use a fresh table for schema v2.",
    );
    if (!schema)
      await tx.put(
        row(schemaKey.pk, schemaKey.sk, {
          timezone: "America/Chicago",
          durationUnit: "seconds",
          reportingYearConvention:
            "ending year; June 2 through June 1 inclusive",
        }),
      );
  });
}

if (command === "schema") {
  await initializeSchema();
} else if (command === "bootstrap-admin") {
  const [sub, email] = args;
  assert(
    sub && /^[^@]+@stmarobotics\.org$/i.test(email || ""),
    "Usage: provision bootstrap-admin GOOGLE_SUB email@stmarobotics.org",
  );
  assert(
    process.env.CONFIRM_BOOTSTRAP === "true",
    "Set CONFIRM_BOOTSTRAP=true to grant administrator access.",
  );
  await initializeSchema();
  await atomic(db, async (tx) => {
    const bootstrapKey = key("APP#PUNCHER", "BOOTSTRAP");
    assert(
      !(await tx.get(bootstrapKey)),
      "The first administrator is already configured.",
    );
    const user = await tx.get(key("USER#" + sub));
    assert(
      user?.active && user.email === email.toLowerCase(),
      "The intended administrator must sign in with that email first.",
    );
    const current = await tx.get(key("ATTENDANCE#" + sub, "CURRENT"));
    const at = new Date().toISOString();
    assert(
      !current?.sessionId || current.cutoffAt <= at,
      "The member must clock out before their role changes.",
    );
    await tx.put({ ...user, role: "ADMIN" });
    await tx.put(row(bootstrapKey.pk, bootstrapKey.sk, { memberId: sub, at }));
    await tx.put(
      row("AUDIT", at + "#" + uid(), {
        action: "admin.bootstrap",
        actor: "aws-operator",
        target: sub,
        at,
      }),
    );
  });
  console.log("Administrator configured.");
} else if (command === "seed") {
  assert(
    config.fixtures && config.endpoint,
    "Synthetic seed is DynamoDB Local only.",
  );
  await initializeSchema();
  await atomic(db, async (tx) => {
    for (const [memberId, displayName, role, code] of [
      ["local-admin", "Casey Admin", "ADMIN", "000890"],
      ["local-mentor", "Taylor Mentor", "MENTOR", "000789"],
      ["local-student", "Alex Example", "STUDENT", "000123"],
      ["local-student-two", "Jordan Sample", "STUDENT", "000456"],
      ["local-presence-a", "Casey Preview", "STUDENT", "000567"],
      ["local-presence-b", "Morgan Preview", "STUDENT", "000678"],
    ] as const) {
      const userKey = key("USER#" + memberId);
      if (await tx.get(userKey)) continue;
      await tx.put(
        row(userKey.pk, userKey.sk, {
          memberId,
          displayName,
          role,
          email: memberId + "@stmarobotics.org",
          barcode: await assignCard(tx, memberId, code),
          active: true,
          gsi1pk: "USERS",
          gsi1sk: memberId,
        }),
      );
    }
    const deviceId = "33333333-3333-4333-8333-333333333333";
    const deviceKey = key("DEVICE#" + deviceId);
    if (!(await tx.get(deviceKey)))
      await tx.put(
        row(deviceKey.pk, deviceKey.sk, {
          deviceId,
          label: "Synthetic shop kiosk",
          enabled: true,
          secretHash: hash("synthetic-local-device"),
          sessionType: "mentor-launch",
          launchedBy: "local-mentor",
          expiresAt: "2099-01-01T00:00:00.000Z",
          gsi1pk: "DEVICES",
          gsi1sk: deviceId,
        }),
      );
  });
  console.log(
    "Synthetic students: 000123 and 000456. Use a local mentor to activate the kiosk.",
  );
} else {
  throw new Error(
    "Commands: schema | seed | bootstrap-admin <googleSub> <email>",
  );
}
