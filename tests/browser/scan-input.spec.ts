import { test, expect } from "@playwright/test";
import { PNG } from "pngjs";

async function mockKiosk(page: import("@playwright/test").Page) {
  const scans: { barcode: string; operationId: string }[] = [];
  await page.clock.install({ time: new Date("2026-11-02T18:00:00.000Z") });
  await page.route("**/api/kiosk/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/kiosk/scan") {
      scans.push(route.request().postDataJSON());
      return route.fulfill({
        json: {
          state: scans.length === 1 ? "in" : "out",
          displayName: "Manual Entry Example",
          startedAt: "2026-11-02T18:00:00.000Z",
          endedAt: "2026-11-02T18:01:00.000Z",
          creditedSeconds: 60,
          todaySeconds: 60,
        },
      });
    }
    return route.fulfill({
      json: path.endsWith("/occupants")
        ? {
            occupants: [],
            asOf: new Date().toISOString(),
            validUntil: new Date(Date.now() + 15000).toISOString(),
          }
        : path.endsWith("/totals")
          ? {
              weekSeconds: 0,
              yearSeconds: 0,
              allTimeSeconds: 0,
              updatedAt: new Date().toISOString(),
            }
          : { ready: true },
    });
  });
  await page.goto("/kiosk");
  await expect(
    page.getByRole("heading", { name: "SCAN YOUR ID", exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("Student ID scanner input")).toBeFocused();
  return scans;
}
test("manual typing with normal pauses works after the first successful clock-in", async ({
  page,
}) => {
  const scans = await mockKiosk(page);
  await page.keyboard.type("000123");
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("heading", { name: "CLOCKED IN", exact: true }),
  ).toBeVisible();
  // Start typing during the confirmation. Its reset timer must not erase input.
  for (const digit of "000123") {
    await page.keyboard.type(digit);
    await page.clock.runFor(1200);
  }
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("heading", { name: "CLOCKED OUT", exact: true }),
  ).toBeVisible();
  expect(scans).toHaveLength(2);
  expect(scans.map((scan) => scan.barcode)).toEqual(["000123", "000123"]);
});
test("manual entry supports Backspace, select-all replacement, and cancellation", async ({
  page,
}) => {
  const scans = await mockKiosk(page);
  await page.keyboard.type("000129");
  await expect(
    page.getByRole("status", { name: "6 of 6 characters entered" }),
  ).toBeVisible();
  await page.keyboard.press("Backspace");
  await page.keyboard.type("3");
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("heading", { name: "CLOCKED IN", exact: true }),
  ).toBeVisible();
  await page.clock.runFor(5100);
  await page.keyboard.type("987");
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type("000123");
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("heading", { name: "CLOCKED OUT", exact: true }),
  ).toBeVisible();
  expect(scans.map((scan) => scan.barcode)).toEqual(["000123", "000123"]);
  await page.keyboard.type("000");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Enter");
  expect(scans).toHaveLength(2);
  await expect(page.locator(".scan-entry")).toHaveCount(0);
});
test("malformed entries never reach the API and rapid repeated reads do not reverse a saved clock-in", async ({
  page,
}) => {
  const scans = await mockKiosk(page);
  await page.keyboard.type("0001234");
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("heading", { name: "SCAN FAILED", exact: true }),
  ).toBeVisible();
  expect(scans).toHaveLength(0);
  await page.keyboard.type("000123");
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("heading", { name: "CLOCKED IN", exact: true }),
  ).toBeVisible();
  await page.keyboard.type("000123");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  expect(scans).toHaveLength(1);
  await expect(
    page.getByRole("heading", { name: "CLOCKED IN", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "SCAN FAILED", exact: true }),
  ).toHaveCount(0);
  await page.clock.runFor(5100);
  await page.keyboard.type("000123");
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("heading", { name: "CLOCKED OUT", exact: true }),
  ).toBeVisible();
  expect(scans).toHaveLength(2);
});
test("scan border accelerates, coasts back to idle, and flashes a fading inner glow", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await mockKiosk(page);
  const rate = () =>
    page
      .locator(".scan-chase g")
      .evaluate((el) => el.getAnimations()[0]?.playbackRate);
  await expect.poll(rate).toBe(1);
  await page.screenshot({ path: "work/kiosk-chase-idle.png", fullPage: true });
  await page.keyboard.type("000123");
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("heading", { name: "CLOCKED IN", exact: true }),
  ).toBeVisible();
  await page.clock.runFor(250);
  await expect.poll(rate).toBeGreaterThan(5);
  await expect
    .poll(() =>
      page
        .locator(".scan-glow")
        .evaluate((el) => Number(getComputedStyle(el).opacity)),
    )
    .toBeGreaterThan(0.2);
  await page.screenshot({ path: "work/kiosk-chase-scan.png", fullPage: true });
  await page.clock.runFor(2400);
  await expect.poll(rate).toBeGreaterThan(1);
  await expect.poll(rate).toBeLessThan(5);
  await page.clock.runFor(3500);
  await expect.poll(rate).toBe(1);
  await page.waitForTimeout(2300);
  await expect
    .poll(() =>
      page
        .locator(".scan-glow")
        .evaluate((el) => Number(getComputedStyle(el).opacity)),
    )
    .toBe(0);
});
test("the visible chase stroke actually moves around the perimeter", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await mockKiosk(page);
  const snapshot = async (time: number) => {
    await page.locator(".scan-chase g").evaluate((el, time) => {
      const animation = el.getAnimations()[0];
      animation.pause();
      animation.currentTime = time;
    }, time);
    await page.waitForTimeout(80);
    return page.locator(".chase-head").evaluate((el) => ({
      offset: getComputedStyle(el).strokeDashoffset,
      length: (el as unknown as SVGGeometryElement).getTotalLength(),
      dash: getComputedStyle(el).strokeDasharray,
    }));
  };
  const centroid = async (name: string) => {
    const buffer = await page
      .locator(".scan-panel")
      .screenshot({ path: `work/chase-${name}.png` });
    const png = PNG.sync.read(buffer);
    let xTotal = 0,
      yTotal = 0,
      count = 0;
    for (let y = 0; y < png.height; y++)
      for (let x = 0; x < png.width; x++) {
        if (x > 10 && x < png.width - 10 && y > 10 && y < png.height - 10)
          continue;
        const i = (y * png.width + x) * 4;
        const [r, g, b] = png.data.subarray(i, i + 3);
        if (b - r > 35 && b - g > 15) {
          xTotal += x;
          yTotal += y;
          count++;
        }
      }
    expect(count).toBeGreaterThan(0);
    return { x: xTotal / count, y: yTotal / count };
  };
  const start = await snapshot(0),
    first = await centroid("start"),
    quarter = await snapshot(4000),
    second = await centroid("quarter");
  expect(quarter.offset).not.toBe(start.offset);
  expect(Math.hypot(second.x - first.x, second.y - first.y)).toBeGreaterThan(
    150,
  );
});
test("kiosk keeps motion on, hides removed labels, and centers date and time at both sizes", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(() => localStorage.setItem("puncher-motion", "off"));
  await mockKiosk(page);
  await expect(page.getByLabel("Scan animation", { exact: true })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("heading", { name: "SHOP", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByText("Completed visits", { exact: true })).toHaveCount(
    0,
  );
  await expect
    .poll(() =>
      page.locator(".scan-chase g").evaluate((el) => el.getAnimations().length),
    )
    .toBe(1);
  expect(
    await page
      .locator(".scan-glow")
      .evaluate((el) => getComputedStyle(el).display),
  ).not.toBe("none");
  for (const [width, height, name] of [
    [1280, 720, "desktop"],
    [390, 844, "mobile"],
  ] as const) {
    await page.setViewportSize({ width, height });
    const clock = await page.locator(".kiosk .clock").boundingBox(),
      panel = await page.locator(".scan-panel").boundingBox();
    expect(clock).not.toBeNull();
    expect(panel).not.toBeNull();
    expect(
      Math.abs(clock!.x + clock!.width / 2 - panel!.x - panel!.width / 2),
    ).toBeLessThan(1);
    expect(
      await page
        .locator(".kiosk .clock")
        .evaluate((el) => getComputedStyle(el).textAlign),
    ).toBe("center");
    await page.screenshot({
      path: "work/kiosk-clean-" + name + ".png",
      fullPage: true,
    });
  }
  await page.keyboard.type("000123");
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("heading", { name: "CLOCKED IN", exact: true }),
  ).toBeVisible();
  await page.clock.runFor(250);
  await expect
    .poll(() =>
      page
        .locator(".scan-chase g")
        .evaluate((el) => el.getAnimations()[0]?.playbackRate),
    )
    .toBeGreaterThan(5);
});
