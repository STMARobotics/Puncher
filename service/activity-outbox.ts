import { makeActivity, outboxItem } from './activity-contract';
import type { Change } from './store';
import { eligible, type Row } from './model';

// Called at the persistence boundary so kiosk, staff, imports, and corrections
// participate in the same transaction as the canonical credit.
export function appendActivityEvents(changes: Change[], config?: { orgId: string }): Change[] {
  if (!config) return changes;
  const additions: Change[] = [];
  for (const change of changes) {
    if (
      change.checkOnly ||
      !change.key.pk.startsWith('MEMBER#') ||
      !/^(SHOP|LEGACYSHOP|VOLUNTEER)#/.test(change.key.sk)
    )
      continue;
    const before = change.before,
      after = change.after;
    const was = !!before && eligible(before),
      is = !!after && eligible(after);
    if (!was && !is) continue;
    const current = after ?? before!;
    const date = (r: Row | undefined) => r?.shopDate ?? r?.eventDate;
    if (
      was === is &&
      before?.creditedSeconds === after?.creditedSeconds &&
      date(before) === date(after)
    )
      continue;
    // A correction can retain earlier recordedAt/voidedAt fields. Use capture time
    // for transport history; the authoritative business date stays separate.
    const occurredAt = new Date().toISOString();
    const event = makeActivity({
      type: 'puncher.credit.changed.v1',
      source: 'puncher',
      orgId: config.orgId,
      entityId: change.key.pk + '/' + change.key.sk,
      entityVersion: (before?.v ?? 0) + 1,
      subject: { namespace: 'puncher.member', id: change.key.pk.slice('MEMBER#'.length) },
      occurredAt,
      effectiveDate: date(current),
      metrics: change.key.sk.startsWith('VOLUNTEER#')
        ? { volunteerSeconds: is ? current.creditedSeconds : 0 }
        : { shopSeconds: is ? current.creditedSeconds : 0 },
    });
    const item = { ...outboxItem(event), v: 1 } as Row;
    additions.push({ key: { pk: item.pk, sk: item.sk }, before: undefined, after: item });
  }
  if (changes.length + additions.length > 100)
    throw new Error(
      'Activity transaction exceeds DynamoDB 100-item limit; reduce the source batch.',
    );
  return [...changes, ...additions];
}
