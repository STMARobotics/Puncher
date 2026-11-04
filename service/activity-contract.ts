// Versioned with contracts/activity-snapshot.v1.json. No sibling-checkout imports.
import { createHash } from 'node:crypto';

export const metricNames = [
  'shopSeconds',
  'volunteerSeconds',
  'packsOpened',
  'battleWins',
  'battleLosses',
  'battleDraws',
  'fmeaSubmitted',
] as const;
export type Metric = (typeof metricNames)[number];
export type Metrics = Record<Metric, number>;
export type Activity = {
  schemaVersion: 1;
  eventId: string;
  type:
    | 'puncher.credit.changed.v1'
    | 'packs.pack.opened.v1'
    | 'packs.battle.finalized.v1'
    | 'fmea.submission.changed.v1';
  source: 'puncher' | 'packs' | 'fmea';
  orgId: string;
  entityId: string;
  entityVersion: number;
  subject: { namespace: 'puncher.member' | 'packs.player' | 'fmea.google'; id: string };
  occurredAt: string;
  effectiveDate: string;
  metrics: Metrics;
};
export const zeroMetrics = (): Metrics =>
  Object.fromEntries(metricNames.map((k) => [k, 0])) as Metrics;
export const digest = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function eventIdentity(e: Omit<Activity, 'eventId'>): string {
  return digest([
    e.orgId,
    e.source,
    e.type,
    e.entityId,
    e.entityVersion,
    e.subject.namespace,
    e.subject.id,
  ]);
}
export function activityConfig(
  env: Record<string, string | undefined> = process.env,
): { orgId: string } | undefined {
  if (env.INTEGRATION_ENABLED !== 'true') return undefined;
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(env.INTEGRATION_ORG_ID ?? ''))
    throw new Error('INTEGRATION_ORG_ID is required when integration is enabled.');
  return { orgId: env.INTEGRATION_ORG_ID! };
}
const bounded = (v: unknown, max: number): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= max;
const keysAre = (v: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(v).length === keys.length && keys.every((k) => Object.hasOwn(v, k));
export function parseActivity(value: unknown): Activity {
  const e = value as Activity;
  const permitted = {
    'puncher.credit.changed.v1': ['shopSeconds', 'volunteerSeconds'],
    'packs.pack.opened.v1': ['packsOpened'],
    'packs.battle.finalized.v1': ['battleWins', 'battleLosses', 'battleDraws'],
    'fmea.submission.changed.v1': ['fmeaSubmitted'],
  } as const;
  if (
    !e ||
    typeof e !== 'object' ||
    !keysAre(e as unknown as Record<string, unknown>, [
      'schemaVersion',
      'eventId',
      'type',
      'source',
      'orgId',
      'entityId',
      'entityVersion',
      'subject',
      'occurredAt',
      'effectiveDate',
      'metrics',
    ]) ||
    e.schemaVersion !== 1 ||
    !Object.hasOwn(permitted, e.type) ||
    !bounded(e.orgId, 64) ||
    !/^[a-z0-9][a-z0-9-]{0,63}$/.test(e.orgId) ||
    !bounded(e.entityId, 512) ||
    !Number.isSafeInteger(e.entityVersion) ||
    e.entityVersion < 1 ||
    !e.subject ||
    !keysAre(e.subject, ['namespace', 'id']) ||
    !bounded(e.subject.id, 256) ||
    !e.metrics ||
    !keysAre(e.metrics, metricNames) ||
    metricNames.some((k) => !Number.isSafeInteger(e.metrics[k]) || e.metrics[k] < 0) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(e.effectiveDate) ||
    !Number.isFinite(Date.parse(e.effectiveDate)) ||
    new Date(e.effectiveDate).toISOString().slice(0, 10) !== e.effectiveDate ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(e.occurredAt) ||
    !Number.isFinite(Date.parse(e.occurredAt)) ||
    new Date(e.occurredAt).toISOString() !== e.occurredAt
  )
    throw new Error('Invalid activity snapshot v1.');
  const expectedSource = e.type.split('.')[0];
  const expectedNamespace = {
    puncher: 'puncher.member',
    packs: 'packs.player',
    fmea: 'fmea.google',
  }[e.source];
  if (
    e.source !== expectedSource ||
    !expectedNamespace ||
    e.subject.namespace !== expectedNamespace ||
    metricNames.some(
      (k) => !(permitted[e.type] as readonly string[]).includes(k) && e.metrics[k] !== 0,
    ) ||
    e.eventId !== eventIdentity(e) ||
    e.metrics.packsOpened > 1 ||
    e.metrics.fmeaSubmitted > 1 ||
    e.metrics.battleWins + e.metrics.battleLosses + e.metrics.battleDraws > 1 ||
    (e.metrics.shopSeconds > 0 && e.metrics.volunteerSeconds > 0)
  )
    throw new Error('Activity source, identity, or metric ownership mismatch.');
  return e;
}
export function makeActivity(
  e: Omit<Activity, 'eventId' | 'schemaVersion' | 'metrics'> & { metrics: Partial<Metrics> },
): Activity {
  const body = { ...e, schemaVersion: 1 as const, metrics: { ...zeroMetrics(), ...e.metrics } };
  return parseActivity({ ...body, eventId: eventIdentity(body) });
}
// Flat attributes let Pipes unwrap to canonical JSON without an enrichment Lambda.
// No TTL: retain until the reviewed archive/recovery retention policy is implemented.
export function outboxItem(e: Activity): Record<string, string | number> {
  parseActivity(e);
  return {
    pk: 'OUTBOX#' + e.orgId + '#' + e.source + '#' + e.occurredAt.slice(0, 10),
    sk: e.eventId,
    recordType: 'ACTIVITY_OUTBOX_V1',
    schemaVersion: 1,
    eventId: e.eventId,
    eventType: e.type,
    source: e.source,
    orgId: e.orgId,
    entityId: e.entityId,
    entityVersion: e.entityVersion,
    subjectNamespace: e.subject.namespace,
    subjectId: e.subject.id,
    occurredAt: e.occurredAt,
    effectiveDate: e.effectiveDate,
    ...e.metrics,
  };
}

// DynamoDB Streams exposes Number attributes as strings. Keep that wire encoding
// explicit; consumer decoding restores safe integers before domain validation.
export type ActivityWire = {
  encoding: 'activity-snapshot.v1';
  orgId: string;
  activity: Omit<Activity, 'entityVersion' | 'metrics'> & {
    entityVersion: string;
    metrics: Record<Metric, string>;
  };
};
export function toActivityWire(value: Activity): ActivityWire {
  const e = parseActivity(value);
  return {
    encoding: 'activity-snapshot.v1',
    orgId: e.orgId,
    activity: {
      ...e,
      entityVersion: String(e.entityVersion),
      metrics: Object.fromEntries(metricNames.map((k) => [k, String(e.metrics[k])])) as Record<
        Metric,
        string
      >,
    },
  };
}
export function parseActivityWire(value: unknown): Activity {
  const wire = value as ActivityWire;
  if (
    !wire ||
    typeof wire !== 'object' ||
    !keysAre(wire, ['encoding', 'orgId', 'activity']) ||
    wire.encoding !== 'activity-snapshot.v1' ||
    !wire.activity ||
    typeof wire.activity !== 'object' ||
    wire.orgId !== wire.activity.orgId ||
    !wire.activity.metrics ||
    !keysAre(wire.activity.metrics, metricNames)
  )
    throw new Error('Invalid activity wire envelope v1.');
  const integer = (value: unknown) => {
    if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,15})$/.test(value))
      throw new Error('Activity wire values must be unsigned decimal strings.');
    const result = Number(value);
    if (!Number.isSafeInteger(result)) throw new Error('Unsafe activity wire integer.');
    return result;
  };
  return parseActivity({
    ...wire.activity,
    entityVersion: integer(wire.activity.entityVersion),
    metrics: Object.fromEntries(metricNames.map((k) => [k, integer(wire.activity.metrics[k])])),
  });
}
