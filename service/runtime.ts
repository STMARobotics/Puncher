import { DynamoStore } from "./store";
import { Fault, assert } from "./model";
export function runtime() {
  const local = process.env.APP_ENV === "local";
  const endpoint = process.env.DYNAMODB_ENDPOINT;
  const fixtures = process.env.LOCAL_AUTH_FIXTURES === "true";
  const rosterLocalFixtures = process.env.LOCAL_ROSTER_FIXTURES === "true";
  if (endpoint) {
    const u = new URL(endpoint);
    assert(
      local && ["127.0.0.1", "localhost"].includes(u.hostname),
      "DynamoDB endpoint requires isolated local mode.",
      500,
    );
  }
  if (fixtures)
    assert(
      local && !!endpoint && !process.env.AWS_LAMBDA_FUNCTION_NAME,
      "Development auth is forbidden outside DynamoDB Local.",
      500,
    );
  if (rosterLocalFixtures)
    assert(
      local && fixtures && !!endpoint && !process.env.AWS_LAMBDA_FUNCTION_NAME,
      "Roster fixtures are forbidden outside DynamoDB Local.",
      500,
    );
  assert(
    process.env.TABLE_NAME,
    "TABLE_NAME must be explicitly configured.",
    500,
  );
  if (!local)
    assert(
      process.env.APP_ENV === "prod",
      "APP_ENV must be local or prod.",
      500,
    );
  if (local)
    assert(!!endpoint, "Local mode requires a local DynamoDB endpoint.", 500);
  return {
    local,
    fixtures,
    rosterLocalFixtures,
    endpoint,
    table: process.env.TABLE_NAME!,
    origin: process.env.ALLOWED_ORIGIN || "http://localhost:5173",
    googleClientId: process.env.GOOGLE_CLIENT_ID || "",
    googleClientSecretParameter:
      process.env.GOOGLE_CLIENT_SECRET_PARAMETER || "",
    statsUrl: process.env.STATS_URL || "https://stats.7028robotics.com",
  };
}
let singleton: DynamoStore;
export function store() {
  const c = runtime();
  return (singleton ??= new DynamoStore(c.table, c.endpoint));
}
export function publicConfig() {
  const c = runtime();
  return {
    googleClientId: c.googleClientId,
    allowedDomain: "stmarobotics.org",
    timezone: "America/Chicago",
    statsUrl: c.statsUrl,
    localFixtures: c.fixtures,
    rosterSyncAvailable:
      !!process.env.ROSTER_SYNC_QUEUE_URL || c.rosterLocalFixtures,
  };
}
