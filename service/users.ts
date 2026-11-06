import { assignCard } from "./card-codes";
import { SCHEMA_VERSION, assert, key, row } from "./model";
import { type Store, atomic } from "./store";

export async function registerUser(
  db: Store,
  profile: { sub: string; email: string; name?: string },
) {
  const userKey = key("USER#" + profile.sub);
  return atomic(db, async (tx) => {
    const existing = await tx.get(userKey);
    if (existing) {
      assert(existing.active, "Your Puncher access is disabled.", 403);
      return existing;
    }
    const schema = await tx.get(key("APP#PUNCHER", "SCHEMA"));
    assert(
      schema?.schemaVersion === SCHEMA_VERSION,
      "Puncher is awaiting database setup.",
      503,
    );
    const email = profile.email.toLowerCase();
    const user = row(userKey.pk, userKey.sk, {
      memberId: profile.sub,
      email,
      displayName: profile.name?.trim().slice(0, 100) || email,
      role: "STUDENT",
      active: true,
      barcode: await assignCard(tx, profile.sub),
      gsi1pk: "USERS",
      gsi1sk: profile.sub,
    });
    await tx.put(user);
    return user;
  });
}
