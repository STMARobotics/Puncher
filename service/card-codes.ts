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
    const claim = await tx.get(key("CARD#" + code));
    const reserved = await tx.get(key("CARDCODE#" + code));
    if (!preferred && (claim || reserved)) continue;
    if (
      (claim && claim.memberId !== memberId) ||
      (reserved && reserved.memberId !== memberId)
    ) {
      assert(!preferred, "Card is already assigned or retired.", 409);
      continue;
    }
    if (!claim) await tx.put(row("CARD#" + code, "METADATA", { memberId }));
    if (!reserved)
      await tx.put(row("CARDCODE#" + code, "METADATA", { memberId }));
    return code;
  }
  throw new Error("Unable to allocate a unique card code; retry.");
}
