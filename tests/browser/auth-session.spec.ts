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
      json: { id: "local-mentor", role: "MENTOR" },
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
