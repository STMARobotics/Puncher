# STATS READER CONTRACT V1

Puncher owns the on-demand canonical table, schema metadata, member/identity mappings, shop sessions, legacy credits, volunteer awards, audit history and all writes. Stats must import an external table reference using Puncher's TableName/TableArn/TableRegion deployment outputs. It must never provision, tag, delete or import this table, acknowledge warnings or expire sessions. Stats has separate frontend/backend/authorizer, OAuth audience, origin, IAM and AppName=Stats tags.

The language-neutral JSON Schema is contracts/stats-reader.v1.json; synthetic records and expected totals are contracts/fixtures/reader-v1.json. Regenerate with `npx tsx scripts/contract.ts`; review/version breaking changes together with Stats. Ignore additive fields. Before serving attendance, read `APP#PUNCHER / SCHEMA`; fail clearly on an absent/unsupported schemaVersion rather than guessing. Record types are identified by both physical keys and status, never by arbitrary numeric fields.

All UTC instants are ISO strings; historical local dates are YYYY-MM-DD. Integer creditedSeconds is the only duration unit. June 1 is included in the ending reportingYear, June 2 starts the next. Shop uses shopDate and volunteer uses eventDate. Only completed shop sessions with checkout strictly before cutoff earn credit. Active visits are logically expired when cutoffAt <= now and never earn estimated time. Forfeited visits always earn zero; earlier completed visits remain. Only approved dated legacy/volunteer rows with valid nonnegative integer durations contribute; null/absent is unknown, not zero. Never sum rollups, current sessions, claims, source data or audit rows as credits.

Discover roster with GSI1 `gsi1pk=MEMBERS`; paginate every DynamoDB query. Query each authorized member's MEMBER#id partition for SHOP#, LEGACYSHOP# and VOLUNTEER# in the Stats backend. Bounded server aggregation is suitable for this team size; avoid full-table scans and browser N+1 requests. Puncher's owner-requested kiosk uses a disposable SUMMARY#SHOP cache for anonymous week/year/all-time shop totals. This cache is writer-internal and never contributes credit or replaces Stats' authorized aggregation. Puncher owns its minute refresh, database lease and source-record reconciliation; see api.md. Stats must ignore every SUMMARY# item.

The optional roles `stats:student` and `stats:staff` explicitly authorize Stats reads when its own verified Google subject maps to an enabled IDENTITY record. Student access also requires an active linked member and is limited to that member. `stats:staff` permits the team's approved staff reporting scope. Puncher mentor/admin alone do not imply these Stats permissions. Stats must recheck enabled mappings without unsafe authorizer caching. A student cannot link a member by submitting a card or member ID. Puncher admins provision exact verified Google subjects and transactional member binding claims; exports' User fields never become credentials.

Example policy for the separately deployed Stats runtime (use exact output ARNs, including both indexes only if actually needed):

```json
{
  "Effect": "Allow",
  "Action": ["dynamodb:GetItem", "dynamodb:BatchGetItem", "dynamodb:Query"],
  "Resource": ["<PuncherTableArn>", "<PuncherTableArn>/index/GSI1"]
}
```

No PutItem, UpdateItem, DeleteItem, BatchWriteItem or TransactWriteItems grant. Table IAM is a trusted server boundary; it does not implement each student's visibility. Authorize before data retrieval and return explicit DTOs. Never return raw table items, card numbers, emails, role/device hashes or legacy sources to students. Never accept a Puncher kiosk credential or assume a Puncher client ID token is valid for Stats.

Writer-internal keys include CARD#, BINDING#, DEVICE#, OP#, RATE#, ACTIVE, AUDIT, IMPORT#, REVIEWS and MEMBER#id / CURRENT. Operations use caller-scoped payload-bound IDs; response windows expire after 24 hours but durable tombstones remain and expired replay fails closed. Rate records alone use TTL. SOURCE records and import provenance are private operational data. The machine schema accepts extra properties for compatibility, which does not authorize DTO disclosure.

DynamoDB table charges belong to Puncher even when Stats originates reads. AppName tags cannot divide a single table's cost by caller. Stats compute/CDN/API charges belong to Stats; Route 53 hosted zone and account-level support remain owned by the existing team infrastructure. Do not duplicate the database for billing.
