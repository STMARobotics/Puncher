import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource/figtree/400.css";
import "@fontsource/figtree/500.css";
import "@fontsource/figtree/600.css";
import "@fontsource/figtree/700.css";
import "@fontsource/figtree/800.css";
import "./style.css";
import { api, setToken, duration, time } from "./api";
import { ScanBuffer } from "./scanner";
import { ScanEffects } from "./scan-effects";
import { PuncherMark } from "./puncher-mark";
const Camera = React.lazy(() =>
  import("./camera").then((module) => ({ default: module.Camera })),
);
type Config = {
  googleClientId: string;
  statsUrl: string;
  localFixtures: boolean;
};
type Person = { id: string; roles: string[] };
function App() {
  const [config, setConfig] = useState<Config>(),
    [page, setPage] = useState(
      location.pathname === "/kiosk" ? "kiosk" : "events",
    ),
    [person, setPerson] = useState<Person>(),
    [error, setError] = useState("");
  useEffect(() => {
    const expired = () => {
      setPerson(undefined);
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
  const signIn = async (credential: string) => {
    try {
      setToken(credential);
      setPerson(await api("/me"));
      setError("");
    } catch (e: any) {
      setError(e.message);
      setToken("");
    }
  };
  useEffect(() => {
    if (!config?.googleClientId || person) return;
    let disposed = false;
    const script = document.createElement("script");
    script.src = "https://accounts.google.com/gsi/client";
    script.async = true;
    script.onload = () => {
      if (disposed) return;
      const g = (window as any).google;
      g.accounts.id.initialize({
        client_id: config.googleClientId,
        hd: "stmarobotics.org",
        callback: (r: any) => signIn(r.credential),
      });
      const el = document.getElementById("google-signin");
      if (el)
        g.accounts.id.renderButton(el, {
          theme: "filled_black",
          size: "large",
        });
    };
    document.head.append(script);
    return () => {
      disposed = true;
      script.remove();
    };
  }, [config, person, page]);
  function navigate(next: string) {
    setPage(next);
    history.pushState(null, "", next === "kiosk" ? "/kiosk" : "/");
    setError("");
  }
  return (
    <>
      <header className={page === "kiosk" ? "kiosk-header" : ""}>
        <a
          className="brand"
          href="/"
          onClick={(e) => {
            e.preventDefault();
            navigate("events");
          }}
        >
          <span className="brand-icon">
            <PuncherMark />
          </span>
          <span className="brand-wordmark">PUNCHER</span>
        </a>
        <nav aria-label="Main navigation">
          {page === "kiosk" ? (
            <>
              <button onClick={() => navigate("events")}>Staff</button>
            </>
          ) : (
            <>
              <button
                className={page === "kiosk" ? "selected" : ""}
                onClick={() => navigate("kiosk")}
              >
                Shop kiosk
              </button>
              {person && (
                <button
                  className={page === "events" ? "selected" : ""}
                  onClick={() => navigate("events")}
                >
                  Volunteer
                </button>
              )}
              {person?.roles.includes("admin") && (
                <button
                  className={page === "admin" ? "selected" : ""}
                  onClick={() => navigate("admin")}
                >
                  Operations
                </button>
              )}
              <a href={config?.statsUrl || "#"}>
                View hours <span aria-hidden>↗</span>
              </a>
              {person && (
                <button
                  onClick={() => {
                    setPerson(undefined);
                    setToken("");
                  }}
                >
                  Sign out
                </button>
              )}
            </>
          )}
        </nav>
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
            <p>Use your stmarobotics.org account.</p>
            <div id="google-signin" />
            {!config.googleClientId && (
              <p className="muted">Google sign-in is not configured.</p>
            )}
            {config.localFixtures && (
              <div className="fixture-buttons">
                <button onClick={() => signIn("local-admin")}>
                  Local administrator
                </button>
                <button
                  className="secondary"
                  onClick={() => signIn("local-mentor")}
                >
                  Local mentor
                </button>
                <button
                  className="secondary"
                  onClick={() => signIn("local-student")}
                >
                  Local student
                </button>
              </div>
            )}
            <a
              className="text-link"
              href="/kiosk"
              onClick={(e) => {
                e.preventDefault();
                navigate("kiosk");
              }}
            >
              Shop kiosk
            </a>
          </section>
        ) : page === "admin" && person.roles.includes("admin") ? (
          <Admin />
        ) : person.roles.some((r) => ["mentor", "admin"].includes(r)) ? (
          <Events />
        ) : (
          <section className="panel">
            <h1>VIEW YOUR HOURS</h1>
            <p>Student hours are available in Stats.</p>
            <a href={config.statsUrl}>Open Stats ↗</a>
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
    [credential, setCredential] = useState(""),
    [result, setResult] = useState<any>(),
    [state, setState] = useState("ready"),
    [error, setError] = useState(""),
    [focused, setFocused] = useState(document.hasFocus()),
    [attendanceVersion, setAttendanceVersion] = useState(0),
    [enteredCharacters, setEnteredCharacters] = useState(0),
    [scanPulse, setScanPulse] = useState(0);
  const input = useRef<HTMLInputElement>(null),
    generation = useRef(0),
    last = useRef(new Map<string, number>()),
    pending = useRef<any>(null),
    busy = useRef(false),
    timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    api("/kiosk/status")
      .then(() => setReady(true))
      .catch((e) => setError(e.message))
      .finally(() => setChecking(false));
    return () => {
      clearInterval(t);
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
      if ([400, 403, 404, 429].includes(e.status)) {
        pending.current = null;
        sessionStorage.removeItem("puncher-pending");
        setState("error");
        setError(e.message);
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
        if (e.status === 401) setReady(false);
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
      setError("Unresolved operation data needs adult attention.");
      setState("uncertain");
    }
  }, [ready]);
  const submit = (card: string) => {
    if (pending.current || busy.current) return;
    setScanPulse((value) => value + 1);
    const t = Date.now();
    if (t - (last.current.get(card) || 0) < 5000) return;
    last.current.set(card, t);
    send({ barcode: card, operationId: crypto.randomUUID() });
  };
  const submitRef = useRef(submit);
  submitRef.current = submit;
  useEffect(() => {
    if (!ready) return;
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
      { onChange: setEnteredCharacters },
    );
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
      window.removeEventListener("keydown", keydown);
      window.removeEventListener("focus", focus);
      window.removeEventListener("blur", blur);
    };
  }, [ready]);
  async function setup(e: React.FormEvent) {
    e.preventDefault();
    try {
      await api("/kiosk/setup", { credential });
      setCredential("");
      setReady(true);
      setError("");
    } catch (e: any) {
      setError(e.message);
    }
  }
  return (
    <div className="kiosk">
      <div className="kiosk-topline">
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
      {checking ? (
        <p>Checking device authorization…</p>
      ) : !ready ? (
        <section className="panel setup">
          <h2>DEVICE SETUP</h2>
          <p>Enter the credential from your administrator.</p>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <form onSubmit={setup}>
            <label>
              Device credential
              <input
                type="password"
                autoComplete="off"
                required
                value={credential}
                onChange={(e) => setCredential(e.target.value)}
              />
            </label>
            <button>Authorize this kiosk</button>
          </form>
        </section>
      ) : (
        <>
          <section
            className={`scan-panel ${state}`}
            aria-live="polite"
            aria-atomic="true"
          >
            <ScanEffects pulse={scanPulse} />
            <div className="scan-status">
              <span className={`dot ${focused ? "" : "amber"}`} />
              {focused
                ? state === "processing"
                  ? "SAVING"
                  : state === "uncertain"
                    ? "CONNECTION ISSUE"
                    : "READY"
                : "WINDOW NEEDS FOCUS"}
            </div>
            <input
              ref={input}
              className="scanner-input"
              aria-label="Student ID scanner input"
              autoComplete="off"
              onPaste={(e) => {
                e.preventDefault();
                if (pending.current || busy.current) return;
                const g = ++generation.current;
                setError("Pasted card data is not accepted. Scan your card.");
                setState("error");
                timers.current.push(
                  setTimeout(() => {
                    if (generation.current === g) {
                      setState("ready");
                      setError("");
                    }
                  }, 5000),
                );
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
                <h2>SCAN YOUR ID</h2>
              </>
            )}
            {!focused && (
              <p className="warning">Select this window to resume scanning.</p>
            )}
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
          <InShop revision={attendanceVersion} />
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
function InShop({ revision }: { revision: number }) {
  const [occupants, setOccupants] = useState<
      { displayName: string }[] | undefined
    >(),
    [status, setStatus] = useState<"loading" | "ready" | "unavailable">(
      "loading",
    );
  useEffect(() => {
    setOccupants(undefined);
    setStatus("loading");
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
        setOccupants(data.occupants);
        setStatus("ready");
        expiry = setTimeout(() => {
          if (active) {
            setOccupants(undefined);
            setStatus("unavailable");
          }
        }, remaining);
      } catch {
        if (active && sequence === request) {
          clearTimeout(expiry);
          setOccupants(undefined);
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
  }, [revision]);
  const initials = (name: string) =>
    name
      .trim()
      .split(/\s+/)
      .map((part) => Array.from(part)[0])
      .filter(Boolean)
      .slice(0, 2)
      .join("")
      .toUpperCase();
  return (
    <section className="in-shop" aria-labelledby="in-shop-title">
      <div className="in-shop-heading">
        <h2 id="in-shop-title">IN THE SHOP</h2>
        {status === "ready" && (
          <span
            className="presence-count"
            aria-label={`${occupants!.length} people in the shop`}
          >
            <span className="dot" />
            {occupants!.length} here
          </span>
        )}
      </div>
      {status === "loading" ? (
        <p className="presence-empty">Loading…</p>
      ) : status === "unavailable" ? (
        <p className="presence-empty" role="status">
          Current attendance is unavailable.
        </p>
      ) : occupants!.length === 0 ? (
        <p className="presence-empty">No one is clocked in.</p>
      ) : (
        <ul className="presence-grid">
          {occupants!.map(({ displayName }, index) => (
            <li className="presence-card" key={`${displayName}-${index}`}>
              <span className="presence-avatar" aria-hidden="true">
                {initials(displayName)}
              </span>
              <span className="presence-name">{displayName}</span>
              <span className="presence-indicator" aria-hidden="true" />
            </li>
          ))}
        </ul>
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
function Events() {
  const [events, setEvents] = useState<any[]>([]),
    [selected, setSelected] = useState<any>(),
    [participants, setParticipants] = useState<any[]>([]),
    [error, setError] = useState(""),
    [message, setMessage] = useState(""),
    [form, setForm] = useState(false),
    [editing, setEditing] = useState<any>(),
    [camera, setCamera] = useState(false);
  const inflight = useRef(new Set<string>());
  const load = () =>
    api("/events")
      .then(setEvents)
      .catch((e) => setError(e.message));
  useEffect(() => {
    load();
  }, []);
  const roster = (id: string) =>
    api(`/events/${id}/participants`)
      .then(setParticipants)
      .catch((e) => setError(e.message));
  async function create(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(e.currentTarget));
    try {
      const saved = await api(
        editing ? `/events/${editing.eventId}` : "/events",
        data,
        editing ? "PATCH" : "POST",
      );
      if (editing) setSelected(saved);
      setForm(false);
      setEditing(undefined);
      load();
    } catch (e: any) {
      setError(e.message);
    }
  }
  async function scan(card: string) {
    if (!selected || inflight.current.has(card)) return;
    inflight.current.add(card);
    try {
      const r = await api(`/events/${selected.eventId}/scan`, {
        barcode: card,
      });
      setMessage(
        `${r.displayName} · ${r.state === "already" ? "Already logged" : `${duration(r.creditedSeconds)} awarded`}`,
      );
      setError("");
      roster(selected.eventId);
      load();
    } catch (e: any) {
      setError(e.message);
    } finally {
      inflight.current.delete(card);
    }
  }
  async function remove(m: any) {
    const reason = prompt(
      `Remove ${m.displayName} from this event? Enter the correction reason.`,
    );
    if (!reason) return;
    try {
      await api(
        `/events/${selected.eventId}/participants/${m.memberId}`,
        { reason },
        "DELETE",
      );
      roster(selected.eventId);
      load();
    } catch (e: any) {
      setError(e.message);
    }
  }
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>VOLUNTEER EVENTS</h1>
        </div>
        <button
          onClick={() => {
            setEditing(undefined);
            setForm(!form);
          }}
        >
          + New event
        </button>
      </div>
      {error && (
        <p role="alert" className="notice error">
          {error}
        </p>
      )}
      {form && (
        <section className="panel">
          <h2>{editing ? "EDIT EVENT" : "CREATE AN EVENT"}</h2>
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
            <button>{editing ? "Save event" : "Create event"}</button>
          </form>
        </section>
      )}
      <div className="event-layout">
        <section>
          <div className="section-label">
            EVENTS <span>{events.length}</span>
          </div>
          {events.length === 0 ? (
            <div className="panel empty">
              <p>No events yet.</p>
            </div>
          ) : (
            events.map((e) => (
              <button
                className={`event-card ${selected?.eventId === e.eventId ? "chosen" : ""}`}
                key={e.eventId}
                onClick={() => {
                  setSelected(e);
                  setCamera(false);
                  setMessage("");
                  roster(e.eventId);
                }}
              >
                <span className="event-date">{e.eventDate}</span>
                <strong>{e.title}</strong>
                <span>
                  {duration(e.durationSeconds)} per student{" "}
                  <span className="footer-dot">·</span> {e.participantCount}{" "}
                  participants
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
                {selected.eventDate} / {duration(selected.durationSeconds)} EACH
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
              <button onClick={() => setCamera(!camera)}>
                {camera ? "Close scanner" : "Open camera scanner"}
              </button>
              {camera && (
                <React.Suspense fallback={<p>Loading camera scanner…</p>}>
                  <Camera key={selected.eventId} onCard={scan} />
                </React.Suspense>
              )}
              <form
                className="inline-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  const f = e.currentTarget;
                  const card = new FormData(f).get("barcode") as string;
                  scan(card);
                  f.reset();
                }}
              >
                <label>
                  USB scanner / manual fallback
                  <input
                    name="barcode"
                    pattern="[0-9]{6}"
                    maxLength={6}
                    inputMode="numeric"
                    autoComplete="off"
                    required
                    aria-label="Volunteer student card"
                  />
                </label>
                <button>Log card</button>
              </form>
              <p role="status" className="success">
                {message}
              </p>
              <div className="section-label">
                PARTICIPANTS <span>{participants.length}</span>
              </div>
              {participants.map((m) => (
                <div className="list-row" key={m.memberId}>
                  <span>
                    {m.displayName}
                    <small>{duration(m.creditedSeconds)} credited</small>
                  </span>
                  <button className="quiet danger" onClick={() => remove(m)}>
                    Remove
                  </button>
                </div>
              ))}
            </>
          )}
        </section>
      </div>
    </>
  );
}
function Admin() {
  const [tab, setTab] = useState("members"),
    [items, setItems] = useState<any[]>([]),
    [error, setError] = useState(""),
    [message, setMessage] = useState(""),
    [editing, setEditing] = useState<any>(),
    [cursor, setCursor] = useState<string>(),
    [fresh, setFresh] = useState(0);
  const load = (next?: string) =>
    api(`/admin/${tab}${next ? `?cursor=${encodeURIComponent(next)}` : ""}`)
      .then((r) => {
        setItems((prev) =>
          next ? [...prev, ...(r.items || [])] : Array.isArray(r) ? r : r.items,
        );
        setCursor(r.cursor);
      })
      .catch((e) => setError(e.message));
  useEffect(() => {
    setItems([]);
    setEditing(undefined);
    setError("");
    load();
  }, [tab, fresh]);
  async function save(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = e.currentTarget;
    const d: any = Object.fromEntries(new FormData(f));
    if (tab === "members") {
      d.active = d.active === "on";
    }
    if (tab === "identities") {
      d.enabled = d.enabled === "on";
      d.roles = d.roles
        .split(",")
        .map((x: string) => x.trim())
        .filter(Boolean);
    }
    try {
      const r = await api(
        `/admin/${tab}${editing?.memberId && tab === "members" ? `/${editing.memberId}` : ""}`,
        d,
        editing && tab === "members" ? "PATCH" : "POST",
      );
      setMessage(
        r.credential
          ? `Copy this one-time device credential: ${r.credential}`
          : "Saved.",
      );
      setEditing(undefined);
      setFresh((x) => x + 1);
      f.reset();
    } catch (e: any) {
      setError(e.message);
    }
  }
  async function review(item: any, status: string) {
    const reason = prompt(
      `Set this imported credit to ${status}? Enter a review reason.`,
    );
    if (!reason) return;
    try {
      await api("/admin/review", {
        pk: item.recordPk,
        sk: item.recordSk,
        status,
        reason,
      });
      setFresh((x) => x + 1);
    } catch (e: any) {
      setError(e.message);
    }
  }
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>SHOP OPERATIONS</h1>
        </div>
        <button className="secondary" onClick={() => setFresh((x) => x + 1)}>
          Refresh
        </button>
      </div>
      <div className="tabs" role="navigation" aria-label="Operations sections">
        {["members", "active", "identities", "devices", "review", "audit"].map(
          (t) => (
            <button
              className={tab === t ? "selected" : ""}
              key={t}
              onClick={() => {
                setTab(t);
                setMessage("");
              }}
            >
              {t === "active"
                ? "In shop"
                : t === "review"
                  ? "Import review"
                  : t}
            </button>
          ),
        )}
      </div>
      {error && (
        <p role="alert" className="notice error">
          {error}
        </p>
      )}
      {message && (
        <p role="status" className="notice success sensitive">
          {message}
        </p>
      )}
      {["members", "identities", "devices"].includes(tab) && (
        <section className="panel">
          <h2>
            {editing ? "EDIT" : "ADD"}{" "}
            {tab === "identities"
              ? "IDENTITY MAPPING"
              : tab === "devices"
                ? "KIOSK DEVICE"
                : "MEMBER"}
          </h2>
          <form
            key={`${tab}-${editing?.memberId || editing?.googleSub || fresh}`}
            onSubmit={save}
            className="form-grid"
          >
            {tab === "members" ? (
              <>
                <label>
                  Display name
                  <input
                    required
                    name="displayName"
                    defaultValue={editing?.displayName}
                    maxLength={100}
                  />
                </label>
                <label>
                  Member kind
                  <select
                    name="memberKind"
                    defaultValue={editing?.memberKind || "student"}
                  >
                    <option>student</option>
                    <option>mentor</option>
                  </select>
                </label>
                <label>
                  Six-digit card (optional)
                  <input
                    name="barcode"
                    defaultValue={editing?.barcode}
                    pattern="[0-9]{6}"
                    maxLength={6}
                    inputMode="numeric"
                    autoComplete="off"
                  />
                </label>
                <label className="checkbox">
                  <input
                    name="active"
                    type="checkbox"
                    defaultChecked={editing?.active ?? true}
                  />{" "}
                  Active member
                </label>
              </>
            ) : tab === "identities" ? (
              <>
                <label>
                  Verified Google subject
                  <input
                    name="googleSub"
                    required
                    defaultValue={editing?.googleSub}
                  />
                </label>
                <label>
                  Verified robotics email
                  <input
                    name="email"
                    type="email"
                    required
                    defaultValue={editing?.email}
                  />
                </label>
                <label>
                  Internal member ID (optional)
                  <input name="memberId" defaultValue={editing?.memberId} />
                </label>
                <label>
                  Roles (comma separated)
                  <input
                    name="roles"
                    required
                    defaultValue={
                      editing?.roles?.join(",") || "student,stats:student"
                    }
                  />
                </label>
                <label className="checkbox">
                  <input
                    name="enabled"
                    type="checkbox"
                    defaultChecked={editing?.enabled ?? true}
                  />{" "}
                  Enabled identity
                </label>
              </>
            ) : (
              <label>
                Device name
                <input
                  name="label"
                  required
                  maxLength={80}
                  placeholder="Shop front desk"
                />
              </label>
            )}
            <button>
              {editing
                ? "Save changes"
                : tab === "devices"
                  ? "Provision device"
                  : "Save"}
            </button>
            {editing && (
              <button
                type="button"
                className="secondary"
                onClick={() => setEditing(undefined)}
              >
                Cancel
              </button>
            )}
          </form>
        </section>
      )}
      <section className="panel">
        <div className="section-label">
          {tab === "active" ? "CURRENTLY IN SHOP" : tab.toUpperCase()}{" "}
          <span>{items.length}</span>
        </div>
        {items.length === 0 && <p className="muted">No records to show.</p>}
        <div className="table-wrap">
          {tab === "members" ? (
            <table>
              <thead>
                <tr>
                  <th>Member</th>
                  <th>Card</th>
                  <th>Status</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {items.map((m) => (
                  <tr key={m.memberId}>
                    <td>
                      {m.displayName}
                      <small>{m.memberId}</small>
                    </td>
                    <td>{m.barcode || "Unassigned"}</td>
                    <td>
                      <span className={`pill ${m.active ? "" : "off"}`}>
                        {m.active ? "Active" : "Inactive"}
                      </span>
                    </td>
                    <td>
                      <button className="quiet" onClick={() => setEditing(m)}>
                        Edit mapping
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : tab === "active" ? (
            items.map((m) => (
              <div key={m.memberId} className="list-row">
                <span>{m.displayName}</span>
                <span>Since {time(m.startedAt)}</span>
              </div>
            ))
          ) : tab === "identities" ? (
            items.map((m) => (
              <div className="list-row" key={m.googleSub}>
                <span>
                  {m.email}
                  <small>
                    {m.googleSub} · {m.roles.join(", ")} ·{" "}
                    {m.enabled ? "Enabled" : "Disabled"}
                  </small>
                </span>
                <button className="quiet" onClick={() => setEditing(m)}>
                  Edit
                </button>
              </div>
            ))
          ) : tab === "devices" ? (
            items.map((d) => (
              <div className="list-row" key={d.deviceId}>
                <span>
                  {d.label}
                  <small>
                    {d.enabled ? "Enabled" : "Revoked"} · Expires{" "}
                    {d.expiresAt.slice(0, 10)}
                  </small>
                </span>
                {d.enabled && (
                  <button
                    className="quiet danger"
                    onClick={async () => {
                      if (!confirm(`Revoke ${d.label}?`)) return;
                      try {
                        await api(`/admin/devices/${d.deviceId}`, {}, "DELETE");
                        setFresh((x) => x + 1);
                      } catch (e: any) {
                        setError(e.message);
                      }
                    }}
                  >
                    Revoke
                  </button>
                )}
              </div>
            ))
          ) : tab === "review" ? (
            items.map((r, i) => (
              <article className="review-row" key={i}>
                <strong>{r.displayName || r.importKey}</strong>
                <p>
                  {r.status} · {(r.reasons || []).join(", ")}
                </p>
                <p>
                  {r.title || "Shop visit"} · {r.localDate || "Date missing"} ·{" "}
                  {r.creditedSeconds == null
                    ? "Hours missing"
                    : duration(r.creditedSeconds)}
                  {r.originalApproval !== undefined
                    ? ` · Original approval: ${r.originalApproval || "blank"}`
                    : ""}
                </p>
                <p>
                  {r.sourceFile} · Record {r.recordNumber}
                </p>
                <button className="quiet" onClick={() => review(r, "approved")}>
                  Approve reviewed entry
                </button>
                <button
                  className="quiet danger"
                  onClick={() => review(r, "voided")}
                >
                  Void
                </button>
              </article>
            ))
          ) : (
            items.map((a, i) => (
              <div className="list-row" key={i}>
                <span>
                  {a.action}
                  <small>
                    {a.actor} · {a.target}
                  </small>
                </span>
                <span>{a.at || ""}</span>
              </div>
            ))
          )}
        </div>
        {cursor && (
          <button className="secondary" onClick={() => load(cursor)}>
            Load more
          </button>
        )}
      </section>
    </>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
