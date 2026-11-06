# LOCAL DEVELOPMENT

Use Node 24 or newer, npm, and Docker Desktop. From this repository:

```powershell
npm ci
Copy-Item .env.example .env
docker compose up -d
docker compose exec -u 0 dynamodb chown -R 1000:1000 /home/dynamodblocal/data
npm run db:init
npm run seed
npm run dev
```

Open http://localhost:5173; the kiosk is http://localhost:5173/kiosk. The API binds to 127.0.0.1:3000. Local fixture buttons provide synthetic administrator, mentor and member accounts only when APP_ENV=local, a loopback DynamoDB endpoint is set, and no Lambda runtime is present. Open Start kiosk on the scanner device. Sign in as Local mentor in a separate window and generate the activation QR. Use Local student to display the synthetic attendance barcode. Use Local mentor administrator to edit member roles. Cards 000123 and 000456 belong to fictional students. There is no browser-storage attendance database. Re-seeding preserves attendance; use an isolated table for tests.

Without Docker, download the official DynamoDB Local distribution from https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/DynamoDBLocal.DownloadingAndRunning.html and run Java 17+ with the native library path:

```powershell
java '-Djava.library.path=./work/dynamodb/DynamoDBLocal_lib' -jar work/dynamodb/DynamoDBLocal.jar -inMemory -sharedDb -port 8000
```

This implementation was exercised using the official DynamoDB Local 1.25.1 distribution and the installed JDK 17. Docker is absent on the implementation machine; the Java path supplied the actual database tests. A newer downloaded distribution may require a newer JDK. Persistent Docker storage is recommended for ongoing development.

```powershell
npm run build
npm run cdk:synth
npm test
npm run test:db
npx playwright install chromium
npm run test:browser
```

CDK validation values synthesize only; never deploy validation output. Browser tests require the seeded local table and start/stop their own API/UI servers. The browser-test API server forces `APP_ENV=local` and `LOCAL_AUTH_FIXTURES=true` so a local Google-auth setting in `.env` does not disable synthetic test accounts; the local DynamoDB endpoint and table still come from `.env` (or the CI environment). `npm run test:db` creates randomly named local-only tables and removes only those tables. Domain clocks are injectable. Screenshots and traces are under ignored work/ and test-results/.

For real local Google sign-in, set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` for a Google OAuth web client with `http://localhost:5173/api/auth/callback` as an authorized redirect URI; set `LOCAL_AUTH_FIXTURES=false`. Use the callback origin `http://localhost:5173`, not the API's listening port. Provision its verified subject with the operational command. Production and local authentication call the same verification and mapping code. The CDK configuration deploys only the production environment; local development and CI use DynamoDB Local and must not point at the production table.

To test the Google Wallet link locally, follow the issuer, service-account, and Generic class setup in [deployment.md](deployment.md#google-wallet-attendance-pass-setup), including running `npm run wallet:create-class -- ISSUER_ID.CLASS_SUFFIX` with the service-account JSON in `.env`. Set `GOOGLE_WALLET_CLASS_ID` to that same full class ID and keep the JSON private; blank values keep the link hidden. Do not commit `.env`.
