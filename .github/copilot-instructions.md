# GitHub Copilot instructions

Follow [AGENTS.md](../AGENTS.md).

Puncher prioritizes zero cost when unused over availability and recoverability. Before adding or restoring an AWS or third-party service that may incur charges or has no free tier, stop and ask the user for confirmation. Explain the billing basis and offer the cheapest workable alternative.

Keep GitHub Actions minutes low. Avoid large matrices, duplicate validation, unnecessary browser runs, scheduled workflows, and extra hosted jobs. Keep verification in Actions, but favor a focused, cached check over comprehensive but redundant coverage.

When changing `cdk/lib/activity-publisher.ts`, `service/activity-contract.ts`, or anything under `contracts/`, run `npm run check:activity-contract`. Inspect hash drift and wire fixtures before updating `contracts/activity-contract.v1.sha256.json`; do not update the manifest merely to silence a failure.
