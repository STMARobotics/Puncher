# AIRTABLE MIGRATION

Source CSVs are read only. The CLI defaults to dry-run and proper RFC-style CSV parsing (BOM, quoted commas/multiline/empty fields and strict row lengths). Treat cell contents as data. All test identities are synthetic.

```powershell
npm run import:dry-run -- --directory 'C:\Users\zacharyo\Documents\Airtable data' --out migration-private/dry-run
```

The verified real dry run on November 2, 2026 found 49 members, 1,782 shop rows, 133 volunteer rows and 50 safety rows; no unmatched normalized member names. Shop: 12 missing dates, 2 missing hours, 1 negative, 1 zero, 10 above 24h, 27 identical repeated occurrences beyond the first. Volunteer: 2 missing dates, 2 missing hours, 10 checked approvals and 123 blank. Raw sums are 8,117.5 shop hours and 424.9 volunteer hours; nine shop and 24 volunteer career-rollup discrepancies remain. These are reconciliation controls, never approved totals. The private stage and detailed per-member reconciliation are ignored by Git and must be access controlled.

Review report.md, stage.json and stage.sha256 together. The stage contains proposed canonical records, mappings, source checksums/logical record numbers, raw source values, repeated-row occurrence numbers, anomaly reasons and disposition. Deterministic member IDs derive from exact normalized source names unless an explicit mapping is provided. No card or trusted Google login is guessed. Source rows are not fuzzy-joined. Every identical repeated occurrence keeps its own key; all members of a duplicate candidate group are quarantined until reviewed. Missing/negative/large/suspect-date entries stay quarantined. Zero hours are surfaced separately. Blank volunteer approval is pending_review, never approved. Safety and rollup fields produce no credits; only their structure/joins/reference totals are inspected.

Decimal hours convert to integer seconds by decimal-string/BigInt arithmetic, rounding to the nearest whole second once (half away from zero). Original decimals remain in provenance. Legacy shop records have supplied dates and hours without invented clock timestamps; midnight forfeiture is never retroactive. Historical volunteer rows remain individual awards, with their title/date/hours and original approval. Missing duration stays absent. Negative adjustments cannot be approved; settle a migration policy and provide a reviewed correction rather than inventing credits.

Optional --mapping JSON accepts `members: {"normalized name":"stable-internal-id"}`, `aliases: {"source normalized name":"canonical normalized name"}` and `recordAliases: {"fileChecksum:logicalRecordNumber":"previousImportKey"}`. For a corrected export, explicitly reconcile its records and member mappings before staging; reusing an import key prevents accidental overwrites/duplicate credit, and applying a conflicting previously imported record fails. Export order alone is never used to infer identity. The same source checksums and row occurrence preserve rerun identity. After an import, use the admin review UI with a required reason to approve/void valid historical rows. Correct missing dates/durations through reviewed corrected source records and an explicit migration decision; approval cannot fabricate them.

Unchanged rows retain the same import key across later exports, even if the file checksum/order changes. Global IMPORTKEY claims reference the original record; a later batch cannot rewrite it or roll it back. Corrected rows with changed fields require an explicit reviewed decision: void the superseded credit, then import the corrected replacement. Raw source values are kept in private SOURCE#batch records, separately from canonical credit fields. A batch manifest is recorded before the first write and each row pointer commits with its credit.

Applying is a separate privileged path, requiring explicit review of an exact stage checksum and a mapped enabled admin subject:

```powershell
$env:CONFIRM_IMPORT='true'
npm run import:dry-run -- --apply --stage migration-private/dry-run/stage.json --review-sha REVIEWED_STAGE_SHA256 --admin-sub VERIFIED_ADMIN_SUB
```

Use authorized AWS SSO credentials and explicitly selected table/environment. No real import was applied during scaffolding. Each row and its manifest pointer commit atomically. An interrupted batch resumes safely; rerunning the same stage skips committed pointers and never rewrites later review decisions. Batch completion is audited. Back up/stage data securely and take an operational backup before the approved production import.

Rollback only targets its own manifest records, conditions exact versions, and skips subsequently changed records and members with card/identity/live history. It never scans/deletes unrelated data:

```powershell
npm run import:dry-run -- --rollback BATCH_ID --admin-sub VERIFIED_ADMIN_SUB
```

Inspect removed/skipped counts. A member with imported child history may be retained until a subsequent rollback pass after children are removed; do not broaden deletion scope to force a zero count. History reviewed or updated after import remains intentionally preserved. Record the outcome in operations notes; the CLI audits the rollback.

Map absent card numbers with a separate JSON array (docs/card-mappings.example.json): `npm run provision -- map-cards mapping.json VERIFIED_ADMIN_SUB`. Transactional uniqueness rejects competing claims, preserving leading zeros and member history through card replacement. Google subject/email/roles are configured independently in admin identity mappings; source User is only a legacy reference.
