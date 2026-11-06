import React, { useEffect, useState } from "react";
import { api } from "./api";
import type { Role } from "../../service/model";
const roleLabels: Record<Role, string> = {
  STUDENT: "Student",
  MENTOR: "Mentor",
  ADMIN: "Admin",
};
type Member = {
  memberId: string;
  displayName: string;
  email: string;
  role: Role;
  barcode: string;
  active: boolean;
  version: number;
};
export type DirectoryMember = Pick<Member, "memberId" | "displayName" | "role">;

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
  const [tab, setTab] = useState("members");
  return (
    <>
      <div className="page-heading">
        <h1>MANAGE MEMBERS</h1>
      </div>
      <nav className="tabs" aria-label="Mentor tools">
        {(administrator
          ? ["members", "kiosks", "import review", "audit"]
          : ["members", "kiosks"]
        ).map((t) => (
          <button
            key={t}
            className={tab === t ? "selected" : ""}
            onClick={() => setTab(t)}
          >
            {t}
          </button>
        ))}
      </nav>
      {tab === "members" ? (
        administrator ? (
          <Members />
        ) : (
          <MemberDirectory />
        )
      ) : tab === "kiosks" ? (
        <KioskSessions />
      ) : (
        <Operations tab={tab === "audit" ? "audit" : "review"} />
      )}
    </>
  );
}
function MemberDirectory() {
  const [members, setMembers] = useState<DirectoryMember[]>();
  const [error, setError] = useState("");
  useEffect(() => {
    api("/mentor/members")
      .then(setMembers)
      .catch((e) => setError(e.message));
  }, []);
  return (
    <section className="panel" aria-label="Active members">
      {error ? (
        <p role="alert" className="notice error">
          {error}
        </p>
      ) : !members ? (
        <p>Loading members…</p>
      ) : members.length === 0 ? (
        <p>No active members.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Role</th>
            </tr>
          </thead>
          <tbody>
            {members.map((m) => (
              <tr key={m.memberId}>
                <td>{m.displayName}</td>
                <td>{roleLabels[m.role]}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
function Members() {
  const [members, setMembers] = useState<Member[]>([]);
  const [form, setForm] = useState<Member>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  async function refresh() {
    try {
      setMembers(await api("/admin/members"));
    } catch (e: any) {
      setError(e.message);
    }
  }
  useEffect(() => {
    void refresh();
  }, []);

  async function update(member: Member, replacement = false) {
    if (
      replacement &&
      !confirm(
        "Replace " +
          member.displayName +
          "’s card code? Their old card will stop working.",
      )
    )
      return;
    setBusy(true);
    setError("");
    setMessage("");
    const path = "/admin/members/" + encodeURIComponent(member.memberId);
    try {
      if (replacement) {
        const storageKey = "puncher-card-replacement-" + member.memberId;
        const operationId =
          sessionStorage.getItem(storageKey) ?? crypto.randomUUID();
        sessionStorage.setItem(storageKey, operationId);
        await api(path + "/replace-card", { operationId });
        sessionStorage.removeItem(storageKey);
      } else {
        const { displayName, role, active, version } = member;
        await api(path, { displayName, role, active, version }, "PATCH");
        setForm(undefined);
      }
      setMessage(replacement ? "Replacement code assigned." : "Member saved.");
      await refresh();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <section className="panel">
        <div className="mentor-actions">
          <button
            disabled={!members.some((member) => member.active)}
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
      {form && (
        <section className="panel">
          <h2>EDIT MEMBER</h2>
          <form
            className="inline-form"
            onSubmit={(event) => {
              event.preventDefault();
              void update(form);
            }}
          >
            <label>
              Name
              <input
                required
                maxLength={100}
                value={form.displayName}
                onChange={(event) =>
                  setForm({ ...form, displayName: event.target.value })
                }
              />
            </label>
            <label>
              Email
              <input readOnly value={form.email} />
            </label>
            <label>
              Role
              <select
                value={form.role}
                onChange={(event) =>
                  setForm({ ...form, role: event.target.value as Role })
                }
              >
                {Object.entries(roleLabels).map(([role, label]) => (
                  <option key={role} value={role}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={form.active}
                onChange={(event) =>
                  setForm({ ...form, active: event.target.checked })
                }
              />
              Active
            </label>
            <button disabled={busy}>Save member</button>
            <button
              className="secondary"
              type="button"
              onClick={() => setForm(undefined)}
            >
              Cancel
            </button>
          </form>
        </section>
      )}
      <section className="panel">
        <h2>MEMBERS · {members.length}</h2>
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
              {members.map((member) => (
                <tr key={member.memberId}>
                  <td>{member.displayName}</td>
                  <td>{member.email}</td>
                  <td>{roleLabels[member.role]}</td>
                  <td>{member.barcode}</td>
                  <td>{member.active ? "Active" : "Inactive"}</td>
                  <td>
                    <button
                      className="quiet"
                      disabled={busy}
                      onClick={() => setForm(member)}
                    >
                      Edit member
                    </button>
                    <button
                      className="quiet"
                      disabled={busy}
                      onClick={() => void update(member, true)}
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
