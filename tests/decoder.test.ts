import { it, expect } from "vitest";
import bwip from "bwip-js/node";
import { PNG } from "pngjs";
import {
  MultiFormatReader,
  RGBLuminanceSource,
  HybridBinarizer,
  BinaryBitmap,
  DecodeHintType,
  BarcodeFormat,
} from "@zxing/library";
it("fallback library decodes synthetic Code 128 and Code 39 1D cards including leading zero", async () => {
  for (const [bcid, format] of [
    ["code128", BarcodeFormat.CODE_128],
    ["code39", BarcodeFormat.CODE_39],
  ] as const) {
    const png = PNG.sync.read(
      await bwip.toBuffer({
        bcid,
        text: "000123",
        scale: 3,
        height: 20,
        includetext: false,
        padding: 20,
        backgroundcolor: "FFFFFF",
      }),
    );
    const pixels = new Uint8ClampedArray(png.width * png.height);
    for (let i = 0; i < pixels.length; i++)
      pixels[i] =
        (png.data[i * 4] * 306 +
          png.data[i * 4 + 1] * 601 +
          png.data[i * 4 + 2] * 117 +
          512) >>
        10;
    const reader = new MultiFormatReader();
    const hints = new Map([[DecodeHintType.POSSIBLE_FORMATS, [format]]]);
    expect(
      reader
        .decode(
          new BinaryBitmap(
            new HybridBinarizer(
              new RGBLuminanceSource(pixels, png.width, png.height),
            ),
          ),
          hints,
        )
        .getText(),
    ).toBe("000123");
  }
});
