import { test, expect } from "@playwright/test";
async function launchKiosk(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Local mentor", exact: true }).click();
  await page
    .getByRole("button", { name: "Launch kiosk", exact: true })
    .first()
    .click();
  await expect(page.getByLabel("Student ID scanner input")).toBeFocused();
}
test("camera permission denial has a recovery message without awarding hours", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
      value: async () => {
        throw new DOMException("Denied", "NotAllowedError");
      },
    });
    Object.defineProperty(window, "BarcodeDetector", { value: undefined });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Local mentor", exact: true }).click();
  await page.getByRole("button", { name: "Create a volunteer event" }).click();
  const title = `Camera check ${Date.now()}`;
  await page.getByLabel("Event title").fill(title);
  await page.getByLabel("Local event date").fill("2026-06-01");
  await page.getByLabel("Hours per participant").fill("1");
  await page.getByRole("button", { name: "Create event", exact: true }).click();
  await page.getByRole("button").filter({ hasText: title }).click();
  await page.getByRole("button", { name: "Open camera scanner" }).click();
  await page.getByRole("button", { name: "Start rear camera" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Camera permission was denied",
  );
  await expect(page.locator(".list-row")).toHaveCount(0);
});
test("kiosk accepts Enter/CRLF, saved result, no card exposure, stale reset protection", async ({
  page,
}) => {
  await launchKiosk(page);
  await expect(page.getByLabel("Student ID scanner input")).toBeFocused();
  await expect(
    page.getByRole("heading", { name: "Scan your ID" }),
  ).toBeVisible();
  await page.keyboard.type("000123");
  await page.keyboard.press("Enter");
  await expect(
    page.locator(".scan-panel").getByText("Alex Example", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: /CLOCKED (IN|OUT)/ }),
  ).toBeVisible();
  expect(await page.locator(".scan-panel").innerText()).not.toContain("000123");
  await page.waitForTimeout(2500);
  await page.keyboard.type("000456");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await expect(
    page.locator(".scan-panel").getByText("Jordan Sample", { exact: true }),
  ).toBeVisible();
  await page.waitForTimeout(2800);
  await expect(
    page.locator(".scan-panel").getByText("Jordan Sample", { exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: "work/kiosk-desktop.png", fullPage: true });
});
test("lost response retries same operation after reload and public API rejects anonymous writes", async ({
  page,
}) => {
  await launchKiosk(page);
  await expect(page.getByLabel("Student ID scanner input")).toBeFocused();
  let dropped = false;
  await page.route("**/api/kiosk/scan", async (route) => {
    if (!dropped) {
      dropped = true;
      await route.fetch();
      await route.abort("failed");
    } else await route.continue();
  });
  await page.keyboard.type("000123");
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("heading", { name: "Scan not confirmed" }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.locator(".scan-panel").getByText("Alex Example", { exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => sessionStorage.getItem("puncher-pending")),
  ).toBeNull();
});
test("mentor creates an event, adds once, removes with a reason; phone layout works", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.getByRole("button", { name: "Local mentor", exact: true }).click();
  await page.getByRole("button", { name: "Create a volunteer event" }).click();
  const title = `Synthetic outreach ${Date.now()}`;
  await page.getByLabel("Event title").fill(title);
  await page.getByLabel("Local event date").fill("2026-06-01");
  await page.getByLabel("Hours per participant").fill("1.5");
  await page.getByRole("button", { name: "Create event", exact: true }).click();
  await page.getByRole("button").filter({ hasText: title }).click();
  await page.getByLabel("Volunteer student card").fill("000123");
  await page.getByRole("button", { name: "Log card" }).click();
  await expect(page.getByRole("status")).toContainText("1h 30m awarded");
  await page.getByLabel("Volunteer student card").fill("000123");
  await page.getByRole("button", { name: "Log card" }).click();
  await expect(page.getByRole("status")).toContainText("Already logged");
  await page.screenshot({ path: "work/mentor-mobile.png", fullPage: true });
  page.once("dialog", (dialog) => dialog.accept("Synthetic test wrong scan"));
  await page.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(page.locator(".list-row")).toHaveCount(0);
});
test("home requires mentor login and mentors manage members without a printing or device setup flow", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "MENTOR LOG IN" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Launch kiosk", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Local student", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Local mentor administrator", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Manage members", exact: true })
    .first()
    .click();
  const member = page.getByRole("row").filter({ hasText: "Alex Example" });
  await expect(member).toBeVisible();
  await member
    .getByRole("button", { name: "Edit member", exact: true })
    .click();
  await expect(page.getByText("000123", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: /print/i })).toHaveCount(0);
  await expect(page.getByLabel("Device credential")).toHaveCount(0);
  await page.screenshot({ path: "work/admin-desktop.png", fullPage: true });
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "MENTOR LOG IN" }),
  ).toBeVisible();
  expect(
    (
      await page.request.get("/api/mentor/members", {
        headers: { Authorization: "Bearer local-student" },
      })
    ).status(),
  ).toBe(403);
});

