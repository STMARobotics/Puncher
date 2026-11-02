import { Temporal } from "@js-temporal/polyfill";
import { type Store, all, atomic } from "./store";
import { Puncher } from "./domain";
import {
  type Principal,
  type Row,
  key,
  row,
  localDay,
  reportingYear,
  validDate,
  eligible,
  uid,
  assert,
  Fault,
} from "./model";
import { device } from "./auth";
import { store } from "./runtime";

export type ShopTotals = {
  weekSeconds: number;
  yearSeconds: number;
  allTimeSeconds: number;
  weekStart: string;
  reportingYear: number;
  updatedAt: string;
};
const publicTotals = (r: Row): ShopTotals => ({
  weekSeconds: r.weekSeconds,
  yearSeconds: r.yearSeconds,
  allTimeSeconds: r.allTimeSeconds,
  weekStart: r.weekStart,
  reportingYear: r.reportingYear,
  updatedAt: r.updatedAt,
});

// Rebuilt from canonical credits, never treated as another source of credit by Stats.
// A database lease bounds refresh work across Lambda instances; responses contain aggregates only.
export async function shopTotals(
  db: Store,
  p: Principal,
  clock: () => Date = () => new Date(),
): Promise<ShopTotals> {
  assert(p.kind === "device", "Kiosk device authorization required.", 403);
  const app = new Puncher(db, clock);
  await atomic(db, async (tx) => {
    await app.livePrincipal(tx, p);
    await app.rate(tx, p);
  });
  const schema = await db.get(key("APP#PUNCHER", "SCHEMA"));
  assert(
    schema?.schemaVersion === 1,
    "Unsupported or missing attendance schema.",
    503,
  );
  const now = clock(),
    today = localDay(now),
    date = Temporal.PlainDate.from(today);
  const weekStart = date.subtract({ days: date.dayOfWeek - 1 }).toString();
  const weekEnd = Temporal.PlainDate.from(weekStart)
    .add({ days: 7 })
    .toString();
  const year = reportingYear(today),
    cacheKey = key("SUMMARY#SHOP", "TOTALS"),
    lockKey = key("SUMMARY#SHOP", "REFRESH");
  const cached = await db.get(cacheKey);
  const samePeriod =
    cached?.weekStart === weekStart && cached?.reportingYear === year;
  if (samePeriod && now.getTime() - Date.parse(cached.updatedAt) < 60000)
    return publicTotals(cached);
  const leaseId = uid();
  const acquired = await atomic(db, async (tx) => {
    const lease = await tx.get(lockKey);
    if (lease?.expiresAt > now.toISOString()) return false;
    await tx.put(
      row(lockKey.pk, lockKey.sk, {
        leaseId,
        expiresAt: new Date(now.getTime() + 30000).toISOString(),
      }),
    );
    return true;
  });
  if (!acquired) {
    if (samePeriod && now.getTime() - Date.parse(cached.updatedAt) < 120000)
      return publicTotals(cached);
    throw new Fault(503, "Shop totals are updating.");
  }
  try {
    const members = await all(db, "MEMBERS", { index: "GSI1" });
    let weekSeconds = 0,
      yearSeconds = 0,
      allTimeSeconds = 0;
    // Bound parallelism. Include inactive members' historical credit and paginate every partition.
    for (let i = 0; i < members.length; i += 4) {
      const groups = await Promise.all(
        members.slice(i, i + 4).map(async (member) => [
          ...(await all(db, `MEMBER#${member.memberId}`, {
            prefix: "SHOP#",
          })),
          ...(await all(db, `MEMBER#${member.memberId}`, {
            prefix: "LEGACYSHOP#",
          })),
        ]),
      );
      for (const records of groups)
        for (const record of records) {
          if (
            !eligible(record) ||
            !Number.isSafeInteger(record.creditedSeconds) ||
            record.creditedSeconds < 0
          )
            continue;
          let shopDate: string;
          try {
            shopDate = validDate(record.shopDate);
          } catch {
            continue;
          }
          allTimeSeconds += record.creditedSeconds;
          if (shopDate >= weekStart && shopDate < weekEnd)
            weekSeconds += record.creditedSeconds;
          if (reportingYear(shopDate) === year)
            yearSeconds += record.creditedSeconds;
        }
    }
    const result: ShopTotals = {
      weekSeconds,
      yearSeconds,
      allTimeSeconds,
      weekStart,
      reportingYear: year,
      updatedAt: clock().toISOString(),
    };
    await atomic(db, async (tx) => {
      const lease = await tx.get(lockKey);
      assert(lease?.leaseId === leaseId, "Shop totals refresh timed out.", 503);
      await tx.put(row(cacheKey.pk, cacheKey.sk, result));
      await tx.del(lockKey);
    });
    return result;
  } catch (error) {
    await atomic(db, async (tx) => {
      const lease = await tx.get(lockKey);
      if (lease?.leaseId === leaseId) await tx.del(lockKey);
    });
    throw error;
  }
}
export async function handler(event: any) {
  try {
    assert(
      event.requestContext.http.method === "GET",
      "Method not allowed.",
      405,
    );
    const db = store(),
      headers = {
        ...event.headers,
        cookie: event.cookies?.join("; ") || event.headers?.cookie,
      };
    const p = await device(headers, db);
    return {
      statusCode: 200,
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
      },
      body: JSON.stringify(await shopTotals(db, p)),
    };
  } catch (error) {
    return {
      statusCode: error instanceof Fault ? error.status : 503,
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
      },
      body: JSON.stringify({
        message:
          error instanceof Fault
            ? error.message
            : "Shop totals are unavailable.",
      }),
    };
  }
}
