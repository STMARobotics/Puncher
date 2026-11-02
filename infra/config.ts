export type Config = {
  account: string;
  environment: string;
  domain: string;
  zoneName: string;
  zoneId: string;
  googleClientId: string;
  statsUrl: string;
  repository: string;
};
export function config(context: Record<string, any>): Config {
  const test = context.validation === true || context.validation === "true";
  const env = process.env;
  const c = {
    account:
      env.PUNCHER_ACCOUNT || context.account || (test ? "111111111111" : ""),
    environment: env.PUNCHER_ENV || context.environment || "dev",
    domain: env.PUNCHER_DOMAIN || context.domain || "puncher.7028robotics.com",
    zoneName: env.PUNCHER_ZONE_NAME || context.zoneName || "7028robotics.com",
    zoneId:
      env.PUNCHER_ZONE_ID || context.zoneId || (test ? "ZVALIDATIONONLY" : ""),
    googleClientId:
      env.GOOGLE_CLIENT_ID ||
      context.googleClientId ||
      (test ? "validation-only.apps.googleusercontent.com" : ""),
    statsUrl:
      env.STATS_URL || context.statsUrl || "https://stats.7028robotics.com",
    repository:
      env.PUNCHER_GITHUB_REPOSITORY ||
      context.repository ||
      (test ? "EXAMPLE/Puncher" : ""),
  };
  for (const [k, v] of Object.entries(c))
    if (!v)
      throw new Error(
        `Missing explicit Puncher configuration: ${k}. See docs/deployment.md; use -c validation=true only for non-deployable synthesis.`,
      );
  if (!["dev", "prod"].includes(c.environment))
    throw new Error("Environment must be dev or prod.");
  return c;
}
