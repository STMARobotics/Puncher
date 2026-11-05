import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { code128, qrcode } from "bwip-js/browser";

export default function PassCode({
  value,
  label,
  qr = false,
}: {
  value: string;
  label: string;
  qr?: boolean;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useLayoutEffect(() => {
    if (!canvas.current) return;
    const render = qr ? qrcode : code128;
    render(canvas.current, {
      bcid: qr ? "qrcode" : "code128",
      text: value,
      scale: 5,
      padding: 12,
      backgroundcolor: "FFFFFF",
      ...(qr ? {} : { height: 22 }),
    });
  }, [value, qr]);
  return (
    <canvas className="pass-code" role="img" aria-label={label} ref={canvas} />
  );
}

export function ActivationPass({
  code,
  expiresAt,
}: {
  code: string;
  expiresAt: string;
}) {
  const [expired, setExpired] = useState(false);
  useEffect(() => {
    const timer = setTimeout(
      () => setExpired(true),
      Math.max(0, Date.parse(expiresAt) - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [expiresAt]);
  return (
    <div className="activation-pass">
      {expired ? (
        <p role="status">Code expired. Generate a new one.</p>
      ) : (
        <>
          <PassCode value={code} qr label="Kiosk activation QR code" />
          <p>Scan at the waiting kiosk within two minutes.</p>
        </>
      )}
    </div>
  );
}
