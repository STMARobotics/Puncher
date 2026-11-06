import { randomInt } from "node:crypto";
import { Tx } from "./store";
import { assert, barcode, key, row } from "./model";

// Reservations outlive card replacement: an old physical card must never start
// identifying a different member. Codes are identifiers, not login credentials.
export async function assignCard(
  tx: Tx,
  memberId: string,
  preferred?: string,
  nextCode = () => String(randomInt(100000, 1000000)),
): Promise<string> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const code = barcode(preferred ?? nextCode());
    const cardKey = key("CARD#" + code);
    const card = await tx.get(cardKey);
    if (!card) {
      await tx.put(row(cardKey.pk, cardKey.sk, { memberId, retired: false }));
      return code;
    }
    if (preferred) {
      assert(
        card.memberId === memberId && !card.retired,
        "Card is already assigned or retired.",
        409,
      );
      return code;
    }
  }
  throw new Error("Unable to allocate a unique card code; retry.");
}
