# Puncher agent instructions

## Cost and availability priority

Puncher is a low-priority application. Low idle cost is more important than availability and recoverability.

- Keep the serverless/on-demand architecture. Prefer DynamoDB on-demand, Lambda, HTTP API Gateway, S3, CloudFront, and the existing single schedule.
- Never add provisioned DynamoDB capacity, RDS/Aurora, ElastiCache, OpenSearch, ECS/Fargate, EC2, NAT gateways, WAF, VPC endpoints, paid observability, or other always-on or per-hour billed infrastructure.
- Do not add SNS topics, CloudWatch alarms, detailed API metrics, SQS/DLQs, DynamoDB PITR, DynamoDB/Events exports or archives, or long-lived log retention for observability/recovery. These are intentionally out of scope unless the user confirms them.
- Before proposing or adding any AWS or third-party service that has no free tier or may incur ongoing/usage charges, stop and ask the user for confirmation. Present the service, estimated billing basis, and a lower-cost alternative. Do not proceed on assumption.

## GitHub Actions

- Keep CI and deploy workflows as small as practical. GitHub Action minutes are a constrained resource.
- Lean toward lower action minutes over comprehensive validation: run only checks that cover the changed area, and avoid duplicate jobs/checkouts/builds.
- Verification belongs in Actions, not on the developer machine. Prefer cached dependencies and a single validation job.
- Do not run browser, database, or cross-app integration tests for documentation-only changes.
- Do not add matrices, self-hosted/hosted workers, scheduled workflows, repeated builds, or broad monorepo rebuilds without confirmation.
- Cancel superseded runs and avoid testing feature-branch pushes; pull requests and `main` are the normal verification surfaces.

## Shared contracts

- Whenever changing `cdk/lib/activity-publisher.ts`, `service/activity-contract.ts`, or anything under `contracts/`, run `npm run check:activity-contract`.
- Treat `contracts/activity-contract.v1.sha256.json` as an implementation-locked contract. If the publisher hash changes, inspect the event/template/filter diff and update the manifest only after confirming the actual activity wire contract is still correct.
- Do not only run or update the hash check: preserve or update the fixture and round-trip assertions in `scripts/check-activity-contract.cjs` when wire behavior changes.