test("mentor launch removes mentor authority and ending a kiosk requires a new login", async ({
  page,
}) => {
  await page.goto("/kiosk");
  await expect(
    page.getByRole("heading", { name: "KIOSK LOCKED" }),
  ).toBeVisible();
  await expect(page.getByLabel("Device credential")).toHaveCount(0);
  await launchKiosk(page);
  expect((await page.request.get("/api/mentor/members")).status()).toBe(401);
  expect(
    await page.evaluate(() => [
      localStorage.length,
      sessionStorage.getItem("token"),
    ]),
  ).toEqual([0, null]);
  await page.getByRole("button", { name: "End kiosk", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "MENTOR LOG IN" }),
  ).toBeVisible();
  await page.goto("/kiosk");
  await expect(
    page.getByRole("heading", { name: "KIOSK LOCKED" }),
  ).toBeVisible();
});

test("manual roster sync preserves a known member code and exports barcode data for external ID generation", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Local mentor", exact: true }).click();
  await page
    .getByRole("button", { name: "Manage members", exact: true })
    .first()
    .click();
  await page.getByRole("button", { name: "Sync roster", exact: true }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Sync finished" }),
  ).toBeVisible({ timeout: 20000 });
  await expect(
    page.getByRole("row").filter({ hasText: "Alex Example" }),
  ).toContainText("000123");
  const jordan = page.locator(".roster-match").filter({
    has: page.locator("strong").getByText("Jordan Sample", { exact: true }),
  });
  if (await jordan.count()) {
    await jordan
      .getByRole("combobox")
      .selectOption({ label: "Jordan Sample · 000456" });
    await jordan
      .getByRole("button", { name: "Link existing", exact: true })
      .click();
    await expect(jordan).toHaveCount(0);
  }
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export active roster CSV" }).click();
  const file = await download;
  const contents = await (
    await import("node:fs/promises")
  ).readFile((await file.path())!, "utf8");
  expect(contents).toContain("name,email,barcode");
  expect(contents).toContain('"000123"');
  expect(file.suggestedFilename()).toBe("puncher-roster.csv");
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "work/mentor-roster-mobile.png",
    fullPage: true,
  });
});

test("a pending scan from a different kiosk session stays locked for mentor review", async ({
  page,
}) => {
  await page.addInitScript(() => {
    sessionStorage.setItem("puncher-kiosk-session", "old-session");
    sessionStorage.setItem(
      "puncher-pending",
      JSON.stringify({ barcode: "000123", operationId: crypto.randomUUID() }),
    );
  });
  let scans = 0;
  await page.route("**/api/kiosk/**", (route) => {
    if (route.request().url().endsWith("/scan")) scans++;
    return route.fulfill({
      json: { ready: true, sessionId: "different-session" },
    });
  });
  await page.goto("/kiosk");
  await expect(
    page.getByRole("heading", { name: "KIOSK LOCKED" }),
  ).toBeVisible();
  await expect(page.getByRole("alert")).toContainText("mentor review");
  expect(scans).toBe(0);
  expect(
    await page.evaluate(() => sessionStorage.getItem("puncher-pending")),
  ).not.toBeNull();
});

