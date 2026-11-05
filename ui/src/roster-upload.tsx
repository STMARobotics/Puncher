import React, { useEffect, useRef, useState } from "react";
import { api } from "./api";
type Choice = { memberId: string; version?: number };
const savedImport = "puncher-csv-import";
export function RosterUpload({
  members,
  onComplete,
}: {
  members: any[];
  onComplete: () => Promise<void>;
}) {
  const [file, setFile] = useState<File>(),
    [job, setJob] = useState<any>(),
    [choices, setChoices] = useState<Choice[]>([]),
    [working, setWorking] = useState(false),
    [error, setError] = useState("");
  const uploadId = useRef<string | undefined>(undefined),
    mounted = useRef(true);
  function load(value: any) {
    setJob(value);
    setChoices(
      value.selections ?? value.people.map((person: any) => person.suggested),
    );
  }
  useEffect(() => {
    mounted.current = true;
    const id = sessionStorage.getItem(savedImport);
    if (id)
      api("/mentor/roster/imports/" + id)
        .then((value) => {
          if (mounted.current && sessionStorage.getItem(savedImport) === id)
            load(value);
        })
        .catch((e) => {
          if (mounted.current && sessionStorage.getItem(savedImport) === id)
            setError(e.message);
        });
    return () => {
      mounted.current = false;
    };
  }, []);
  async function preview() {
    if (!file) return;
    setWorking(true);
    setError("");
    try {
      if (file.size > 128 * 1024)
        throw Error("Choose a CSV file no larger than 128 KB.");
      let csv: string;
      try {
        csv = new TextDecoder("utf-8", { fatal: true }).decode(
          await file.arrayBuffer(),
        );
      } catch {
        throw Error("Save the CSV using UTF-8 encoding and try again.");
      }
      uploadId.current ??= crypto.randomUUID();
      const value = await api("/mentor/roster/imports", {
        csv,
        importId: uploadId.current,
      });
      sessionStorage.setItem(savedImport, value.importId);
      load(value);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setWorking(false);
    }
  }
  async function apply() {
    setWorking(true);
    setError("");
    try {
      let current = await api("/mentor/roster/imports/" + job.importId);
      while (current.status !== "completed" && mounted.current) {
        const result = await api(
          `/mentor/roster/imports/${current.importId}/apply`,
          {
            cursor: current.processed,
            ...(current.status === "preview" ? { selections: choices } : {}),
          },
        );
        current = { ...current, ...result };
        if (mounted.current && current.status !== "completed") setJob(current);
      }
      if (current.status === "completed") {
        sessionStorage.removeItem(savedImport);
        if (mounted.current) {
          await onComplete();
          if (mounted.current) setJob(current);
        }
      }
    } catch (e: any) {
      if (mounted.current)
        setError(
          e.message +
            " Completed batches are saved. Retry to resume, or upload again to review changed members.",
        );
    } finally {
      if (mounted.current) setWorking(false);
    }
  }
  const reviewed =
    choices.length === job?.people?.length &&
    choices.every((c) => !!c.memberId);
  return (
    <section className="panel">
      <h2>UPLOAD MEMBERS CSV</h2>
      <p>
        Choose the Google group export with Member Name, Member Email and Member
        Role columns. New members receive six-digit card codes automatically.
      </p>
      <p className="muted">
        Link existing members to keep their card codes and hours. Manage
        attendance status and mentor access separately.
      </p>
      <div className="mentor-actions">
        <label>
          Google members CSV
          <input
            type="file"
            accept=".csv,text/csv"
            disabled={working}
            onChange={(e) => {
              setFile(e.target.files?.[0]);
              uploadId.current = undefined;
              setJob(undefined);
              setChoices([]);
              setError("");
              sessionStorage.removeItem(savedImport);
            }}
          />
        </label>
        <button disabled={!file || working} onClick={preview}>
          Preview CSV
        </button>
      </div>
      <p className="muted">
        Up to 500 people and 128 KB per file. Previews expire after 24 hours.
      </p>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {job && (
        <>
          {job.status === "preview" && (
            <>
              <h3>REVIEW {job.total} MEMBERS</h3>
              <p>
              Confirm the proposed email matches. For older records or changed
              addresses, select the existing member.
              </p>
              <button
                className="secondary"
                disabled={working}
                onClick={() =>
                  setChoices((current) =>
                    current.map((c, i) =>
                      c.memberId || !job.people[i].allowNew
                        ? c
                        : { memberId: "new" },
                    ),
                  )
                }
              >
                Mark unmatched as new
              </button>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Email</th>
                      <th>Import action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {job.people.map((person: any, index: number) => (
                      <tr key={person.email}>
                        <td>{person.displayName}</td>
                        <td>{person.email}</td>
                        <td>
                          <select
                            disabled={working}
                            aria-label={
                              "Import action for " + person.displayName
                            }
                            value={choices[index]?.memberId ?? ""}
                            onChange={(e) => {
                              const memberId = e.target.value,
                                member = members.find(
                                  (m) => m.memberId === memberId,
                                );
                              setChoices((current) =>
                                current.map((c, i) =>
                                  i === index
                                    ? {
                                        memberId,
                                        ...(member
                                          ? { version: member.version }
                                          : {}),
                                      }
                                    : c,
                                ),
                              );
                            }}
                          >
                            <option value="">
                              Choose existing or create new
                            </option>
                            <option value="new" disabled={!person.allowNew}>
                              Create new member
                            </option>
                            {members.map((m) => (
                              <option key={m.memberId} value={m.memberId}>
                                {m.displayName} · {m.barcode ?? "No card"}
                                {m.active ? "" : " · Inactive"}
                              </option>
                            ))}
                          </select>
                          <small>{person.reason}</small>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
          <p role="status">
            {job.status === "completed"
              ? "Import finished"
              : working
                ? "Importing"
                : "Import ready"}
            : {job.processed} of {job.total} processed · {job.counts.created}{" "}
            added, {job.counts.updated} updated, {job.counts.unchanged}{" "}
            unchanged.
          </p>
          {job.status !== "completed" && (
            <button
              disabled={working || (job.status === "preview" && !reviewed)}
              onClick={apply}
            >
              {working
                ? "Importing…"
                : job.status === "preview"
                  ? "Import reviewed members"
                  : "Resume import"}
            </button>
          )}
          <p className="muted">
            Import runs in small batches. You can resume after a connection
            failure or page reload. Choosing another file keeps any members
            already imported.
          </p>
        </>
      )}
    </section>
  );
}
