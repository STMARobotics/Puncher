import { Puncher } from "../service/domain";
import { MemoryStore, type Store, atomic } from "../service/store";
import { row, hash, type Principal } from "../service/model";
export const admin: Principal = {
  kind: "human",
  id: "local-admin",
  roles: ["admin", "stats:staff"],
};
export const mentor: Principal = {
  kind: "human",
  id: "local-mentor",
  roles: ["mentor"],
};
export const device: Principal = {
  kind: "device",
  id: "test-device",
  roles: [],
};
export async function fixture(db: Store = new MemoryStore(), open = true) {
  let now = new Date("2026-05-31T18:00:00.000Z");
  const app = new Puncher(db, () => now);
  await atomic(db, async (tx) => {
    for (const p of [admin, mentor])
      await tx.put(
        row(`IDENTITY#${p.id}`, "METADATA", {
          enabled: true,
          roles: p.roles,
          displayName: p === mentor ? "Taylor Mentor" : "Casey Admin",
        }),
      );
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
  await app.saveMember(
    admin,
    {
      displayName: "Alex Example",
      memberKind: "student",
      active: true,
      barcode: "000123",
    },
    "member-a",
  );
  await app.saveMember(
    admin,
    {
      displayName: "Jordan Sample",
      memberKind: "student",
      active: true,
      barcode: "000456",
    },
    "member-b",
  );
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
