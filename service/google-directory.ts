import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import { JWT } from "google-auth-library";
import { assert } from "./model";
import type { DirectoryPerson } from "./roster";

export const directoryScope =
  "https://www.googleapis.com/auth/admin.directory.user.readonly";
type Settings = { domain: string; delegatedAdmin: string; secretArn: string };
export async function readGoogleDirectory(
  settings: Settings,
  dependencies: {
    readSecret?: () => Promise<string>;
    fetchPage?: typeof fetch;
    accessToken?: (credentials: {
      client_email: string;
      private_key: string;
    }) => Promise<string>;
  } = {},
): Promise<DirectoryPerson[]> {
  assert(
    settings.domain === "stmarobotics.org" &&
      /^[^@\s]+@stmarobotics\.org$/.test(settings.delegatedAdmin) &&
      settings.secretArn.length > 0,
    "Google roster connection is not configured.",
    503,
  );
  const readSecret =
    dependencies.readSecret ??
    (async () => {
      const result = await new SecretsManagerClient({}).send(
        new GetSecretValueCommand({ SecretId: settings.secretArn }),
      );
      assert(
        result.SecretString,
        "Google roster credential is unavailable.",
        503,
      );
      return result.SecretString;
    });
  const credentials = JSON.parse(await readSecret());
  assert(
    credentials.type === "service_account" &&
      typeof credentials.client_email === "string" &&
      credentials.client_email.endsWith(".iam.gserviceaccount.com") &&
      typeof credentials.private_key === "string",
    "Invalid Google roster credential.",
    503,
  );
  const token = await (
    dependencies.accessToken ??
    (async (c) => {
      const auth = new JWT({
        email: c.client_email,
        key: c.private_key,
        subject: settings.delegatedAdmin,
        scopes: [directoryScope],
      });
      const result = await auth.getAccessToken();
      assert(result.token, "Google roster authorization failed.", 503);
      return result.token;
    })
  )(credentials);
  const people: DirectoryPerson[] = [],
    tokens = new Set<string>();
  let pageToken: string | undefined;
  for (let page = 0; page < 100; page++) {
    const url = new URL(
      "https://admin.googleapis.com/admin/directory/v1/users",
    );
    url.searchParams.set("domain", settings.domain);
    url.searchParams.set("maxResults", "500");
    url.searchParams.set("projection", "basic");
    url.searchParams.set("viewType", "admin_view");
    url.searchParams.set(
      "fields",
      "nextPageToken,users(id,primaryEmail,name/fullName,suspended,archived)",
    );
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const response = await (dependencies.fetchPage ?? fetch)(url, {
      headers: { Authorization: "Bearer " + token },
      signal: AbortSignal.timeout(20000),
      redirect: "error",
    });
    assert(response.ok, "Google Directory could not be read.", 503);
    const data = (await response.json()) as any;
    assert(
      data && (!data.users || Array.isArray(data.users)),
      "Invalid Google Directory response.",
      503,
    );
    for (const user of data.users ?? []) {
      assert(
        typeof user.id === "string" &&
          typeof user.primaryEmail === "string" &&
          user.name &&
          typeof user.name.fullName === "string" &&
          typeof user.suspended === "boolean" &&
          (user.archived === undefined || typeof user.archived === "boolean"),
        "Incomplete Google Directory user.",
        503,
      );
      people.push({
        id: user.id,
        email: user.primaryEmail.toLowerCase(),
        displayName: user.name.fullName.trim().slice(0, 100),
        active: !user.suspended && user.archived !== true,
      });
    }
    assert(
      people.length <= 10000,
      "Directory exceeds the configured roster size limit.",
      503,
    );
    if (!data.nextPageToken) return people;
    assert(
      typeof data.nextPageToken === "string" && !tokens.has(data.nextPageToken),
      "Invalid directory pagination.",
      503,
    );
    pageToken = data.nextPageToken;
    tokens.add(pageToken!);
  }
  throw new Error("Directory pagination limit exceeded.");
}
