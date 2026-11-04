import { expect, it } from "vitest";
import {
  readGoogleDirectory,
  directoryScope,
} from "../service/google-directory";
const settings = {
  domain: "stmarobotics.org",
  delegatedAdmin: "reader@stmarobotics.org",
  secretArn: "synthetic-secret",
};
const readSecret = async () =>
  JSON.stringify({
    type: "service_account",
    client_email: "reader@synthetic.iam.gserviceaccount.com",
    private_key: "synthetic-key",
  });
const accessToken = async () => "synthetic-token";
const user = (id: string, suspended = false) => ({
  id,
  primaryEmail: id + "@stmarobotics.org",
  name: { fullName: "Name " + id },
  suspended,
});
it("reads every page using the narrow read-only endpoint and maps suspension/archival", async () => {
  const urls: URL[] = [];
  const people = await readGoogleDirectory(settings, {
    readSecret,
    accessToken,
    fetchPage: (async (input: any, init: any) => {
      const url = new URL(String(input));
      urls.push(url);
      expect(init.headers.Authorization).toBe("Bearer synthetic-token");
      expect(init.redirect).toBe("error");
      return Response.json(
        url.searchParams.has("pageToken")
          ? { users: [user("two", true), { ...user("three"), archived: true }] }
          : { users: [user("one")], nextPageToken: "next" },
      );
    }) as typeof fetch,
  });
  expect(people.map((p) => p.active)).toEqual([true, false, false]);
  expect(urls).toHaveLength(2);
  expect(urls[0].origin).toBe("https://admin.googleapis.com");
  expect(urls[0].searchParams.get("domain")).toBe(settings.domain);
  expect(urls[1].searchParams.get("pageToken")).toBe("next");
  expect(directoryScope).toBe(
    "https://www.googleapis.com/auth/admin.directory.user.readonly",
  );
});
it("rejects a partial page failure, repeated pagination and incomplete user data", async () => {
  for (const mode of ["partial", "repeat", "malformed"]) {
    let calls = 0;
    await expect(
      readGoogleDirectory(settings, {
        readSecret,
        accessToken,
        fetchPage: (async () => {
          calls++;
          if (mode === "partial" && calls === 2)
            return new Response("denied", { status: 403 });
          return Response.json(
            mode === "malformed"
              ? { users: [{ id: "incomplete" }] }
              : { users: [user("one")], nextPageToken: "same" },
          );
        }) as typeof fetch,
      }),
    ).rejects.toThrow();
  }
});
it("validates credentials and domain before making an external request", async () => {
  let fetched = false;
  const dependencies = {
    readSecret: async () => "{}",
    accessToken,
    fetchPage: (async () => {
      fetched = true;
      return Response.json({});
    }) as typeof fetch,
  };
  await expect(readGoogleDirectory(settings, dependencies)).rejects.toThrow(
    "credential",
  );
  await expect(
    readGoogleDirectory({ ...settings, domain: "other.org" }, dependencies),
  ).rejects.toThrow("configured");
  expect(fetched).toBe(false);
});
