import { useEffect, useRef, useState } from "react";
import {
  BrowserMultiFormatReader,
  type IScannerControls,
} from "@zxing/browser";
import { BarcodeFormat, DecodeHintType } from "@zxing/library";
export function Camera({ onCard }: { onCard: (card: string) => void }) {
  const video = useRef<HTMLVideoElement>(null),
    callback = useRef(onCard);
  callback.current = onCard;
  const [error, setError] = useState(""),
    [on, setOn] = useState(false);
  useEffect(() => {
    if (!on) return;
    let cancelled = false,
      stream: MediaStream | undefined,
      controls: IScannerControls | undefined,
      timer: ReturnType<typeof setTimeout>;
    const seen = new Map<string, number>();
    const emit = (value: string) => {
      const now = Date.now();
      if (now - (seen.get(value) || 0) < 2500) return;
      seen.set(value, now);
      callback.current(value);
    };
    (async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia)
          throw new Error("Camera requires HTTPS and a supported browser.");
        const Native = (window as any).BarcodeDetector;
        const formats = Native ? await Native.getSupportedFormats() : [];
        const useful = formats.filter((f: string) =>
          [
            "code_128",
            "code_39",
            "ean_13",
            "ean_8",
            "itf",
            "codabar",
            "upc_a",
            "upc_e",
          ].includes(f),
        );
        if (useful.length) {
          const detector = new Native({ formats: useful });
          stream = await navigator.mediaDevices.getUserMedia({
            video: {
              facingMode: { ideal: "environment" },
              width: { ideal: 1280 },
            },
            audio: false,
          });
          if (cancelled) {
            stream.getTracks().forEach((t) => t.stop());
            return;
          }
          video.current!.srcObject = stream;
          await video.current!.play();
          const frame = async () => {
            if (cancelled) return;
            try {
              const results = await detector.detect(video.current);
              for (const r of results) emit(r.rawValue);
            } catch {}
            timer = setTimeout(frame, 180);
          };
          frame();
        } else {
          const hints = new Map();
          hints.set(DecodeHintType.POSSIBLE_FORMATS, [
            BarcodeFormat.CODE_128,
            BarcodeFormat.CODE_39,
            BarcodeFormat.ITF,
            BarcodeFormat.CODABAR,
            BarcodeFormat.EAN_13,
            BarcodeFormat.EAN_8,
            BarcodeFormat.UPC_A,
            BarcodeFormat.UPC_E,
          ]);
          const reader = new BrowserMultiFormatReader(hints, {
            delayBetweenScanAttempts: 150,
            delayBetweenScanSuccess: 1200,
          });
          controls = await reader.decodeFromConstraints(
            { video: { facingMode: { ideal: "environment" } }, audio: false },
            video.current!,
            (result) => {
              if (result && !cancelled) emit(result.getText());
            },
          );
          if (cancelled) controls.stop();
        }
      } catch (e: any) {
        if (!cancelled) {
          setError(
            e.name === "NotAllowedError"
              ? "Camera permission was denied. Enable camera access in browser settings."
              : e.name === "NotFoundError"
                ? "No camera found on this device."
                : e.message,
          );
          setOn(false);
        }
      }
    })();
    return () => {
      cancelled = true;
      clearTimeout(timer);
      controls?.stop();
      stream?.getTracks().forEach((t) => t.stop());
      const s = video.current?.srcObject as MediaStream | null;
      s?.getTracks().forEach((t) => t.stop());
    };
  }, [on]);
  return (
    <div className="camera">
      <video
        ref={video}
        playsInline
        muted
        aria-label="Student card camera preview"
      />
      <div className="camera-guide" />
      <p>Hold the barcode inside the frame.</p>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <button
        onClick={() => {
          setError("");
          setOn(!on);
        }}
      >
        {on ? "Stop camera" : "Start rear camera"}
      </button>
    </div>
  );
}
