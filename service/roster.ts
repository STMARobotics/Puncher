import { Puncher } from "./domain";
import { assignCard } from "./card-codes";
import { all, atomic, type Store, type Tx } from "./store";
import {
  assert,
  key,
  mentor,
  row,
  uid,
  type Principal,
  type Row,
} from "./model";

export type DirectoryPerson = {
  id: string;
  displayName: string;
  email: string;
  active: boolean;
};
export type RosterSource = () => Promise<DirectoryPerson[]>;
const jobKey = key("APP#PUNCHER", "ROSTER_SYNC");
const pendingPk = "ROSTER#PENDING";
const leaseMs = 10 * 60 * 1000;
const inProgress = (r: Row | undefined, now: Date) =>
  !!r &&
  ["queued", "running"].includes(r.status) &&
  r.leaseUntil > now.toISOString();

async function fence(tx: Tx, jobId: string, now: Date) {
  const job = await tx.get(jobKey);
  assert(
    job?.jobId === jobId &&
      job.status === "running" &&
      job.leaseUntil > now.toISOString(),
    "This roster run is no longer active.",
    409,
  );
}
export async function startRosterSync(
  db: Store,
  p: Principal,
  enqueue: (id: string) => Promise<void>,
  now = new Date(),
) {
  mentor(p);
  const app = new Puncher(db, () => now);
  const job = await atomic(db, async (tx) => {
    await app.livePrincipal(tx, p);
    const current = await tx.get(jobKey);
    if (inProgress(current, now)) return current!;
    const next = row(jobKey.pk, jobKey.sk, {
      jobId: uid(),
      status: "queued",
      requestedBy: p.id,
      createdAt: now.toISOString(),
      leaseUntil: new Date(now.getTime() + leaseMs).toISOString(),
    });
    await tx.put(next);
    await app.audit(tx, p, "roster.requested", next.jobId);
    return next;
  });
  if (job.status === "queued") {
    try {
      await enqueue(job.jobId);
    } catch {
      await atomic(db, async (tx) => {
        const current = await tx.get(jobKey);
        if (
          current &&
          current.jobId === job.jobId &&
          current.status === "queued"
        )
          await tx.put({
            ...current,
            status: "failed",
            error: "Unable to queue roster sync. Please retry.",
          });
      });
      throw new Error("Unable to queue roster sync.");
    }
  }
  return { jobId: job.jobId, status: job.status };
}
export async function rosterStatus(db: Store) {
  const job = await db.get(jobKey);
  if (!job) return { status: "idle" };
  const stale =
    inProgress(job, new Date()) === false &&
    ["queued", "running"].includes(job.status);
  return {
    jobId: job.jobId,
    status: stale ? "failed" : job.status,
    counts: job.counts,
    finishedAt: job.finishedAt,
    error: stale ? "Roster sync expired. Please retry." : job.error,
  };
}
export async function pendingRoster(db: Store) {
  return (await all(db, pendingPk)).map(
    ({ directoryId, displayName, email }) => ({
      directoryId,
      displayName,
      email,
    }),
  );
}
async function upsertPerson(
  db: Store,
  p: Principal,
  person: DirectoryPerson,
  options: {
    jobId?: string;
    hasLegacy?: boolean;
    memberId?: string;
    confirmNew?: boolean;
    now?: () => Date;
  },
) {
  const clock = options.now ?? (() => new Date()),
    app = new Puncher(db, clock),
    generatedId = uid();
  return atomic(db, async (tx) => {
    await app.livePrincipal(tx, p);
    if (options.jobId) await fence(tx, options.jobId, clock());
    else {
      assert(
        !inProgress(await tx.get(jobKey), clock()),
        "Wait for the roster sync to finish.",
        409,
      );
      const current = await tx.get(key(pendingPk, person.id));
      assert(
        current &&
          current.email === person.email &&
          current.displayName === person.displayName &&
          current.active === person.active,
        "This directory entry changed. Refresh before linking it.",
        409,
      );
    }
    const mappingKey = key("DIRECTORY#" + person.id),
      mapping = await tx.get(mappingKey);
    const explicitIdentity = mapping
      ? undefined
      : await tx.get(key("IDENTITY#" + person.id));
    const memberId =
      mapping?.memberId ?? options.memberId ?? explicitIdentity?.memberId;
    assert(
      !options.memberId ||
        !explicitIdentity?.memberId ||
        options.memberId === explicitIdentity.memberId,
      "Google account already has a different approved member link.",
      409,
    );
    if (options.memberId && mapping)
      assert(
        mapping.memberId === options.memberId,
        "Directory user is already linked.",
        409,
      );
    const before = memberId
      ? await tx.get(key("MEMBER#" + memberId))
      : undefined;
    if (memberId)
      assert(
        before,
        "The linked member was not found. Resolve the mapping before syncing.",
        409,
      );
    if (before)
      assert(
        !before.directoryUserId || before.directoryUserId === person.id,
        "Member is already linked to a different directory user.",
        409,
      );
    if (before && !mapping) {
      const binding = await tx.get(key("BINDING#" + before.memberId));
      assert(
        !binding || binding.googleSub === person.id,
        "Member has an existing link to a different Google account.",
        409,
      );
    }
    if (!before && !person.active) {
      await tx.del(key(pendingPk, person.id));
      return "skipped" as const;
    }
    if (!before && options.hasLegacy && !options.confirmNew) {
      await tx.put(
        row(pendingPk, person.id, {
          directoryId: person.id,
          displayName: person.displayName,
          email: person.email,
          active: person.active,
        }),
      );
      return "needsLink" as const;
    }
    const id = before?.memberId ?? generatedId;
    const code = await assignCard(tx, id, before?.barcode);
    const manuallyDisabled = before?.directoryUserId
      ? !!before.manuallyDisabled
      : before?.active === false;
    const next = {
      ...(before ?? row("MEMBER#" + id, "METADATA", {})),
      memberId: id,
      displayName: person.displayName,
      email: person.email,
      memberKind: before?.memberKind ?? "student",
      active: person.active && !manuallyDisabled,
      barcode: code,
      directoryUserId: person.id,
      directorySuspended: !person.active,
      manuallyDisabled,
      gsi1pk: "MEMBERS",
      gsi1sk: id,
    } as Row;
    const changed =
      !before ||
      [
        "displayName",
        "email",
        "active",
        "barcode",
        "directoryUserId",
        "directorySuspended",
        "manuallyDisabled",
      ].some((field) => before[field] !== next[field]);
    if (changed) {
      await tx.put(next);
      await app.audit(
        tx,
        p,
        before ? "roster.member_updated" : "roster.member_created",
        id,
      );
    }
    if (!mapping)
      await tx.put(row(mappingKey.pk, mappingKey.sk, { memberId: id }));
    await tx.del(key(pendingPk, person.id));
    return !before
      ? ("created" as const)
      : before.active && !next.active
        ? ("disabled" as const)
        : changed
          ? ("updated" as const)
          : ("unchanged" as const);
  });
}
export async function linkRosterMember(
  db: Store,
  p: Principal,
  directoryId: string,
  memberId?: string,
  confirmNew = false,
) {
  mentor(p);
  assert(
    typeof directoryId === "string" &&
      directoryId.length > 0 &&
      directoryId.length <= 256,
    "Select a directory user.",
  );
  assert(
    memberId === undefined ||
      (typeof memberId === "string" &&
        memberId.length > 0 &&
        memberId.length <= 256),
    "Invalid existing member.",
  );
  assert(
    !!memberId !== confirmNew,
    "Choose an existing member or explicitly create a new member.",
  );
  const pending = await db.get(key(pendingPk, directoryId));
  assert(
    pending,
    "This directory user no longer needs linking. Refresh the roster.",
    409,
  );
  const job = await db.get(jobKey);
  assert(
    !inProgress(job, new Date()),
    "Wait for the roster sync to finish.",
    409,
  );
  return {
    outcome: await upsertPerson(
      db,
      p,
      {
        id: directoryId,
        displayName: pending.displayName,
        email: pending.email,
        active: pending.active,
      },
      { memberId, confirmNew, hasLegacy: true },
    ),
  };
}
export async function runRosterSync(
  db: Store,
  jobId: string,
  source: RosterSource,
  now = () => new Date(),
) {
  const initial = await db.get(jobKey);
  if (
    initial?.jobId !== jobId ||
    !["queued", "running"].includes(initial.status)
  )
    return;
  const identity = await db.get(key("IDENTITY#" + initial.requestedBy));
  const p: Principal = {
    kind: "human",
    id: initial.requestedBy,
    roles: identity?.roles ?? [],
  };
  try {
    mentor(p);
    const claimed = await atomic(db, async (tx) => {
      await new Puncher(db, now).livePrincipal(tx, p);
      const job = await tx.get(jobKey);
      assert(
        job?.jobId === jobId && job.leaseUntil > now().toISOString(),
        "Roster run expired.",
        409,
      );
      if (job.status !== "queued") return false;
      await tx.put({ ...job, status: "running" });
      return true;
    });
    if (!claimed) return;
    // Validate and finish every Google page before modifying membership.
    const people = await source(),
      seen = new Set<string>();
    assert(
      Array.isArray(people) && people.length <= 10000,
      "Invalid directory snapshot.",
    );
    for (const person of people) {
      assert(
        person &&
          typeof person.id === "string" &&
          person.id.length > 0 &&
          person.id.length <= 256 &&
          typeof person.displayName === "string" &&
          person.displayName.length > 0 &&
          person.displayName.length <= 100 &&
          typeof person.email === "string" &&
          /^[^@\s]+@stmarobotics\.org$/.test(person.email) &&
          typeof person.active === "boolean" &&
          !seen.has(person.id),
        "Invalid directory user or duplicate ID.",
      );
      seen.add(person.id);
    }
    const members = await all(db, "MEMBERS", { index: "GSI1" });
    assert(
      people.length > 0 || !members.some((m) => m.directoryUserId),
      "Empty directory response; no accounts were disabled.",
    );
    const hasLegacy = members.some((m) => m.active && !m.directoryUserId);
    const counts = {
      created: 0,
      updated: 0,
      disabled: 0,
      needsLink: 0,
      unchanged: 0,
      skipped: 0,
    };
    for (const person of people)
      counts[await upsertPerson(db, p, person, { jobId, hasLegacy, now })]++;
    for (const member of members.filter(
      (m) => m.directoryUserId && !seen.has(m.directoryUserId),
    ))
      counts[
        await upsertPerson(
          db,
          p,
          {
            id: member.directoryUserId,
            displayName: member.displayName,
            email: member.email,
            active: false,
          },
          { jobId, now },
        )
      ]++;
    // Stale unresolved candidates cannot later reactivate a removed account.
    for (const pending of await all(db, pendingPk))
      if (!seen.has(pending.directoryId))
        await atomic(db, async (tx) => {
          await fence(tx, jobId, now());
          await tx.del(key(pendingPk, pending.sk));
        });
    await atomic(db, async (tx) => {
      await fence(tx, jobId, now());
      const job = await tx.get(jobKey);
      await tx.put({
        ...job!,
        status: "completed",
        counts,
        finishedAt: now().toISOString(),
      });
      await new Puncher(db, now).audit(
        tx,
        p,
        "roster.completed",
        jobId,
        counts,
      );
    });
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "roster_sync_failed",
        errorType: error instanceof Error ? error.name : "unknown",
      }),
    );
    await atomic(db, async (tx) => {
      const job = await tx.get(jobKey);
      if (job?.jobId === jobId && ["queued", "running"].includes(job.status))
        await tx.put({
          ...job,
          status: "failed",
          finishedAt: now().toISOString(),
          error:
            "Roster sync could not finish. Check the Google Workspace connection and retry.",
        });
    });
  }
}
