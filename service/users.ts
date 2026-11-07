import { assignCard } from "./card-codes";
import { SCHEMA_VERSION, assert, key, row, type Row } from "./model";
import { type Store, atomic } from "./store";

export async function registerUser(
  db: Store,
  profile: { sub: string; email: string; name?: string; picture?: string },
) {
  const userKey = key("USER#" + profile.sub);
  return atomic(db, async (tx) => {
    const existing = await tx.get(userKey);
    const picture = googlePicture(profile.picture);
    const email = profile.email.toLowerCase();
    const displayName = profile.name?.trim().slice(0, 100) || email;
    if (existing) {
      assert(existing.active, "Your Puncher access is disabled.", 403);
      if (
        displayName !== existing.displayName ||
        picture !== existing.picture ||
        Object.hasOwn(existing, "name")
      ) {
        const updated: Row = { ...existing, displayName };
        delete updated.name;
        if (picture) updated.picture = picture;
        else delete updated.picture;
        await tx.put(updated);
        return updated;
      }
      return existing;
    }
    const schema = await tx.get(key("APP#PUNCHER", "SCHEMA"));
    assert(
      schema?.schemaVersion === SCHEMA_VERSION,
      "Puncher is awaiting database setup.",
      503,
    );
    const user = row(userKey.pk, userKey.sk, {
      memberId: profile.sub,
      email,
      displayName,
      ...(picture ? { picture } : {}),
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

function googlePicture(value: unknown): string | undefined {
  if (typeof value !== "string") return;
  try {
    const url = new URL(value);
    if (
      url.protocol === "https:" &&
      (url.hostname === "googleusercontent.com" ||
        url.hostname.endsWith(".googleusercontent.com")) &&
      !url.username &&
      !url.password &&
      !url.port
    )
      return url.toString();
  } catch {
    return;
  }
}
