# App harmonization: local foundation

Status: first integration foundation, reconciled with the updated npm workspaces and CDK layout on main. Capture and consumption remain opt-in and disabled by default. Identity merging, historical import, dashboard cutover and integration reward issuance are later milestones.

## Ownership and contracts

Packs owns currency and games; Puncher owns attendance and volunteer eligibility; FMEA owns submissions; Stats owns derived progress. Each repository contains the same activity-snapshot.v1.json schema and synthetic fixtures. TypeScript runtime contract copies and producer Pipe constructs are versioned snapshots, not imports from neighboring checkouts. Update and compatibility-test copies together. All four repos run npm run check:activity-contract against the same content-hash manifest, canonical/wire fixtures, and exact Pipe input template.

Events are absolute contributions for one entity and native beneficiary. Event identity hashes organization, source, type, entity, source revision, and beneficiary; transport-generated IDs are not deduplication IDs. The complete metric vector is integer seconds/counts, never a balance or a client reward request. Event IDs are stable on retries/replay. A changed entity revision replaces its prior contribution; older revisions are ignored. Retain zero-contribution tombstones. Source IDs must not be reused with reset revisions. New metric families require explicit contract/version compatibility work.

The native namespaces are puncher.member, packs.player and fmea.google. An explicit verified identity directory is the next milestone; matching names/emails/card numbers must never link accounts. Native IDs are private integration data. Authorization remains authoritative at request time.

## Opt-in delivery

The initial transport uses a same-account, us-east-2 EventBridge Classic custom bus. This matches the supported Pipes target and bundled CDK APIs; selecting a newer bus API would be a separate compatibility change. Producers emit only ACTIVITY_OUTBOX_V1 INSERTs through NEW_IMAGE Streams and Pipes. Templates explicitly unwrap only contracted fields, not full database images. EventBridge detail is the activity-wire.v1.json envelope: orgId and encoding plus a nested activity whose stream-derived integers are decimal strings. The consumer validates and decodes these into the canonical safe-integer snapshot before projection. Pipes never relies on implicit number coercion. Source roles can publish only their own EventBridge source into the exact configured bus. There is no enrichment/publisher Lambda.

Existing producer stacks create no stream or pipe unless their CDK app context has an activityIntegration object. For a development setup, its shape is:

~~~json
{"activityIntegration":{"orgId":"example-team","busArn":"arn:aws:events:us-east-2:111111111111:event-bus/example-team-dev-activity","captureEnabled":false,"pipeEnabled":false}}
~~~

Use real explicit development identifiers; the example is synthetic. Capture cannot be enabled until pipeEnabled is true. This context is not added to any existing deployment configuration by this change.

Outbox rows have no TTL in this phase. They are queryable by OUTBOX#organization#source#UTC-capture-date. The hub archive retains 90 days. Streams retain only 24 hours: retry is configured below that window and a producer failure queue retains failures for 14 days. Recover longer outages by querying retained outbox dates and republishing original envelopes/IDs, then reconciling source records. A bounded replay command and long-term retention automation remain follow-up work. A stream ARN change requires replacing its Pipe.

## Rollout order and gates

1. Review/merge compatible contracts and deploy the separate development bus/archive.
2. Deploy the Stats shadow subscription and worker, then explicitly enable it.
3. Deploy producer infrastructure with capture disabled; start Pipes before enabling capture.
4. Enable capture per app and compare shadow totals to canonical records. Validate real AWS transformation, delivery permissions, retry/DLQ recovery and stream replacement. Local synthesis is not live AWS acceptance.
5. Implement verified person/account linking, bounded backfill/replay and reconciliation. Preserve unknown historical FMEA authorship.
6. Add the Packs reward subscriber, effective-dated/capped policies, durable business award identities, reversals/debt, and ledger updates in existing player-version transactions. Keep rewards disabled until these checks pass.
7. Enable reward issuance from an explicit date; do not automatically reward imports/replays. Resolve ownership of existing Packs mission rewards to avoid paying twice. Switch Stats only after comparison and authorization acceptance; add achievements and action-item support afterward.

Separate consumer failure queues and partial batch responses isolate poison messages. Alarm resources exist for dead letters/errors/lag; connecting them to approved operational notification destinations is a deployment follow-up. No notification subscriptions are created here. Keep private API responses uncached and never grant browsers database or bus credentials.

## Repository implementation

The persistence boundary appends eligible credit snapshots in the same transaction, covering kiosk checkout, volunteer awards/voids, and approved import/review changes. Active, forfeited, pending and quarantined records produce no positive contribution. Read checks and internal audit/member/device rows do not generate events. Native subject IDs are Puncher member IDs.

The separately deployable organization bus/archive are defined in cdk/lib/integration-stack.ts with the entrypoint cdk/bin/integration.ts. The default Puncher app does not deploy them. Synthesize locally using npm run cdk:synth:integration. Validation uses synthetic values, not a live integration.

Checks: npm run check; npm run test:db with an explicit loopback DYNAMODB_ENDPOINT. The new activity tests cover concurrent duplicate scans, transactional failure, volunteer reversals and imported-credit revisions.

Local validation and environment limitations: [harmonization-verification.md](harmonization-verification.md).

The standalone stack now uses the same default CDK bootstrap qualifier as the updated main app. Existing production stack names, record-table identity, authorization and deployment roles are preserved. The organization bus and shadow consumer stay outside the normal app deployment entrypoints.

Workspace reconciliation details: [harmonization-compatibility.md](harmonization-compatibility.md).