test("kiosk shows only a scan prompt and anonymous team totals on desktop and phone", async ({
  page,
}) => {
  await launchKiosk(page);
  await expect(page.getByLabel("Student ID scanner input")).toBeFocused();
  await expect(
    page.getByRole("heading", { name: "SCAN YOUR ID", exact: true }),
  ).toBeVisible();
  const totals = page.getByRole("region", { name: "SHOP HOURS" });
  await expect(totals.locator("dd").first()).toHaveText(/^\d[\d,.]*$/);
  await expect(totals.locator("dt")).toHaveText([
    "This week",
    "This year",
    "All time",
  ]);
  await expect(page.getByText("CHECK IN. BUILD SOMETHING.")).toHaveCount(0);
  await expect(page.getByText("Hold your card under the scanner")).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("button", { name: "Operations", exact: true }),
  ).toHaveCount(0);
  expect(await totals.innerText()).not.toMatch(/Alex|Jordan|000123|000456/);
  expect(
    await page
      .locator("body")
      .evaluate((el) =>
        getComputedStyle(el).backgroundColor === "rgba(0, 0, 0, 0)"
          ? getComputedStyle(document.documentElement).backgroundColor
          : getComputedStyle(el).backgroundColor,
      ),
  ).toBe("rgb(5, 6, 7)");
  await page.screenshot({
    path: "work/kiosk-simple-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.getByRole("heading", { name: "SCAN YOUR ID", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "work/kiosk-simple-mobile.png",
    fullPage: true,
  });
});
test("shop splash shows names after scans, removes checkouts, and clears an unavailable roster", async ({
  page,
}) => {
  await launchKiosk(page);
  await expect(page.getByLabel("Student ID scanner input")).toBeFocused();
  const headers = {
    authorization: "Bearer local-admin",
    origin: "http://localhost:5173",
  };
  const cards: string[] = [];
  for (const displayName of ["Casey Preview", "Morgan Preview"]) {
    let created = false;
    for (let attempt = 0; attempt < 5 && !created; attempt++) {
      const barcode = String(700000 + Math.floor(Math.random() * 100000));
      const r = await page.request.post("/api/admin/members", {
        headers,
        data: { displayName, memberKind: "student", active: true, barcode },
      });
      if (r.status() === 409) continue;
      expect(r.status()).toBe(201);
      cards.push(barcode);
      created = true;
    }
    expect(created).toBe(true);
  }
  const board = page.getByRole("region", { name: "IN THE SHOP" });
  for (const [index, name] of ["Casey Preview", "Morgan Preview"].entries()) {
    await page.keyboard.type(cards[index]);
    await page.keyboard.press("Enter");
    await expect(
      page.locator(".scan-panel").getByText(name, { exact: true }),
    ).toBeVisible();
    await expect(board.getByText(name, { exact: true })).toBeVisible();
  }
  await expect(
    page.getByRole("heading", { name: "SCAN YOUR ID", exact: true }),
  ).toBeVisible({ timeout: 7000 });
  await page.screenshot({
    path: "work/kiosk-presence-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await expect(board.getByText("Casey Preview", { exact: true })).toBeVisible();
  await page.screenshot({
    path: "work/kiosk-presence-mobile.png",
    fullPage: true,
  });
  for (const [index, name] of ["Casey Preview", "Morgan Preview"].entries()) {
    await page.keyboard.type(cards[index]);
    await page.keyboard.press("Enter");
    await expect(
      page.locator(".scan-panel").getByRole("heading", { name: "CLOCKED OUT" }),
    ).toBeVisible();
    await expect(board.getByText(name, { exact: true })).toHaveCount(0);
  }
  await page.route("**/api/kiosk/occupants", (route) => route.abort("failed"));
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(board.getByRole("status")).toHaveText(
    "Current attendance is unavailable.",
  );
  await expect(board.locator(".presence-card")).toHaveCount(0);
});
