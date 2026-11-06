# STATS READER CONTRACT V2

Puncher owns the on-demand canonical table, schema metadata, user accounts, shop sessions, legacy credits, volunteer awards, audit history and all writes. Stats must import an external table reference using Puncher's TableName/TableArn/TableRegion deployment outputs. It must never provision, tag, delete or import this table, acknowledge warnings or expire sessions. Stats has separate frontend/backend/authorizer, OAuth audience, origin, IAM and AppName=Stats tags.

The language-neutral JSON Schema is contracts/stats-reader.v2.json; synthetic records and expected totals are contracts/fixtures/reader-v2.json. Regenerate with `npx tsx scripts/contract.ts`; review/version breaking changes together with Stats. Ignore additive fields. Before serving attendance, read `APP#PUNCHER / SCHEMA`; fail clearly on an absent or unsupported schemaVersion (expected 2) rather than guessing. Record types are identified by both physical keys and status, never by arbitrary numeric fields.

All UTC instants are ISO strings; historical local dates are YYYY-MM-DD. Integer creditedSeconds is the only duration unit. June 1 is included in the ending reportingYear, June 2 starts the next. Shop uses shopDate and volunteer uses eventDate. Only completed shop sessions with checkout strictly before cutoff earn credit. Active visits are logically expired when cutoffAt <= now and never earn estimated time. Forfeited visits always earn zero; earlier completed visits remain. Only approved dated legacy/volunteer rows with valid nonnegative integer durations contribute; null/absent is unknown, not zero. Never sum rollups, current sessions, claims, source data or audit rows as credits.

Discover roster with GSI1 `gsi1pk=USERS`; paginate every DynamoDB query. Query each authorized member's ATTENDANCE#id partition for SHOP#, LEGACYSHOP# and VOLUNTEER# in the Stats backend. Bounded server aggregation is suitable for this team size; avoid full-table scans and browser N+1 requests. Puncher's owner-requested kiosk uses a disposable SUMMARY#SHOP cache for anonymous week/year/all-time shop totals. This cache is writer-internal and never contributes credit or replaces Stats' authorized aggregation. Puncher owns its minute refresh, database lease and source-record reconciliation; see api.md. Stats must ignore every SUMMARY# item.

Look up the verified Google subject at `USER#<sub> / METADATA` and require an active account. Its single `role` is `STUDENT`, `MENTOR` or `ADMIN`. A Student is limited to their own attendance; the Stats backend must apply its approved reporting policy to Mentor and Admin accounts. The v1 identity records and Stats-specific role flags are gone. Switch Stats to the new table outputs together with the reader update.

Example policy for the separately deployed Stats runtime (use exact output ARNs, including both indexes only if actually needed):

```json
{
  "Effect": "Allow",
  "Action": ["dynamodb:GetItem", "dynamodb:BatchGetItem", "dynamodb:Query"],
  "Resource": ["<PuncherTableArn>", "<PuncherTableArn>/index/GSI1"]
}
```

No PutItem, UpdateItem, DeleteItem, BatchWriteItem or TransactWriteItems grant. Table IAM is a trusted server boundary; it does not implement each student's visibility. Authorize before data retrieval and return explicit DTOs. Never return raw table items, card numbers, emails, role/device hashes or legacy sources to students. Never accept a Puncher kiosk credential or assume a Puncher client ID token is valid for Stats.

Writer-internal keys include CARD#, DEVICE#, OP#, RATE#, ACTIVE, AUDIT, IMPORT#, REVIEWS and ATTENDANCE#id / CURRENT. Operations use caller-scoped payload-bound IDs; response windows expire after 24 hours but durable tombstones remain and expired replay fails closed. Rate records alone use TTL. SOURCE records and import provenance are private operational data. The machine schema accepts extra properties for compatibility, which does not authorize DTO disclosure.

DynamoDB table charges belong to Puncher even when Stats originates reads. AppName tags cannot divide a single table's cost by caller. Stats compute/CDN/API charges belong to Stats; Route 53 hosted zone and account-level support remain owned by the existing team infrastructure. Do not duplicate the database for billing.
