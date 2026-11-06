import { describe, expect, it } from 'vitest';
import { fixture, device, admin, mentor } from './helpers';
import { MemoryStore, atomic, all, Conflict } from '../service/store';
import { uid, key, row } from '../service/model';
import { activityConfig } from '../service/activity-contract';

const outboxes = (db: MemoryStore) =>
  [...db.rows.values()].filter((r) => r.recordType === 'ACTIVITY_OUTBOX_V1');
describe('transactional activity capture', () => {
  it('is disabled by default and rejects incomplete enabled configuration', async () => {
    expect(activityConfig({})).toBeUndefined();
    expect(() => activityConfig({ INTEGRATION_ENABLED: 'true' })).toThrow();
    const db = new MemoryStore();
    const { app, advance } = await fixture(db);
    await app.scan(device, '000123', uid());
    advance(3600);
    await app.scan(device, '000123', uid());
    expect(outboxes(db)).toHaveLength(0);
  });
  it('captures completed credit once despite concurrent operation retries, and excludes active/missed checkout', async () => {
    const db = new MemoryStore({ orgId: 'example-team' });
    const { app, advance, set } = await fixture(db);
    await app.scan(device, '000123', uid());
    expect(outboxes(db)).toHaveLength(0);
    advance(3600);
    const operation = uid();
    await Promise.all([
      app.scan(device, '000123', operation),
      app.scan(device, '000123', operation),
    ]);
    expect(outboxes(db)).toHaveLength(1);
    expect(outboxes(db)[0]).toMatchObject({
      shopSeconds: 3600,
      subjectId: 'member-a',
      entityVersion: 2,
    });
    advance(10);
    await app.scan(device, '000123', uid());
    set('2026-06-01T05:00:00.000Z');
    await app.cleanup();
    expect(outboxes(db)).toHaveLength(1);
  });
  it('publishes absolute approval/void/reapproval revisions for imported credit', async () => {
    const db = new MemoryStore({ orgId: 'example-team' });
    const { app } = await fixture(db);
    await atomic(db, async (tx) =>
      tx.put(
        row('ATTENDANCE#member-a', 'VOLUNTEER#2026-05-31#legacy', {
          creditedSeconds: 120,
          eventDate: '2026-05-31',
          status: 'pending_review',
          provenance: { importKey: 'import-a' },
        }),
      ),
    );
    const input = {
      pk: 'ATTENDANCE#member-a',
      sk: 'VOLUNTEER#2026-05-31#legacy',
      reason: 'reviewed original record',
    };
    await app.review(admin, { ...input, status: 'approved' });
    await app.review(admin, { ...input, status: 'voided' });
    await app.review(admin, { ...input, status: 'approved' });
    expect(outboxes(db).map((r) => [r.entityVersion, r.volunteerSeconds])).toEqual([
      [2, 120],
      [3, 0],
      [4, 120],
    ]);
    expect(JSON.stringify(outboxes(db))).not.toMatch(/000123|reviewReason|secretHash/);
  });
  it('does not persist an outbox if any other conditional write fails', async () => {
    const db = new MemoryStore({ orgId: 'example-team' });
    await fixture(db);
    const member = await db.get(key('ATTENDANCE#member-a'));
    await expect(
      db.commit([
        { key: key('ATTENDANCE#member-a'), before: { ...member!, v: -1 }, after: member },
        {
          key: key('ATTENDANCE#member-a', 'SHOP#test'),
          before: undefined,
          after: row('ATTENDANCE#member-a', 'SHOP#test', {
            status: 'completed',
            endedAt: '2026-05-31T20:00:00.000Z',
            cutoffAt: '2026-06-01T05:00:00.000Z',
            shopDate: '2026-05-31',
            creditedSeconds: 60,
          }),
        },
      ]),
    ).rejects.toBeInstanceOf(Conflict);
    expect(outboxes(db)).toHaveLength(0);
  });
  it('captures a volunteer award and its void without treating event metadata edits as new credit', async () => {
    const db = new MemoryStore({ orgId: 'example-team' });
    const { app } = await fixture(db);
    const event = await app.saveEvent(mentor, {
      title: 'Community event',
      eventDate: '2026-05-31',
      hours: '0.5',
    });
    await app.award(mentor, event.eventId, '000123');
    await app.award(mentor, event.eventId, '000123');
    await app.removeAward(mentor, event.eventId, 'member-a', 'duplicate participation');
    expect(outboxes(db).map((r) => r.volunteerSeconds)).toEqual([1800, 0]);
  });
});
