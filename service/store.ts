import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import { type Key, type Row, Fault } from "./model";
import { activityConfig } from "./activity-contract";
import { appendActivityEvents } from "./activity-outbox";
export type Change = {
  before: Row | undefined;
  after?: Row;
  key: Key;
  checkOnly?: boolean;
};
export type Page = { items: Row[]; cursor?: Key };
export interface Store {
  get(k: Key): Promise<Row | undefined>;
  query(
    pk: string,
    options?: {
      prefix?: string;
      cursor?: Key;
      limit?: number;
      reverse?: boolean;
      index?: "GSI1" | "GSI2";
    },
  ): Promise<Page>;
  commit(changes: Change[]): Promise<void>;
}
export class Conflict extends Error {}
export class DynamoStore implements Store {
  readonly client: DynamoDBDocumentClient;
  constructor(
    readonly table: string,
    endpoint?: string,
    readonly integration = activityConfig(),
  ) {
    this.client = DynamoDBDocumentClient.from(
      new DynamoDBClient({
        region: process.env.AWS_REGION || "us-east-2",
        ...(endpoint
          ? {
              endpoint,
              credentials: { accessKeyId: "local", secretAccessKey: "local" },
            }
          : {}),
      }),
      { marshallOptions: { removeUndefinedValues: true } },
    );
  }
  async get(k: Key) {
    return (
      await this.client.send(
        new GetCommand({ TableName: this.table, Key: k, ConsistentRead: true }),
      )
    ).Item as Row | undefined;
  }
  async query(
    pk: string,
    o: {
      prefix?: string;
      cursor?: Key;
      limit?: number;
      reverse?: boolean;
      index?: "GSI1" | "GSI2";
    } = {},
  ) {
    const a = o.index === "GSI1" ? "gsi1" : o.index === "GSI2" ? "gsi2" : "";
    const r = await this.client.send(
      new QueryCommand({
        TableName: this.table,
        IndexName: o.index,
        ConsistentRead: !o.index,
        KeyConditionExpression: `#p = :p${o.prefix ? " AND begins_with(#s,:s)" : ""}`,
        ExpressionAttributeNames: {
          "#p": `${a}pk`,
          ...(o.prefix ? { "#s": `${a}sk` } : {}),
        },
        ExpressionAttributeValues: {
          ":p": pk,
          ...(o.prefix ? { ":s": o.prefix } : {}),
        },
        Limit: Math.min(o.limit || 100, 100),
        ScanIndexForward: !o.reverse,
        ExclusiveStartKey: o.cursor,
      }),
    );
    return {
      items: (r.Items || []) as Row[],
      cursor: r.LastEvaluatedKey as Key | undefined,
    };
  }
  async commit(changes: Change[]) {
    changes = appendActivityEvents(changes, this.integration);
    if (!changes.length) return;
    try {
      await this.client.send(
        new TransactWriteCommand({
          TransactItems: changes.map((c) => {
            const condition = c.before
              ? {
                  ConditionExpression: "#v = :v",
                  ExpressionAttributeNames: { "#v": "v" },
                  ExpressionAttributeValues: { ":v": c.before.v },
                }
              : { ConditionExpression: "attribute_not_exists(pk)" };
            if (c.checkOnly)
              return {
                ConditionCheck: {
                  TableName: this.table,
                  Key: c.key,
                  ...condition,
                },
              };
            if (c.after)
              return {
                Put: {
                  TableName: this.table,
                  Item: { ...c.after, v: (c.before?.v || 0) + 1 },
                  ...condition,
                },
              };
            return {
              Delete: { TableName: this.table, Key: c.key, ...condition },
            };
          }),
        }),
      );
    } catch (e: any) {
      if (
        e.name === "TransactionCanceledException" &&
        e.CancellationReasons?.some((r: any) =>
          ["ConditionalCheckFailed", "TransactionConflict"].includes(r.Code),
        )
      )
        throw new Conflict();
      if (e.name === "TransactionConflictException") throw new Conflict();
      throw e;
    }
  }
}
// Tests only; never selected by the application runtime.
export class MemoryStore implements Store {
  constructor(readonly integration?: { orgId: string }) {}
  readonly rows = new Map<string, Row>();
  id(k: Key) {
    return `${k.pk}\u0000${k.sk}`;
  }
  async get(k: Key) {
    return structuredClone(this.rows.get(this.id(k)));
  }
  async query(
    pk: string,
    o: {
      prefix?: string;
      cursor?: Key;
      limit?: number;
      reverse?: boolean;
      index?: "GSI1" | "GSI2";
    } = {},
  ) {
    const a = o.index === "GSI1" ? "gsi1" : o.index === "GSI2" ? "gsi2" : "";
    const items = [...this.rows.values()]
      .filter(
        (r) =>
          r[`${a}pk`] === pk &&
          (!o.prefix || r[`${a}sk`]?.startsWith(o.prefix)),
      )
      .sort((x, y) => x[`${a}sk`].localeCompare(y[`${a}sk`]));
    if (o.reverse) items.reverse();
    const start = o.cursor
      ? items.findIndex((r) => this.id(r) === this.id(o.cursor!)) + 1
      : 0;
    const page = items.slice(start, start + (o.limit || 100));
    return {
      items: structuredClone(page),
      cursor:
        items.length > start + page.length
          ? { pk: page.at(-1)!.pk, sk: page.at(-1)!.sk }
          : undefined,
    };
  }
  async commit(cs: Change[]) {
    cs = appendActivityEvents(cs, this.integration);
    for (const c of cs) {
      const r = this.rows.get(this.id(c.key));
      if (c.before ? r?.v !== c.before.v : !!r) throw new Conflict();
    }
    for (const c of cs) {
      if (c.checkOnly) continue;
      if (c.after)
        this.rows.set(
          this.id(c.key),
          structuredClone({ ...c.after, v: (c.before?.v || 0) + 1 }),
        );
      else this.rows.delete(this.id(c.key));
    }
  }
}
export class Tx {
  readonly changes = new Map<string, Change>();
  constructor(readonly store: Store) {}
  async get(k: Key) {
    const id = JSON.stringify(k);
    const c = this.changes.get(id);
    if (c) return c.after;
    const before = await this.store.get(k);
    this.changes.set(id, { key: k, before, after: before, checkOnly: true });
    return before;
  }
  async put(r: Row) {
    const k = { pk: r.pk, sk: r.sk };
    await this.get(k);
    this.changes.get(JSON.stringify(k))!.after = r;
    this.changes.get(JSON.stringify(k))!.checkOnly = false;
  }
  async del(k: Key) {
    await this.get(k);
    this.changes.get(JSON.stringify(k))!.after = undefined;
    this.changes.get(JSON.stringify(k))!.checkOnly = false;
  }
  async commit() {
    // Read checks deliberately participate in the transaction to prevent races with membership, device and event changes.
    await this.store.commit([...this.changes.values()]);
  }
}
export async function atomic<T>(
  store: Store,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  for (let n = 0; n < 12; n++) {
    const tx = new Tx(store);
    try {
      const result = await fn(tx);
      await tx.commit();
      return result;
    } catch (e) {
      if (!(e instanceof Conflict)) throw e;
      await new Promise((r) => setTimeout(r, Math.min(5 * 2 ** n, 80)));
    }
  }
  throw new Fault(409, "Concurrent update; retry the same operation.");
}
export async function all(
  store: Store,
  pk: string,
  options: { prefix?: string; index?: "GSI1" | "GSI2" } = {},
) {
  let cursor: Key | undefined;
  const rows: Row[] = [];
  do {
    const p = await store.query(pk, { ...options, cursor });
    rows.push(...p.items);
    cursor = p.cursor;
  } while (cursor);
  return rows;
}
