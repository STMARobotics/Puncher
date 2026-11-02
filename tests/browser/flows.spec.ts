import { test, expect } from "@playwright/test";
const credential =
  "33333333-3333-4333-8333-333333333333.synthetic-local-device";
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
  await page.getByRole("button", { name: "+ New event" }).click();
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
  await page.goto("/kiosk");
  await page.getByLabel("Device credential").fill(credential);
  await page.getByRole("button", { name: "Authorize this kiosk" }).click();
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
  await page.goto("/kiosk");
  await page.getByLabel("Device credential").fill(credential);
  await page.getByRole("button", { name: "Authorize this kiosk" }).click();
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
  await page.getByRole("button", { name: "Local mentor" }).click();
  await page.getByRole("button", { name: "+ New event" }).click();
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
test("admin members and mappings are available while student has no operations", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Local administrator" }).click();
  await page.getByRole("button", { name: "Operations", exact: true }).click();
  await expect(page.getByRole("cell", { name: /Alex Example/ })).toBeVisible();
  await page.getByRole("button", { name: "Edit mapping" }).first().click();
  await expect(page.getByLabel("Six-digit card (optional)")).toHaveValue(
    /^[0-9]{6}$/,
  );
  await page.screenshot({ path: "work/admin-desktop.png", fullPage: true });
  await page.getByRole("button", { name: "Sign out" }).click();
  await page
    .getByRole("button", { name: "Local student", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "VIEW YOUR HOURS" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Operations", exact: true }),
  ).toHaveCount(0);
  expect(
    (
      await page.request.get("/api/admin/members", {
        headers: { Authorization: "Bearer local-student" },
      })
    ).status(),
  ).toBe(403);
});
test("kiosk shows only a scan prompt and anonymous team totals on desktop and phone", async ({
  page,
}) => {
  await page.goto("/kiosk");
  await page.getByLabel("Device credential").fill(credential);
  await page.getByRole("button", { name: "Authorize this kiosk" }).click();
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
  await page.goto("/kiosk");
  await page.getByLabel("Device credential").fill(credential);
  await page.getByRole("button", { name: "Authorize this kiosk" }).click();
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
