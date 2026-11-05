import React, { useEffect, useRef, useState } from "react";
import { api } from "./api";

export function KioskActivation({
  initialError,
  onCancel,
}: {
  initialError: string;
  onCancel?: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const busy = useRef(false);
  const [error, setError] = useState("");
  const [activating, setActivating] = useState(false);
  useEffect(() => {
    const focus = () => input.current?.focus();
    focus();
    window.addEventListener("focus", focus);
    return () => window.removeEventListener("focus", focus);
  }, []);

  async function activate(event: React.FormEvent) {
    event.preventDefault();
    const code = input.current?.value.trim().toUpperCase();
    if (!code || busy.current) return;
    busy.current = true;
    setActivating(true);
    setError("");
    input.current!.value = "";
    try {
      const session = await api("/kiosk/activate", { code });
      const previous = sessionStorage.getItem("puncher-kiosk-session");
      if (
        sessionStorage.getItem("puncher-pending") &&
        (!session.resumed || previous !== session.sessionId)
      )
        sessionStorage.setItem("puncher-pending-foreign", "true");
      sessionStorage.setItem("puncher-kiosk-session", session.sessionId);
      window.location.reload();
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "Could not activate the kiosk.",
      );
      busy.current = false;
      setActivating(false);
      input.current?.focus();
    }
  }

  return (
    <section
      className="panel kiosk-activation"
      onClick={() => input.current?.focus()}
    >
      <h1>Scan kiosk activation code</h1>
      <form onSubmit={activate}>
        <input
          ref={input}
          className="scanner-input"
          aria-label="Kiosk activation scanner input"
          autoComplete="off"
          spellCheck={false}
          maxLength={80}
        />
      </form>
      {onCancel && (
        <button className="secondary" disabled={activating} onClick={onCancel}>
          Back to card scanner
        </button>
      )}
      {activating && <p role="status">Activating kiosk…</p>}
      {(error || initialError) && (
        <p className="error" role="alert">
          {error || initialError}
        </p>
      )}
    </section>
  );
}
