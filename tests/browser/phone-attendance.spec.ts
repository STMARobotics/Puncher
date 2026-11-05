import { test, expect, type Locator } from "@playwright/test";
import { PNG } from "pngjs";
import {
  MultiFormatReader,
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
  return new MultiFormatReader()
    .decode(
      new BinaryBitmap(
        new HybridBinarizer(
          new RGBLuminanceSource(pixels, png.width, png.height),
        ),
      ),
      new Map([[DecodeHintType.POSSIBLE_FORMATS, [format]]]),
    )
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
    await expect(
      mentor.getByRole("heading", { name: "Mentor dashboard" }),
    ).toBeVisible();
    expect((await kiosk.request.get("/api/me")).status()).toBe(401);

    await member.goto("/");
    await member.getByRole("button", { name: "Local member" }).click();
    const code = await readCode(
      member.getByRole("img", { name: "Your attendance barcode" }),
      BarcodeFormat.CODE_128,
    );
    expect(code).toBe("000123");
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
    await kiosk.waitForTimeout(5100);
    await kiosk.keyboard.type(code);
    await kiosk.keyboard.press("Enter");
    await expect(
      kiosk.getByRole("heading", {
        name: wasInShop ? "CLOCKED IN" : "CLOCKED OUT",
      }),
    ).toBeVisible();
  } finally {
    await kiosk.close();
    await member.close();
  }
});
