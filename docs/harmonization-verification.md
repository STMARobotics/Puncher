# Harmonization verification

Verified locally on 2026-11-04 for the opt-in activity foundation, contract revision activity-v1-foundation-1. No remote CI, deployment, production event delivery, account linking or reward issuance is claimed.

- All four repositories pass npm run check:activity-contract: matching canonical/wire fixtures, stable event identities, exact Pipe field mapping, and shared implementation hashes.
- A cross-checkout smoke test exercised Puncher checkout plus volunteer award/void through the actual producer transformer and Stats batch consumer. Duplicate and reverse-order delivery preserved shop credit and removed volunteer credit.
- git diff --check passed. Integration settings remain absent from existing deployment configurations.

Production enablement requires the development AWS acceptance sequence in app-harmonization.md, including IAM and Pipe transformation, retry/DLQ recovery, stream replacement and canonical reconciliation. Verified identity linking, reward policies/ledger consumer, historical import, replay tooling and dashboard cutover are later milestones.

## Puncher checks

- npm run check passed: type checking, frontend and service builds, 50 tests, and existing deployment synthesis.
- npm run cdk:synth:integration passed for the separate organization bus/archive with synthetic configuration.
- npm run test:db passed against disposable DynamoDB Local: seven tests, including concurrent duplicate checkout and volunteer award/void with exactly three transactional outbox records.
- Tests cover credit correction snapshots, imports, capture defaults, organization/source IAM boundaries, Pipe configuration, archive retention and no implicit deployment.
- CI now also checks shared contracts and synthesizes the organization integration stack. Existing browser checks remain in CI; they were not rerun for this backend foundation.
