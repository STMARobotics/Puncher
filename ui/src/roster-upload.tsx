import React, { useEffect, useRef, useState } from "react";
import { api } from "./api";
const savedImport = "puncher-csv-import";
export function RosterUpload({
  onComplete,
}: {
  onComplete: () => Promise<void>;
}) {
  const [file, setFile] = useState<File>(),
    [job, setJob] = useState<any>(),
    [groupEmail, setGroupEmail] = useState(""),
    [working, setWorking] = useState(false),
    [error, setError] = useState("");
  const uploadId = useRef<string | undefined>(undefined),
    mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    const id = sessionStorage.getItem(savedImport);
    if (id)
      api("/mentor/roster/imports/" + id)
        .then((value) => {
          if (mounted.current && sessionStorage.getItem(savedImport) === id)
            setJob(value);
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
        groupEmail,
        importId: uploadId.current,
      });
      sessionStorage.setItem(savedImport, value.importId);
      setJob(value);
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
            " Completed batches are saved. Retry to resume, or upload again to refresh matching.",
        );
    } finally {
      if (mounted.current) setWorking(false);
    }
  }
  return (
    <section className="panel">
      <h2>UPLOAD ROSTER CSV</h2>
      <p>
        Upload a Google Groups CSV. Existing entries match by name and email.
        New entries receive a six-digit card code and a role from their Google
        group.
      </p>
      <div className="mentor-actions">
        <label>
          Google roster CSV
          <input
            type="file"
            accept=".csv,text/csv"
            disabled={working}
            onChange={(e) => {
              setFile(e.target.files?.[0]);
              uploadId.current = undefined;
              setJob(undefined);
              setError("");
              sessionStorage.removeItem(savedImport);
            }}
          />
        </label>
        <label>
          Source group for older exports
          <select
            value={groupEmail}
            disabled={working}
            onChange={(event) => {
              setGroupEmail(event.target.value);
              uploadId.current = undefined;
              setJob(undefined);
              setError("");
              sessionStorage.removeItem(savedImport);
            }}
          >
            <option value="">Read group from CSV</option>
            <option value="frc.students@stmarobotics.org">frc.students</option>
            <option value="frc.mentors@stmarobotics.org">frc.mentors</option>
          </select>
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
          {job.status === "preview" &&
            (job.automatic ? (
              <>
                <h3>REVIEW {job.total} ROSTER ENTRIES</h3>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Name</th>
                        <th>Email</th>
                        <th>Role</th>
                        <th>Import action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {job.people.map((person: any) => (
                        <tr key={person.email}>
                          <td>{person.displayName}</td>
                          <td>{person.email}</td>
                          <td>
                            {person.memberKind === "mentor"
                              ? "Mentor"
                              : "Student"}
                          </td>
                          <td>
                            {person.match
                              ? "Match existing entry"
                              : "Create new entry"}
                            {!person.canEnroll && !person.match && (
                              <small> · Email already in use</small>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            ) : (
              <p>Upload the CSV again to refresh this older preview.</p>
            ))}
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
              disabled={working || (job.status === "preview" && !job.automatic)}
              onClick={apply}
            >
              {working
                ? "Importing…"
                : job.status === "preview"
                  ? "Import roster"
                  : "Resume import"}
            </button>
          )}
          <p className="muted">
            Import runs in small batches. You can resume after a connection
            failure or page reload. Choosing another file keeps any entries
            already imported.
          </p>
        </>
      )}
    </section>
  );
}
