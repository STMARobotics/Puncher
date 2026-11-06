import { assignCard } from "../service/card-codes";
import { Puncher } from "../service/domain";
import { MemoryStore, type Store, atomic } from "../service/store";
import {
  row,
  key,
  hash,
  type Human,
  type Principal,
  type Role,
} from "../service/model";
export const admin: Human = {
  kind: "human",
  id: "local-admin",
  role: "ADMIN",
};
export const mentor: Human = {
  kind: "human",
  id: "local-mentor",
  role: "MENTOR",
};
export const device: Principal = {
  kind: "device",
  id: "test-device",
};
export async function seedUser(
  db: Store,
  memberId: string,
  displayName: string,
  role: Role,
  code?: string,
) {
  return atomic(db, async (tx) => {
    const userKey = key("USER#" + memberId);
    await tx.put(
      row(userKey.pk, userKey.sk, {
        memberId,
        displayName,
        role,
        active: true,
        email: memberId + "@stmarobotics.org",
        barcode: await assignCard(tx, memberId, code),
        gsi1pk: "USERS",
        gsi1sk: memberId,
      }),
    );
  });
}
export async function fixture(db: Store = new MemoryStore(), open = true) {
  let now = new Date("2026-05-31T18:00:00.000Z");
  const app = new Puncher(db, () => now);
  await atomic(db, async (tx) => {
    await tx.put(row("APP#PUNCHER", "SCHEMA", {}));
    await tx.put(
      row("DEVICE#test-device", "METADATA", {
        enabled: true,
        expiresAt: "2099-01-01T00:00:00.000Z",
        secretHash: hash("test"),
        sessionType: "mentor-launch",
        launchedBy: mentor.id,
      }),
    );
  });
  await seedUser(db, admin.id, "Casey Admin", admin.role, "000890");
  await seedUser(db, mentor.id, "Taylor Mentor", mentor.role, "000789");
  await seedUser(db, "member-a", "Alex Example", "STUDENT", "000123");
  await seedUser(db, "member-b", "Jordan Sample", "STUDENT", "000456");
  const openShop = async (person = mentor) => {
    const pass = await app.issueKioskActivation(person);
    const kiosk = await app.activateKiosk(pass.code);
    return { ...pass, ...kiosk };
  };
  if (open) await openShop();
  return {
    db,
    app,
    openShop,
    advance: (seconds: number) => {
      now = new Date(now.getTime() + seconds * 1000);
    },
    set: (iso: string) => {
      now = new Date(iso);
    },
  };
}
