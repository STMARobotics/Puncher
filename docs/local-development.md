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

Open http://localhost:5173; the kiosk is http://localhost:5173/kiosk. The API binds to 127.0.0.1:3000. Local fixture buttons provide synthetic admin/mentor accounts only when APP_ENV=local, a loopback DynamoDB endpoint is set, and no Lambda runtime is present. The kiosk's synthetic credential is printed by `npm run seed`. Cards 000123 and 000456 belong to fictional students. There is no browser-storage attendance database. Re-seeding preserves attendance; use an isolated table for tests.

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

CDK validation values synthesize only; never deploy validation output. Browser tests require the seeded local table and start/stop their own API/UI servers. `npm run test:db` creates randomly named local-only tables and removes only those tables. Domain clocks are injectable. Screenshots and traces are under ignored work/ and test-results/.

For real local Google sign-in, set GOOGLE_CLIENT_ID for an OAuth web client with http://localhost:5173 as an authorized origin; set LOCAL_AUTH_FIXTURES=false. Provision its verified subject with the operational command. Production and local authentication call the same verification and mapping code. The CDK configuration deploys only the production environment; local development and CI use DynamoDB Local and must not point at the production table.
