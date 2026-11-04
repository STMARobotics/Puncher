import { test, expect } from "@playwright/test";

test("restores the authenticated UI from an HttpOnly session cookie after refresh", async ({
  page,
  context,
}) => {
  const sessionValue = "opaque-session-value-for-test";
  await context.addCookies([
    {
      name: "puncher-local-session",
      value: sessionValue,
      url: "http://localhost:5173",
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  await page.route("**/config.json", (route) =>
    route.fulfill({
      json: {
        googleClientId: "test-client",
        statsUrl: "https://stats.example.test",
        localFixtures: false,
      },
    }),
  );
  await page.route("**/api/me", async (route) => {
    expect(route.request().headers().cookie).toContain(
      `puncher-local-session=${sessionValue}`,
    );
    await route.fulfill({
      json: { id: "local-mentor", roles: ["mentor"] },
    });
  });
  await page.route("**/api/events", (route) => route.fulfill({ json: [] }));

  for (let load = 0; load < 2; load++) {
    await page.goto("/");
    await expect(
      page.getByRole("heading", { name: "MENTOR DASHBOARD" }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
    expect(await page.evaluate(() => document.cookie)).not.toContain(
      sessionValue,
    );
  }
});

test("launching from a restored login clears mentor authority before entering the kiosk", async ({
  page,
  context,
}) => {
  await context.addCookies([
    {
      name: "puncher-local-session",
      value: "synthetic-persisted-mentor",
      url: "http://localhost:5173",
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  await page.route("**/config.json", (route) =>
    route.fulfill({
      json: { googleClientId: "test-client", localFixtures: false },
    }),
  );
  await page.route("**/api/me", (route) =>
    route.fulfill({
      status: route
        .request()
        .headers()
        .cookie?.includes("puncher-local-session=")
        ? 200
        : 401,
      json: { id: "mentor", roles: ["mentor"] },
    }),
  );
  await page.route("**/api/mentor/kiosk/launch", (route) => {
    expect(route.request().headers().cookie).toContain(
      "puncher-local-session=synthetic-persisted-mentor",
    );
    expect(route.request().headers().authorization).toBeUndefined();
    return route.fulfill({
      headers: {
        "set-cookie":
          "puncher-local-session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0",
      },
      json: { ready: true, sessionId: "synthetic-kiosk", resumed: false },
    });
  });
  await page.route("**/api/kiosk/**", (route) =>
    route.fulfill({
      json: route.request().url().endsWith("/status")
        ? { ready: true, sessionId: "synthetic-kiosk" }
        : route.request().url().endsWith("/occupants")
          ? {
              occupants: [],
              asOf: new Date().toISOString(),
              validUntil: new Date(Date.now() + 15000).toISOString(),
            }
          : {
              weekSeconds: 0,
              yearSeconds: 0,
              allTimeSeconds: 0,
              updatedAt: new Date().toISOString(),
            },
    }),
  );
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "MENTOR DASHBOARD" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Launch kiosk", exact: true })
    .first()
    .click();
  await expect(
    page.getByRole("heading", { name: "SCAN YOUR ID", exact: true }),
  ).toBeVisible();
  expect(
    (await context.cookies()).some((c) => c.name === "puncher-local-session"),
  ).toBe(false);
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "MENTOR LOG IN" }),
  ).toBeVisible();
});
