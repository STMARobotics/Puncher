# PUNCHER

For Google sign-in, member roles and attendance cards, see the [mentor workflow](docs/mentor-roster.md).

Cross-app integration foundation and rollout: [app harmonization](docs/app-harmonization.md).

STMA Robotics / FRC Team 7028 shop timeclock, outreach and competition attendance, and operational administration. AWS-hosted with DynamoDB. Stats is a separate read-only application.

Start with [local development](docs/local-development.md). Node 24+, npm and DynamoDB Local are required. Copy .env.example to .env, start `docker compose up -d`, then run `npm ci`, `npm run db:init`, `npm run seed`, and `npm run dev`. Open http://localhost:5173 and select Start kiosk. Generate an activation QR as a local mentor in a separate window. Synthetic card mappings: 000123 and 000456.

- [Architecture and FMEA inspection](docs/architecture.md)
- [Deployment, authentication, provisioning, billing](docs/deployment.md)
- [Kiosk setup, recovery and physical acceptance](docs/kiosk-and-acceptance.md)
- [Stats reader v2 contract](docs/stats-integration.md)
- [Machine-readable schemas](contracts/stats-reader.v2.json) and [synthetic fixtures](contracts/fixtures/reader-v2.json)

Checks: `npm run build`, `npm run cdk:synth`, `npm test`, `npm run test:db`, `npm run test:browser`. See docs for local setup and the single production configuration. Physical NSA5/student cards, production Google/AWS settings and midnight operation require manual acceptance before launch. See docs/verification.md for recorded test results and limitations.
