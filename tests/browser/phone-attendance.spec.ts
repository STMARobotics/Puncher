import { test, expect, type Locator } from "@playwright/test";
import { PNG } from "pngjs";
import {
  MultiFormatReader,
  QRCodeReader,
  RGBLuminanceSource,
  HybridBinarizer,
  BinaryBitmap,
  DecodeHintType,
  BarcodeFormat,
} from "@zxing/library";

async function readCode(canvas: Locator, format: BarcodeFormat) {
  await expect(canvas).toBeVisible();
  const data = await canvas.evaluate((node) =>
    (node as HTMLCanvasElement).toDataURL(),
  );
  const png = PNG.sync.read(Buffer.from(data.split(",")[1], "base64"));
  const pixels = new Uint8ClampedArray(png.width * png.height);
  for (let i = 0; i < pixels.length; i++) pixels[i] = png.data[i * 4];
  const bitmap = new BinaryBitmap(
    new HybridBinarizer(new RGBLuminanceSource(pixels, png.width, png.height)),
  );
  // A canvas readback is already an aligned image of the QR, so skip the
  // finder intended for locating QR codes inside a camera frame.
  if (format === BarcodeFormat.QR_CODE)
    return new QRCodeReader()
      .decode(bitmap, new Map([[DecodeHintType.PURE_BARCODE, true]]))
      .getText();
  return new MultiFormatReader()
    .decode(bitmap, new Map([[DecodeHintType.POSSIBLE_FORMATS, [format]]]))
    .getText();
}

test("a mentor phone activates an anonymous kiosk and a member phone clocks attendance", async ({
  page: mentor,
  browser,
  baseURL,
}) => {
  const kiosk = await browser.newPage({ baseURL });
  const member = await browser.newPage({
    baseURL,
    viewport: { width: 390, height: 844 },
  });
  try {
    await member.route("**/config.json", (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          googleClientId: "",
          localFixtures: true,
          walletEnabled: true,
        }),
      }),
    );
    await kiosk.goto("/");
    await kiosk.getByRole("link", { name: "Start kiosk" }).click();
    await expect(
      kiosk.getByRole("heading", { name: "Scan kiosk activation code" }),
    ).toBeVisible();
    await mentor.goto("/");
    await mentor
      .getByRole("button", { name: "Local mentor", exact: true })
      .click();
    await mentor
      .getByRole("button", { name: "Generate kiosk activation QR" })
      .first()
      .click();
    const qr = await readCode(
      mentor.getByRole("img", { name: "Kiosk activation QR code" }),
      BarcodeFormat.QR_CODE,
    );
    await expect(
      kiosk.getByLabel("Kiosk activation scanner input"),
    ).toBeFocused();
    await kiosk.keyboard.type(qr);
    await kiosk.keyboard.press("Enter");
    await expect(kiosk.getByLabel("Student ID scanner input")).toBeFocused();
    const mentors = kiosk.getByRole("region", { name: "Mentors", exact: true });
    const members = kiosk.getByRole("region", {
      name: "Students",
      exact: true,
    });
    await expect(mentors.getByText("Taylor Mentor")).toBeVisible();
    const mentorCard = await readCode(
      mentor.getByRole("img", { name: "Your attendance barcode" }),
      BarcodeFormat.CODE_128,
    );
    await expect(
      mentor.getByRole("heading", { name: "Mentor dashboard" }),
    ).toBeVisible();
    expect((await kiosk.request.get("/api/me")).status()).toBe(401);

    await member.goto("/");
    await member.getByRole("button", { name: "Local student" }).click();
    await expect(
      member.getByRole("link", { name: "Add to Google Wallet" }),
    ).toHaveAttribute("href", "/api/wallet/save");
    const code = await readCode(
      member.getByRole("img", { name: "Your attendance barcode" }),
      BarcodeFormat.CODE_128,
    );
    expect(code).toBe("000123");
    await member
      .context()
      .grantPermissions(["clipboard-read", "clipboard-write"]);
    await member.getByRole("button", { name: "Copy barcode ID" }).click();
    await expect(member.getByRole("status")).toHaveText("Barcode ID copied.");
    expect(await member.evaluate(() => navigator.clipboard.readText())).toBe(
      "000123",
    );
    await expect(kiosk.getByText("SHOP OPEN", { exact: true })).toBeVisible();
    const scannerHeight = await kiosk
      .locator(".scan-panel")
      .evaluate((el) => el.getBoundingClientRect().height);
    await expect(
      member.getByRole("button", { name: "Manage members" }),
    ).toHaveCount(0);
    const presence = await (
      await kiosk.request.get("/api/kiosk/occupants")
    ).json();
    const wasInShop = presence.occupants.some(
      (person: { displayName: string }) =>
        person.displayName === "Alex Example",
    );
    await kiosk.keyboard.type(code);
    await kiosk.keyboard.press("Enter");
    await expect(
      kiosk.getByRole("heading", {
        name: wasInShop ? "CLOCKED OUT" : "CLOCKED IN",
      }),
    ).toBeVisible();
    if (wasInShop) {
      await kiosk.waitForTimeout(5100);
      await kiosk.keyboard.type(code);
      await kiosk.keyboard.press("Enter");
      await expect(
        kiosk.getByRole("heading", { name: "CLOCKED IN" }),
      ).toBeVisible();
    }
    await expect(members.getByText("Alex Example")).toBeVisible();
    // Remove any mentor coverage that earlier browser flows may have left active.
    const active = await (
      await kiosk.request.get("/api/kiosk/occupants")
    ).json();
    if (
      active.mentors.some(
        (person: { displayName: string }) =>
          person.displayName === "local admin",
      )
    ) {
      const admin = await (
        await kiosk.request.get("/api/me", {
          headers: { authorization: "Bearer local-admin" },
        })
      ).json();
      await kiosk.keyboard.type(admin.barcode);
      await kiosk.keyboard.press("Enter");
      await expect(mentors.getByText("local admin")).toHaveCount(0);
    }
    await kiosk.keyboard.type(mentorCard);
    await kiosk.keyboard.press("Enter");
    await expect(kiosk.getByText("SHOP CLOSED", { exact: true })).toBeVisible();
    await expect(members.getByText("Alex Example")).toBeVisible();
    await kiosk.waitForTimeout(5100);
    await kiosk.keyboard.type(code);
    await kiosk.keyboard.press("Enter");
    await expect(
      kiosk.getByRole("heading", { name: "CLOCKED OUT" }),
    ).toBeVisible();
    await expect(members.getByText("Alex Example")).toHaveCount(0);
    await kiosk.waitForTimeout(5100);
    await kiosk.keyboard.type(code);
    await kiosk.keyboard.press("Enter");
    await expect(kiosk.getByText(/Shop closed. Ask a mentor/)).toBeVisible();
    expect(
      await kiosk
        .locator(".scan-panel")
        .evaluate((el) => el.getBoundingClientRect().height),
    ).toBe(scannerHeight);

    await mentor
      .getByRole("button", { name: "Generate kiosk activation QR" })
      .first()
      .click();
    const reopen = await readCode(
      mentor.getByRole("img", { name: "Kiosk activation QR code" }),
      BarcodeFormat.QR_CODE,
    );
    await expect(kiosk.getByLabel("Student ID scanner input")).toBeFocused();
    await kiosk.keyboard.type(reopen);
    await kiosk.keyboard.press("Enter");
    await expect(
      kiosk.getByRole("heading", { name: "SCAN YOUR ID" }),
    ).toBeVisible();
    await expect(mentors.getByText("Taylor Mentor")).toBeVisible();
  } finally {
    await kiosk.close();
    await member.close();
  }
});
