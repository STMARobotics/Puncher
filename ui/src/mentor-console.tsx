import React, { useEffect, useState } from "react";
import { api } from "./api";
import { RosterUpload } from "./roster-upload";

export function rosterCsv(members: any[]) {
  const cell = (value: unknown, protectFormula = true) => {
    let s = String(value ?? "");
    if (protectFormula && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return '"' + s.replaceAll('"', '""') + '"';
  };
  return (
    "name,email,barcode\r\n" +
    members
      .filter((m) => m.active && m.barcode)
      .map((m) =>
        [cell(m.displayName), cell(m.email), cell(m.barcode, false)].join(","),
      )
      .join("\r\n") +
    "\r\n"
  );
}
function downloadRoster(members: any[]) {
  const url = URL.createObjectURL(
    new Blob([rosterCsv(members)], { type: "text/csv;charset=utf-8" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = "puncher-roster.csv";
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function MentorConsole({ administrator }: { administrator: boolean }) {
  const [tab, setTab] = useState("students");
  return (
    <>
      <div className="page-heading">
        <h1>MANAGE STUDENTS</h1>
      </div>
      <nav className="tabs" aria-label="Mentor tools">
        {[
          "students",
          "kiosks",
          ...(administrator ? ["mentor access", "import review", "audit"] : []),
        ].map((t) => (
          <button
            key={t}
            className={tab === t ? "selected" : ""}
            onClick={() => setTab(t)}
          >
            {t}
          </button>
        ))}
      </nav>
      {tab === "students" ? (
        <Members />
      ) : tab === "kiosks" ? (
        <KioskSessions />
      ) : tab === "mentor access" ? (
        <MentorAccess />
      ) : (
        <Operations tab={tab === "audit" ? "audit" : "review"} />
      )}
    </>
  );
}
function Members() {
  const empty = () => ({
    memberId: crypto.randomUUID(),
    displayName: "",
    email: "",
    memberKind: "student",
    active: true,
  });
  const [members, setMembers] = useState<any[]>([]),
    [form, setForm] = useState<any>(empty),
    [editing, setEditing] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState("");
  async function refresh() {
    try {
      setMembers(await api("/mentor/members"));
    } catch (e: any) {
      setError(e.message);
    }
  }
  useEffect(() => {
    void refresh();
  }, []);
  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api(
        "/mentor/members" + (editing ? "/" + form.memberId : ""),
        form,
        editing ? "PATCH" : "POST",
      );
      setForm(empty());
      setEditing(false);
      setMessage(
        "Roster entry saved. The card code is assigned automatically.",
      );
      await refresh();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function replace(m: any) {
    if (
      !confirm(
        "Replace " +
          m.displayName +
          "'s card code? Their old card will stop working; attendance history is preserved.",
      )
    )
      return;
    setBusy(true);
    setError("");
    const storageKey = "puncher-card-replacement-" + m.memberId;
    const operationId =
      sessionStorage.getItem(storageKey) ?? crypto.randomUUID();
    sessionStorage.setItem(storageKey, operationId);
    try {
      await api(`/mentor/members/${m.memberId}/replace-card`, { operationId });
      sessionStorage.removeItem(storageKey);
      setMessage(
        "Replacement code assigned. Export the roster for your ID-card generator.",
      );
      await refresh();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <RosterUpload onComplete={refresh} />
      <section className="panel">
        <div className="mentor-actions">
          <button
            disabled={!members.some((m) => m.active && m.barcode)}
            onClick={() => downloadRoster(members)}
          >
            Export active roster CSV
          </button>
          <button className="secondary" onClick={() => void refresh()}>
            Refresh
          </button>
        </div>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        {message && <p role="status">{message}</p>}
      </section>
      <section className="panel">
        <h2>{editing ? "EDIT ROSTER ENTRY" : "ADD ROSTER ENTRY"}</h2>
        <form className="form-grid" onSubmit={save}>
          <label>
            Name
            <input
              required
              maxLength={100}
              value={form.displayName}
              onChange={(e) =>
                setForm({ ...form, displayName: e.target.value })
              }
            />
          </label>
          <label>
            Email
            <input
              type="email"
              value={form.email ?? ""}
              readOnly={!!form.csvManaged}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
            />
          </label>
          <label>
            Role
            <select
              value={form.memberKind}
              onChange={(e) => setForm({ ...form, memberKind: e.target.value })}
            >
              <option value="student">Student</option>
              <option value="mentor">Mentor</option>
            </select>
          </label>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={form.active}
              onChange={(e) => setForm({ ...form, active: e.target.checked })}
            />
            Active for attendance
          </label>
          {editing && (
            <p>
              Card code: <strong>{form.barcode ?? "Assigned on save"}</strong>
            </p>
          )}
          <button disabled={busy}>
            {editing ? "Save entry" : "Add entry"}
          </button>
          {editing && (
            <button
              className="secondary"
              type="button"
              onClick={() => {
                setForm(empty());
                setEditing(false);
              }}
            >
              Cancel
            </button>
          )}
        </form>
      </section>
      <section className="panel">
        <h2>STUDENTS AND MENTORS · {members.length}</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Email</th>
                <th>Role</th>
                <th>Card code</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {members.map((m) => (
                <tr key={m.memberId}>
                  <td>{m.displayName}</td>
                  <td>{m.email ?? "—"}</td>
                  <td>{m.memberKind === "mentor" ? "Mentor" : "Student"}</td>
                  <td>{m.barcode ?? "Unassigned"}</td>
                  <td>{m.active ? "Active" : "Inactive"}</td>
                  <td>
                    <button
                      className="quiet"
                      onClick={() => {
                        setForm({ ...m });
                        setEditing(true);
                      }}
                    >
                      Edit entry
                    </button>
                    <button
                      className="quiet"
                      disabled={busy}
                      onClick={() => replace(m)}
                    >
                      Replace card code
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
function KioskSessions() {
  const [sessions, setSessions] = useState<any[]>([]),
    [error, setError] = useState("");
  const load = () =>
    api("/mentor/kiosks")
      .then(setSessions)
      .catch((e) => setError(e.message));
  useEffect(() => {
    void load();
  }, []);
  async function end(id: string) {
    try {
      await api("/mentor/kiosks/" + id, {}, "DELETE");
      await load();
    } catch (e: any) {
      setError(e.message);
    }
  }
  return (
    <section className="panel">
      <h2>KIOSK SESSIONS</h2>
      {error && <p role="alert">{error}</p>}
      <p>
        Launch a kiosk from the mentor dashboard. Sessions expire after 12 hours
        and can be ended here.
      </p>
      {sessions.map((s) => (
        <div className="list-row" key={s.sessionId}>
          <div>
            <strong>{s.label}</strong>
            <small>Expires {new Date(s.expiresAt).toLocaleString()}</small>
          </div>
          {s.enabled && new Date(s.expiresAt).getTime() > Date.now() ? (
            <button onClick={() => end(s.sessionId)}>End session</button>
          ) : (
            <span>Ended or expired</span>
          )}
        </div>
      ))}
      {sessions.length === 0 && <p>No kiosk sessions.</p>}
    </section>
  );
}
function MentorAccess() {
  const [requests, setRequests] = useState<any[]>([]),
    [identities, setIdentities] = useState<any[]>([]),
    [error, setError] = useState(""),
    [administrator, setAdministrator] = useState(false),
    [statsReports, setStatsReports] = useState(false);
  async function load() {
    try {
      const [r, i] = await Promise.all([
        api("/admin/mentor-requests"),
        api("/admin/identities"),
      ]);
      setRequests(r);
      setIdentities(
        i.filter((x: any) =>
          x.roles.some((r: string) => ["mentor", "admin"].includes(r)),
        ),
      );
    } catch (e: any) {
      setError(e.message);
    }
  }
  useEffect(() => {
    void load();
  }, []);
  async function approve(request: any) {
    try {
      await api(`/admin/mentor-requests/${request.googleSub}/approve`, {
        administrator,
        statsReports,
      });
      await load();
    } catch (e: any) {
      setError(e.message);
    }
  }
  async function disable(identity: any) {
    if (!confirm("Remove Puncher mentor access for " + identity.email + "?"))
      return;
    try {
      await api("/admin/identities", {
        ...identity,
        roles: identity.roles.filter(
          (r: string) => !["mentor", "admin"].includes(r),
        ),
      });
      await load();
    } catch (e: any) {
      setError(e.message);
    }
  }
  return (
    <section className="panel">
      <h2>MENTOR ACCESS</h2>
      <p>
        New mentors sign in with Google once to request approval. Roster sync
        never grants mentor permissions.
      </p>
      {error && <p role="alert">{error}</p>}
      <label className="checkbox">
        <input
          type="checkbox"
          checked={administrator}
          onChange={(e) => setAdministrator(e.target.checked)}
        />
        Grant mentor administrator permissions when approving
      </label>
      <label className="checkbox">
        <input
          type="checkbox"
          checked={statsReports}
          onChange={(e) => setStatsReports(e.target.checked)}
        />
        Allow mentor reports in Stats when approving
      </label>
      {requests.map((r) => (
        <div className="list-row" key={r.googleSub}>
          <div>
            <strong>{r.displayName}</strong>
            <small>{r.email}</small>
          </div>
          <button onClick={() => approve(r)}>Approve mentor</button>
        </div>
      ))}
      {requests.length === 0 && <p>No pending mentor requests.</p>}
      <h3>APPROVED MENTORS</h3>
      {identities.map((i) => (
        <div className="list-row" key={i.googleSub}>
          <span>{i.email}</span>
          <button className="secondary" onClick={() => disable(i)}>
            Remove mentor access
          </button>
        </div>
      ))}
    </section>
  );
}
function Operations({ tab }: { tab: "audit" | "review" }) {
  const [items, setItems] = useState<any[]>([]),
    [cursor, setCursor] = useState<string>(),
    [error, setError] = useState("");
  async function load(next?: string) {
    try {
      const r = await api(
        `/admin/${tab}${next ? "?cursor=" + encodeURIComponent(next) : ""}`,
      );
      setItems((current) => (next ? [...current, ...r.items] : r.items));
      setCursor(r.cursor);
    } catch (e: any) {
      setError(e.message);
    }
  }
  useEffect(() => {
    setItems([]);
    void load();
  }, [tab]);
  async function review(item: any, status: string) {
    const reason = prompt("Explain this imported-credit review:");
    if (!reason) return;
    try {
      await api("/admin/review", {
        pk: item.recordPk,
        sk: item.recordSk,
        status,
        reason,
      });
      await load();
    } catch (e: any) {
      setError(e.message);
    }
  }
  return (
    <section className="panel">
      <h2>{tab === "audit" ? "AUDIT HISTORY" : "IMPORTED CREDIT REVIEW"}</h2>
      {error && <p role="alert">{error}</p>}
      {items.map((item, index) => (
        <div className="list-row" key={index}>
          <pre>{JSON.stringify(item, null, 2)}</pre>
          {tab === "review" && (
            <div>
              <button onClick={() => review(item, "approved")}>Approve</button>
              <button
                className="secondary"
                onClick={() => review(item, "quarantined")}
              >
                Quarantine
              </button>
              <button
                className="secondary"
                onClick={() => review(item, "voided")}
              >
                Void
              </button>
            </div>
          )}
        </div>
      ))}
      {cursor && <button onClick={() => load(cursor)}>Load more</button>}
      {items.length === 0 && <p>No records to show.</p>}
    </section>
  );
}
