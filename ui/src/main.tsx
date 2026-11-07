import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource/figtree/400.css";
import "@fontsource/figtree/500.css";
import "@fontsource/figtree/600.css";
import "@fontsource/figtree/700.css";
import "@fontsource/figtree/800.css";
import "./style.css";
import { api, setToken, duration, time } from "./api";
import { MentorConsole, type DirectoryMember } from "./mentor-console";
import { ScanBuffer } from "./scanner";
import { ScanEffects } from "./scan-effects";
import { playClosingTime, primeClosingTimeAudio } from "./closing-time";
import { PuncherMark } from "./puncher-mark";
import { activateKioskSession, KioskActivation } from "./kiosk-activation";
import type { EventType, Role } from "../../service/model";
const PassCode = React.lazy(() => import("./pass-code"));
const ActivationPass = React.lazy(() =>
  import("./pass-code").then((module) => ({ default: module.ActivationPass })),
);
type Config = {
  googleClientId: string;
  localFixtures: boolean;
  walletEnabled: boolean;
};
type Person = {
  id: string;
  role: Role;
  barcode: string;
  picture?: string;
  displayName?: string;
};
function App() {
  const [config, setConfig] = useState<Config>(),
    [page, setPage] = useState(
      location.pathname === "/kiosk" ? "kiosk" : "home",
    ),
    [person, setPerson] = useState<Person>(),
    [eventView, setEventView] = useState(0),
    [error, setError] = useState(""),
    [generating, setGenerating] = useState(false),
    [activation, setActivation] = useState<{
      code: string;
      expiresAt: string;
    }>(),
    [foreignPending, setForeignPending] = useState(
      sessionStorage.getItem("puncher-pending-foreign") === "true",
    );
  const isAdmin = person?.role === "ADMIN";
  const isMentor = isAdmin || person?.role === "MENTOR";
  useEffect(() => {
    const expired = () => {
      setPerson(undefined);
      setActivation(undefined);
      setError("Your sign-in expired. Please sign in again.");
    };
    window.addEventListener("puncher-auth-expired", expired);
    return () => window.removeEventListener("puncher-auth-expired", expired);
  }, []);
  useEffect(() => {
    fetch("/config.json")
      .then((r) => r.json())
      .then(setConfig)
      .catch(() =>
        setError("Unable to load configuration. Check the connection."),
      );
  }, []);
  useEffect(() => {
    if (!config || page === "kiosk") return;
    let active = true;
    api("/me", undefined, "GET", { silentUnauthorized: true })
      .then((current) => {
        if (active) setPerson(current);
      })
      .catch((e: any) => {
        if (active && e.status !== 401)
          setError("Unable to restore your sign-in. Check the connection.");
      });
    return () => {
      active = false;
    };
  }, [config, page]);
  async function signIn(credential: string) {
    try {
      setToken(credential);
      setPerson(await api("/me"));
      setPage("home");
      setError("");
    } catch (e: any) {
      setToken("");
      setPerson(undefined);
      setError(
        e.status === 403
          ? "Ask a mentor to check your roster entry or access approval."
          : e.message,
      );
    }
  }
  async function signOut() {
    try {
      await api("/auth/logout", {}, "POST");
      setPerson(undefined);
      setActivation(undefined);
      setToken("");
      setPage("home");
      setError("");
    } catch (e: any) {
      setError(e.message);
    }
  }
  function navigate(next: string) {
    if (page === "kiosk") {
      window.location.replace("/");
      return;
    }
    setPage(next);
    setError("");
    history.pushState(null, "", "/");
  }
  async function generateActivation() {
    if (page !== "home") navigate("home");
    setGenerating(true);
    setActivation(undefined);
    setError("");
    try {
      const pass = await api("/mentor/kiosk/activation", {});
      setActivation(pass);
      setPerson((current) => current && { ...current, barcode: pass.barcode });
    } catch (e: any) {
      setError(e.message);
    } finally {
      setGenerating(false);
    }
  }
  async function addToWallet() {
    try {
      const pass = await api("/wallet/save");
      window.open(pass.url, "_blank", "noopener,noreferrer");
    } catch (e: any) {
      setError(e.message);
    }
  }
  const mentorActions = (
    <>
      <button onClick={() => navigate("members")}>MANAGE MEMBERS</button>
      <button
        onClick={() => {
          setEventView((view) => view + 1);
          navigate("events");
        }}
      >
        CREATE EVENT
      </button>
      <button disabled={generating} onClick={generateActivation}>
        {generating ? "Generating…" : "GENERATE KIOSK"}
      </button>
    </>
  );
  return (
    <>
      <header className={page === "kiosk" ? "kiosk-header" : ""}>
        <a
          className="brand"
          href="/"
          onClick={(e) => {
            e.preventDefault();
            navigate("home");
          }}
        >
          <span className="brand-icon">
            <PuncherMark />
          </span>
          <span className="brand-wordmark">PUNCHER</span>
        </a>
        {page !== "kiosk" && person && (
          <>
            {isMentor && (
              <nav aria-label="Main navigation">{mentorActions}</nav>
            )}
            <div className="account-actions">
              <Avatar
                picture={person.picture}
                name={person.displayName || "Your account"}
                className="account-avatar"
              />
              <button className="secondary sign-out" onClick={signOut}>
                Sign out
              </button>
            </div>
          </>
        )}
      </header>
      {config?.localFixtures && <div className="local-banner">Test data</div>}
      <main className={page === "kiosk" ? "kiosk-main" : ""}>
        {error && (
          <p role="alert" className="notice error">
            {error}
          </p>
        )}
        {!config ? (
          <p>Loading Puncher…</p>
        ) : page === "kiosk" ? (
          <Kiosk />
        ) : !person ? (
          <section className="signin">
            <h1>SIGN IN</h1>
            <p>Sign in with your stmarobotics.org Google account.</p>
            <div className="signin-actions">
              {config.googleClientId ? (
                <a className="google-signin-button" href="/api/auth/login">
                  <img
                    src="/google-signin-dark.png"
                    alt="Continue with Google"
                    width="180"
                    height="40"
                  />
                </a>
              ) : (
                <p className="muted">Google sign-in is not configured.</p>
              )}
              <a className="google-login" href="/kiosk">
                Start kiosk
              </a>
            </div>
            {config.localFixtures && (
              <div className="fixture-buttons">
                <button onClick={() => signIn("local-mentor")}>
                  Local mentor
                </button>
                <button onClick={() => signIn("local-student")}>
                  Local student
                </button>
                <button
                  className="secondary"
                  onClick={() => signIn("local-admin")}
                >
                  Local mentor administrator
                </button>
              </div>
            )}
          </section>
        ) : !isMentor ? (
          <section className="panel student-pass">
            <h1>Your attendance barcode</h1>
            {person.barcode && (
              <React.Suspense fallback={<p>Loading barcode…</p>}>
                <PassCode
                  value={person.barcode}
                  label="Your attendance barcode"
                />
              </React.Suspense>
            )}
            {person.barcode && config.walletEnabled && (
              <p>
                <a
                  className="google-wallet-button"
                  href="/api/wallet/save"
                  referrerPolicy="no-referrer"
                  onClick={(event) => {
                    event.preventDefault();
                    void addToWallet();
                  }}
                >
                  <img
                    src="/enUS_add_to_google_wallet_wallet-button.svg"
                    alt="Add to Google Wallet"
                  />
                </a>
              </p>
            )}
            <p>Scan at the kiosk to clock in or out.</p>
          </section>
        ) : page === "members" ? (
          <MentorConsole administrator={isAdmin} />
        ) : page === "events" ? (
          <Events key={eventView} />
        ) : (
          <section className="panel mentor-dashboard">
            <h1>MENTOR DASHBOARD</h1>
            <p>View members, organize events, or activate the shop kiosk.</p>
            <div className="mentor-actions">{mentorActions}</div>
            {activation && (
              <React.Suspense fallback={<p>Loading QR code…</p>}>
                <ActivationPass key={activation.code} {...activation} />
              </React.Suspense>
            )}
            {person.barcode && (
              <details open className="mentor-pass">
                <summary>Your attendance barcode</summary>
                <React.Suspense fallback={<p>Loading barcode…</p>}>
                  <PassCode
                    value={person.barcode}
                    label="Your attendance barcode"
                  />
                </React.Suspense>
                <p>Scan this barcode at the kiosk to clock in or out.</p>
                {config.walletEnabled && (
                  <p>
                    <a
                      className="google-wallet-button"
                      href="/api/wallet/save"
                      referrerPolicy="no-referrer"
                      onClick={(event) => {
                        event.preventDefault();
                        void addToWallet();
                      }}
                    >
                      <img
                        src="/enUS_add_to_google_wallet_wallet-button.svg"
                        alt="Add to Google Wallet"
                      />
                    </a>
                  </p>
                )}
              </details>
            )}
            {foreignPending && (
              <div className="notice error">
                <p>
                  An unconfirmed scan from a different kiosk session needs
                  review. Check the student's attendance before clearing it.
                </p>
                <button
                  onClick={() => {
                    if (
                      confirm(
                        "Have you reviewed the prior attendance result? This clears only the local retry, not any recorded hours.",
                      )
                    ) {
                      sessionStorage.removeItem("puncher-pending");
                      sessionStorage.removeItem("puncher-pending-foreign");
                      setForeignPending(false);
                    }
                  }}
                >
                  Clear reviewed scan
                </button>
              </div>
            )}
          </section>
        )}
      </main>
      {page !== "kiosk" && (
        <footer>
          <span>STMA ROBOTICS · 7028</span>
        </footer>
      )}
    </>
  );
}
function Kiosk() {
  const [ready, setReady] = useState(false),
    [checking, setChecking] = useState(true),
    [result, setResult] = useState<any>(),
    [state, setState] = useState("ready"),
    [error, setError] = useState(""),
    [focused, setFocused] = useState(document.hasFocus()),
    [attendanceVersion, setAttendanceVersion] = useState(0),
    [shopOpen, setShopOpen] = useState<boolean>(),
    [enteredCharacters, setEnteredCharacters] = useState(0),
    [scanPulse, setScanPulse] = useState(0);
  const input = useRef<HTMLInputElement>(null),
    scannerRef = useRef<ScanBuffer | null>(null),
    generation = useRef(0),
    last = useRef(new Map<string, number>()),
    pending = useRef<any>(null),
    busy = useRef(false),
    closingTimeAudioReady = useRef<Promise<boolean> | undefined>(undefined),
    timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    let expiry: ReturnType<typeof setTimeout> | undefined;
    let expiresAt = Infinity;
    const tick = () => {
      setNow(new Date());
      if (performance.now() >= expiresAt) {
        expiresAt = Infinity;
        setReady(false);
        setError("This kiosk session ended. Scan a new mentor QR to restart.");
      }
    };
    const t = setInterval(tick, 1000);
    window.addEventListener("focus", tick);
    api("/kiosk/status")
      .then((session) => {
        const previous = sessionStorage.getItem("puncher-kiosk-session");
        if (
          sessionStorage.getItem("puncher-pending") &&
          (!previous || (session.sessionId && previous !== session.sessionId))
        )
          sessionStorage.setItem("puncher-pending-foreign", "true");
        if (session.sessionId)
          sessionStorage.setItem("puncher-kiosk-session", session.sessionId);
        if (sessionStorage.getItem("puncher-pending-foreign") === "true") {
          setError(
            "An unconfirmed scan needs mentor review before this kiosk can continue.",
          );
          return;
        }
        const remaining =
          Date.parse(session.expiresAt) - Date.parse(session.asOf);
        if (Number.isFinite(remaining)) {
          expiresAt = performance.now() + Math.max(0, remaining);
          if (remaining <= 12 * 3600_000)
            expiry = setTimeout(tick, Math.max(0, remaining));
        }
        setReady(true);
        tick();
      })
      .catch((e) => {
        if (![401, 403].includes(e.status)) setError(e.message);
      })
      .finally(() => setChecking(false));
    return () => {
      clearInterval(t);
      clearTimeout(expiry);
      window.removeEventListener("focus", tick);
      timers.current.forEach(clearTimeout);
    };
  }, []);
  const deliver = (op: any, saved: any) => {
    setResult(saved);
    setState("saved");
    setAttendanceVersion((version) => version + 1);
    setError("");
    pending.current = null;
    sessionStorage.removeItem("puncher-pending");
    if (saved.shopClosed) {
      void (closingTimeAudioReady.current ?? Promise.resolve(false))
        .then(async (ready) => {
          if (!ready) throw new Error("Audio playback is blocked.");
          await playClosingTime();
        })
        .catch(() => {
          setError(
            "Closing Time could not play. Check the kiosk audio settings.",
          );
        });
    }
    const g = ++generation.current;
    if (saved.warning) {
      timers.current.push(
        setTimeout(() => {
          if (
            generation.current === g &&
            document.visibilityState === "visible"
          )
            api(`/kiosk/operations/${op.operationId}`, {
              warningId: saved.warning.id,
            }).catch(() => {
              /* Persisted on server; later confirmations show it again. */
            });
        }, 1500),
      );
    }
    timers.current.push(
      setTimeout(
        () => {
          if (generation.current === g) {
            setState("ready");
            setResult(undefined);
          }
        },
        saved.warning ? 12000 : 5000,
      ),
    );
  };
  const send = async (op: any) => {
    if (busy.current) return;
    busy.current = true;
    pending.current = op;
    sessionStorage.setItem("puncher-pending", JSON.stringify(op));
    setState("processing");
    setError("");
    generation.current++;
    try {
      const saved = await api("/kiosk/scan", op);
      deliver(op, saved);
    } catch (e: any) {
      const kioskExpired =
        e.status === 401 || (e.status === 403 && e.message === "Forbidden");
      if (!kioskExpired && [400, 403, 404, 429].includes(e.status)) {
        pending.current = null;
        sessionStorage.removeItem("puncher-pending");
        setState("error");
        setError(e.message);
        if (e.status === 403) setAttendanceVersion((version) => version + 1);
        const g = generation.current;
        timers.current.push(
          setTimeout(() => {
            if (g === generation.current) {
              setState("ready");
              setError("");
            }
          }, 5000),
        );
      } else {
        setState("uncertain");
        setError(
          e.message ||
            "Connection interrupted. Attendance has not been confirmed.",
        );
        if (kioskExpired) setReady(false);
      }
    } finally {
      busy.current = false;
      input.current?.focus();
    }
  };
  useEffect(() => {
    if (!ready) return;
    input.current?.focus();
    try {
      const op = JSON.parse(
        sessionStorage.getItem("puncher-pending") || "null",
      );
      if (op) send(op);
    } catch {
      setError("Unresolved operation data needs mentor attention.");
      setState("uncertain");
    }
  }, [ready]);
  const submit = (card: string) => {
    if (pending.current || busy.current) return;
    setScanPulse((value) => value + 1);
    const t = Date.now();
    if (t - (last.current.get(card) || 0) < 5000) return;
    last.current.set(card, t);
    closingTimeAudioReady.current = primeClosingTimeAudio();
    send({ barcode: card, operationId: crypto.randomUUID() });
  };
  const submitRef = useRef(submit);
  submitRef.current = submit;
  useEffect(() => {
    if (!ready) return;
    input.current?.focus();
    const scanner = new ScanBuffer(
      (card) => submitRef.current(card),
      () => {
        if (pending.current || busy.current) return;
        setScanPulse((value) => value + 1);
        const g = ++generation.current;
        setError("Enter all six digits, then press Enter.");
        setState("error");
        timers.current.push(
          setTimeout(() => {
            if (generation.current === g) {
              setState("ready");
              setError("");
            }
          }, 5000),
        );
      },
      {
        onChange: setEnteredCharacters,
        async activate(code) {
          if (pending.current || busy.current) return;
          busy.current = true;
          generation.current++;
          setState("processing");
          setError("");
          try {
            await activateKioskSession(code);
          } catch (e) {
            setError(
              e instanceof Error ? e.message : "Could not activate the kiosk.",
            );
            setState("error");
            busy.current = false;
            input.current?.focus();
          }
        },
      },
    );
    scannerRef.current = scanner;
    const keydown = (e: KeyboardEvent) => {
      if (e.target instanceof Element && e.target.closest("select,button,a"))
        return;
      if (
        (e.ctrlKey || e.metaKey) &&
        !e.altKey &&
        e.key.toLowerCase() === "a"
      ) {
        e.preventDefault();
        scanner.selectAll();
        return;
      }
      if (e.ctrlKey || e.altKey || e.metaKey) return;
      if (
        e.key.length === 1 ||
        ["Enter", "Backspace", "Delete", "Escape"].includes(e.key)
      ) {
        e.preventDefault();
        scanner.key(e.key, Date.now());
      }
    };
    const focus = () => {
        setFocused(true);
        scanner.clear();
        input.current?.focus();
      },
      blur = () => {
        setFocused(false);
        scanner.clear();
      };
    window.addEventListener("keydown", keydown);
    window.addEventListener("focus", focus);
    window.addEventListener("blur", blur);
    return () => {
      if (scannerRef.current === scanner) scannerRef.current = null;
      window.removeEventListener("keydown", keydown);
      window.removeEventListener("focus", focus);
      window.removeEventListener("blur", blur);
    };
  }, [ready]);
  async function endKiosk() {
    if (pending.current || busy.current) {
      setError("Finish the pending scan before ending the kiosk.");
      return;
    }
    try {
      await api("/kiosk/end", {});
      sessionStorage.removeItem("puncher-kiosk-session");
      window.location.replace("/");
    } catch (e: any) {
      setError(e.message);
    }
  }
  return (
    <div className="kiosk">
      {ready && (
        <div className="kiosk-topline">
          <button className="secondary" onClick={endKiosk}>
            End kiosk
          </button>
          <div className="clock">
            {new Intl.DateTimeFormat("en-US", {
              timeZone: "America/Chicago",
              hour: "numeric",
              minute: "2-digit",
            }).format(now)}
            <small>
              {new Intl.DateTimeFormat("en-US", {
                timeZone: "America/Chicago",
                weekday: "long",
                month: "long",
                day: "numeric",
              }).format(now)}
            </small>
          </div>
        </div>
      )}
      {checking ? (
        <p>Checking kiosk session…</p>
      ) : !ready &&
        sessionStorage.getItem("puncher-pending-foreign") !== "true" ? (
        <KioskActivation initialError={error} />
      ) : !ready ? (
        <section className="panel setup">
          <h2>KIOSK LOCKED</h2>
          <p>An unconfirmed scan needs mentor review.</p>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <button onClick={() => window.location.replace("/")}>
            Mentor log in
          </button>
        </section>
      ) : (
        <>
          <section
            className={`scan-panel ${state}${shopOpen === false ? " closed" : ""}`}
            aria-live="polite"
            aria-atomic="true"
          >
            <ScanEffects pulse={scanPulse} />
            <div className="scan-status">
              <span className={`dot ${shopOpen === true ? "" : "amber"}`} />
              {shopOpen === true
                ? "SHOP OPEN"
                : shopOpen === false
                  ? "SHOP CLOSED"
                  : "CHECKING SHOP"}
            </div>
            <input
              ref={input}
              className="scanner-input"
              aria-label="Student ID scanner input"
              autoComplete="off"
              onPaste={(event) => {
                event.preventDefault();
                const value = event.clipboardData.getData("text").trim();
                const scanner = scannerRef.current;
                if (!value || !scanner) return;
                const now = Date.now();
                for (const character of value) scanner.key(character, now);
                scanner.key("Enter", now);
              }}
              onBlur={(event) => {
                const target = event.relatedTarget;
                if (
                  document.hasFocus() &&
                  !(
                    target instanceof Element &&
                    target.closest("select,button,a,input,textarea")
                  )
                )
                  input.current?.focus();
              }}
            />
            <div className="scan-content">
              {state === "processing" ? (
                <>
                  <h2>SAVING…</h2>
                </>
              ) : state === "saved" ? (
                <>
                  <p className="eyebrow">{result.displayName}</p>
                  <h2>
                    {result.state === "in"
                      ? "CLOCKED IN"
                      : result.state === "out"
                        ? "CLOCKED OUT"
                        : "SCAN ALREADY RECEIVED"}
                  </h2>
                  <p>
                    {result.state === "out"
                      ? `${time(result.startedAt)} → ${time(result.endedAt)} · ${duration(result.creditedSeconds)}`
                      : time(result.startedAt)}
                  </p>
                  {result.todaySeconds !== undefined && (
                    <p>
                      Today <strong>{duration(result.todaySeconds)}</strong>
                    </p>
                  )}
                  {result.warning && (
                    <div className="warning">
                      No checkout on {result.warning.shopDate}: 0 hours for that
                      visit. Remember to scan out.
                    </div>
                  )}
                </>
              ) : state === "uncertain" ? (
                <>
                  <h2>SCAN NOT CONFIRMED</h2>
                  <p className="error">{error}</p>
                  <p>Retrying. Don’t scan again yet.</p>
                  <button
                    onClick={() => pending.current && send(pending.current)}
                  >
                    Retry
                  </button>
                </>
              ) : state === "error" ? (
                <>
                  <h2>SCAN FAILED</h2>
                  <p className="error">{error}</p>
                </>
              ) : (
                <>
                  <h2>
                    {shopOpen === false ? "SCAN TO CLOCK OUT" : "SCAN YOUR ID"}
                  </h2>
                </>
              )}
              {shopOpen === false && (
                <p>Clock-outs only. Attendance time is paused.</p>
              )}
              {!focused && (
                <p className="warning">
                  Select this window to resume scanning.
                </p>
              )}
            </div>
            {enteredCharacters > 0 &&
              state !== "processing" &&
              state !== "uncertain" && (
                <div
                  className="scan-entry"
                  role="status"
                  aria-label={`${enteredCharacters} of 6 characters entered`}
                >
                  {Array.from({ length: 6 }, (_, index) => (
                    <span
                      key={index}
                      className={index < enteredCharacters ? "filled" : ""}
                      aria-hidden="true"
                    />
                  ))}
                </div>
              )}
          </section>
          <ShopTotals />
          <InShop revision={attendanceVersion} onShopState={setShopOpen} />
          <Retry pending={pending} send={send} state={state} />
        </>
      )}
    </div>
  );
}
function Retry({ pending, send, state }: any) {
  useEffect(() => {
    if (state !== "uncertain") return;
    const t = setInterval(() => {
      if (navigator.onLine && pending.current) send(pending.current);
    }, 7000);
    return () => clearInterval(t);
  }, [state]);
  return null;
}
type Occupant = { displayName: string; picture?: string };
function Avatar({
  picture,
  name,
  className = "",
}: {
  picture?: string;
  name: string;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  return (
    <span className={`profile-avatar ${className}`} aria-hidden="true">
      {picture && !failed ? (
        <img
          src={picture}
          alt=""
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
        />
      ) : (
        name.trim().charAt(0).toUpperCase() || "?"
      )}
    </span>
  );
}
function InShop({
  revision,
  onShopState,
}: {
  revision: number;
  onShopState: (open: boolean | undefined) => void;
}) {
  const [presence, setPresence] = useState<{
      mentors: Occupant[];
      occupants: Occupant[];
    }>(),
    [status, setStatus] = useState<"loading" | "ready" | "unavailable">(
      "loading",
    );
  useEffect(() => {
    let active = true,
      request = 0,
      expiry: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      const sequence = ++request,
        started = performance.now();
      try {
        const data = await api("/kiosk/occupants");
        if (!active || sequence !== request) return;
        const remaining =
          Date.parse(data.validUntil) -
          Date.parse(data.asOf) -
          (performance.now() - started);
        if (remaining <= 0) throw new Error("Attendance expired.");
        clearTimeout(expiry);
        setPresence({ mentors: data.mentors ?? [], occupants: data.occupants });
        onShopState(data.shopOpen);
        setStatus("ready");
        expiry = setTimeout(() => {
          if (active) {
            setPresence(undefined);
            onShopState(undefined);
            setStatus("unavailable");
          }
        }, remaining);
      } catch {
        if (active && sequence === request) {
          clearTimeout(expiry);
          setPresence(undefined);
          onShopState(undefined);
          setStatus("unavailable");
        }
      }
    };
    load();
    const poll = setInterval(load, 10000);
    window.addEventListener("focus", load);
    return () => {
      active = false;
      clearInterval(poll);
      clearTimeout(expiry);
      window.removeEventListener("focus", load);
    };
  }, [revision, onShopState]);
  const count =
    (presence?.mentors.length ?? 0) + (presence?.occupants.length ?? 0);
  const groups = [
    { label: "Mentors", people: presence?.mentors ?? [] },
    { label: "Students", people: presence?.occupants ?? [] },
  ];
  return (
    <section className="in-shop" aria-labelledby="in-shop-title">
      <div className="in-shop-heading">
        <h2 id="in-shop-title">IN THE SHOP</h2>
        {status === "ready" && (
          <span
            className="presence-count"
            aria-label={`${count} people in the shop`}
          >
            <span className="dot" />
            {count} here
          </span>
        )}
      </div>
      {status === "loading" ? (
        <p className="presence-empty">Loading…</p>
      ) : status === "unavailable" ? (
        <p className="presence-empty" role="status">
          Current attendance is unavailable.
        </p>
      ) : count === 0 ? (
        <p className="presence-empty">No one is clocked in.</p>
      ) : (
        <div className="presence-columns">
          {groups.map(({ label, people }) => {
            const named = people.filter(({ displayName }) => displayName);
            return (
              <section key={label} aria-label={label}>
                <h3>{label}</h3>
                {named.length === 0 ? (
                  <p className="presence-empty">
                    {people.length
                      ? "No names to display."
                      : "None clocked in."}
                  </p>
                ) : (
                  <ul className="presence-grid">
                    {named.map(({ displayName, picture }, index) => (
                      <li
                        className="presence-card"
                        key={displayName + "-" + index}
                      >
                        <Avatar picture={picture} name={displayName} />
                        <span className="presence-name">{displayName}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            );
          })}
        </div>
      )}
    </section>
  );
}
function ShopTotals() {
  const [totals, setTotals] = useState<{
      weekSeconds: number;
      yearSeconds: number;
      allTimeSeconds: number;
      updatedAt: string;
    }>(),
    [unavailable, setUnavailable] = useState(false);
  useEffect(() => {
    let active = true;
    const load = () =>
      api("/kiosk/totals")
        .then((data) => {
          if (active) {
            setTotals(data);
            setUnavailable(false);
          }
        })
        .catch(() => {
          if (active) setUnavailable(true);
        });
    load();
    const timer = setInterval(load, 60000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);
  const hours = (seconds: number) =>
    new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(
      seconds / 3600,
    );
  return (
    <section className="shop-totals" aria-labelledby="shop-totals-title">
      <div className="totals-heading">
        <h2 id="shop-totals-title">SHOP HOURS</h2>
        {(unavailable || !totals) && (
          <span>{unavailable ? "Unavailable" : "Loading…"}</span>
        )}
      </div>
      <dl>
        {[
          ["This week", totals?.weekSeconds],
          ["This year", totals?.yearSeconds],
          ["All time", totals?.allTimeSeconds],
        ].map(([label, seconds]) => (
          <div key={label as string}>
            <dt
              title={
                label === "This year"
                  ? "Team year: June 2 – June 1"
                  : label === "This week"
                    ? "Monday – Sunday, America/Chicago"
                    : undefined
              }
            >
              {label}
            </dt>
            <dd>
              {typeof seconds === "number" && !unavailable
                ? hours(seconds)
                : "—"}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
type EventSummary = {
  eventId: string;
  title: string;
  eventDate: string;
  eventType: EventType;
  durationSeconds: number;
  notes: string;
  participantCount: number;
};
type EventParticipant = Pick<DirectoryMember, "memberId" | "displayName"> & {
  creditedSeconds: number;
};
const eventLabels: Record<EventType, string> = {
  OUTREACH: "Outreach",
  COMPETITION: "Competition",
};

function Events() {
  const [events, setEvents] = useState<EventSummary[]>([]),
    [selectedId, setSelectedId] = useState<string>(),
    [error, setError] = useState(""),
    [form, setForm] = useState(true),
    [editing, setEditing] = useState<EventSummary>(),
    [loading, setLoading] = useState(true),
    [saving, setSaving] = useState(false);
  const selected = events.find((event) => event.eventId === selectedId);
  useEffect(() => {
    api("/events")
      .then(setEvents)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);
  async function create(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(e.currentTarget));
    setSaving(true);
    setError("");
    try {
      const saved: EventSummary = await api(
        editing ? `/events/${editing.eventId}` : "/events",
        data,
        editing ? "PATCH" : "POST",
      );
      setEvents((current) =>
        editing
          ? current.map((event) =>
              event.eventId === saved.eventId ? saved : event,
            )
          : [saved, ...current],
      );
      setSelectedId(saved.eventId);
      setForm(false);
      setEditing(undefined);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }
  return (
    <>
      <div className="page-heading">
        <h1 className="event-heading">Create Event</h1>
        <button
          disabled={saving}
          onClick={() => {
            setEditing(undefined);
            setForm(!form);
          }}
        >
          {form ? "Cancel" : "+ New event"}
        </button>
      </div>
      {error && (
        <p role="alert" className="notice error">
          {error}
        </p>
      )}
      {form && (
        <section className="panel">
          {editing && <h2>Edit Event</h2>}
          <form
            key={editing?.eventId || "new"}
            onSubmit={create}
            className="form-grid"
          >
            <label>
              Event title
              <input
                name="title"
                required
                maxLength={120}
                placeholder="Community open house"
                defaultValue={editing?.title}
              />
            </label>
            <label>
              Event type
              <select
                name="eventType"
                defaultValue={editing?.eventType ?? "OUTREACH"}
              >
                <option value="OUTREACH">Outreach</option>
                <option value="COMPETITION">Competition</option>
              </select>
            </label>
            <label>
              Local event date
              <input
                name="eventDate"
                type="date"
                required
                defaultValue={editing?.eventDate}
              />
            </label>
            <label>
              Hours per participant
              <input
                name="hours"
                inputMode="decimal"
                required
                placeholder="2.5"
                defaultValue={
                  editing ? String(editing.durationSeconds / 3600) : ""
                }
              />
            </label>
            <label>
              Notes (optional)
              <input
                name="notes"
                maxLength={2000}
                defaultValue={editing?.notes}
              />
            </label>
            <button disabled={loading || saving}>
              {saving ? "Saving…" : editing ? "Save event" : "Create event"}
            </button>
          </form>
        </section>
      )}
      <div className="event-layout">
        <section>
          <div className="section-label">
            EVENTS <span>{events.length}</span>
          </div>
          {loading ? (
            <p className="muted">Loading events…</p>
          ) : events.length === 0 ? (
            <div className="panel empty">
              <p>No events yet.</p>
            </div>
          ) : (
            events.map((e) => (
              <button
                className={`event-card ${selected?.eventId === e.eventId ? "chosen" : ""}`}
                key={e.eventId}
                onClick={() => setSelectedId(e.eventId)}
              >
                <span className="event-date">{e.eventDate}</span>
                <strong>{e.title}</strong>
                <span>
                  {eventLabels[e.eventType]} · {duration(e.durationSeconds)} per
                  student <span className="footer-dot">·</span>{" "}
                  {e.participantCount}{" "}
                  {e.participantCount === 1 ? "participant" : "participants"}
                </span>
                <span className="card-arrow">↗</span>
              </button>
            ))
          )}
        </section>
        <section className="panel event-detail">
          {!selected ? (
            <div className="empty">
              <p>Select an event.</p>
            </div>
          ) : (
            <>
              <p className="eyebrow">
                {eventLabels[selected.eventType]} / {selected.eventDate} /{" "}
                {duration(selected.durationSeconds)} each
              </p>
              <h2 className="natural-title">{selected.title}</h2>
              <p className="muted">{selected.notes}</p>
              <button
                className="quiet"
                onClick={() => {
                  setEditing(selected);
                  setForm(true);
                }}
              >
                Edit event
              </button>
              <EventAttendance
                key={selected.eventId}
                eventId={selected.eventId}
                onChange={(count) =>
                  setEvents((current) =>
                    current.map((event) =>
                      event.eventId === selected.eventId
                        ? { ...event, participantCount: count }
                        : event,
                    ),
                  )
                }
              />
            </>
          )}
        </section>
      </div>
    </>
  );
}
function EventAttendance({
  eventId,
  onChange,
}: {
  eventId: string;
  onChange: (count: number) => void;
}) {
  const [members, setMembers] = useState<DirectoryMember[]>();
  const [participants, setParticipants] = useState<EventParticipant[]>([]);
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const path = `/events/${eventId}/participants`;
  useEffect(() => {
    Promise.all([api("/mentor/members"), api(path)])
      .then(([directory, roster]) => {
        setParticipants(roster);
        setMembers(
          directory.filter((m: DirectoryMember) => m.role === "STUDENT"),
        );
      })
      .catch((e) => setError(e.message));
  }, [path]);
  const added = new Set(participants.map((m) => m.memberId));
  const matches = members?.filter(
    (m) =>
      !added.has(m.memberId) &&
      m.displayName.toLowerCase().includes(search.trim().toLowerCase()),
  );
  async function add(m: DirectoryMember) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const { displayName, creditedSeconds } = await api(path, {
        memberId: m.memberId,
      });
      const next = [
        ...participants,
        { memberId: m.memberId, displayName, creditedSeconds },
      ];
      setParticipants(next);
      onChange(next.length);
      setMessage(
        `${displayName} added · ${duration(creditedSeconds)} credited`,
      );
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function remove(m: EventParticipant) {
    const reason = prompt(
      `Remove ${m.displayName} from this event? Enter the correction reason.`,
    );
    if (!reason) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await api(
        `${path}/${encodeURIComponent(m.memberId)}`,
        { reason },
        "DELETE",
      );
      const next = participants.filter(
        (participant) => participant.memberId !== m.memberId,
      );
      setParticipants(next);
      onChange(next.length);
      setMessage(`${m.displayName} removed`);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <section className="event-picker" aria-label="Add participants">
        <label>
          Search students
          <input
            type="search"
            placeholder="Search by name"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        {matches ? (
          matches.length > 0 ? (
            <ul className="event-member-list">
              {matches.map((m) => (
                <li key={m.memberId} className="list-row">
                  <span>{m.displayName}</span>
                  <button
                    disabled={busy}
                    onClick={() => add(m)}
                    aria-label={`Add ${m.displayName}`}
                  >
                    Add
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">
              {search.trim()
                ? "No available students match your search."
                : "No students available to add."}
            </p>
          )
        ) : (
          !error && <p className="muted">Loading students…</p>
        )}
      </section>
      {error && (
        <p role="alert" className="notice error">
          {error}
        </p>
      )}
      <p role="status" className="success">
        {message}
      </p>
      <section aria-label="Participants">
        <div className="section-label">
          PARTICIPANTS <span>{participants.length}</span>
        </div>
        {participants.map((m) => (
          <div className="list-row" key={m.memberId}>
            <span>
              {m.displayName}
              <small>{duration(m.creditedSeconds)} credited</small>
            </span>
            <button
              className="quiet danger"
              disabled={busy}
              onClick={() => remove(m)}
            >
              Remove
            </button>
          </div>
        ))}
      </section>
    </>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
