import { Puncher } from "./domain";
import { assignCard } from "./card-codes";
import {
  parseRosterCsv,
  rosterLimits,
  type CsvPerson,
  type SkippedRosterRow,
} from "./roster-csv";
import { all, atomic, type Store } from "./store";
import {
  assert,
  key,
  mentor,
  hash,
  row,
  uid,
  type Principal,
  type Row,
} from "./model";

type Match = { memberId: string; version?: number };
type StagedPerson = CsvPerson & {
  newMemberId: string;
  match?: Match;
  canEnroll: boolean;
};
const normalizedName = (name: string) =>
  name.normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase();
const matchKey = (person: CsvPerson) =>
  key(
    "ROSTER_MATCH#" +
      hash(JSON.stringify([person.email, normalizedName(person.displayName)])),
  );
const matchesPerson = (
  member: Row | undefined,
  person: CsvPerson,
): member is Row =>
  typeof member?.email === "string" &&
  member.email.trim().toLowerCase() === person.email &&
  typeof member.displayName === "string" &&
  normalizedName(member.displayName) === normalizedName(person.displayName);
const importKey = (id: string) => key("ROSTER_IMPORT#" + id);
const emailKey = (email: string) => key("ROSTER_EMAIL#" + hash(email));
const validId = (id: unknown): id is string =>
  typeof id === "string" &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(
    id,
  );
function checkJob(job: Row | undefined, p: Principal) {
  assert(
    job && job.expiresAt > new Date().toISOString(),
    "This CSV preview expired. Upload the file again.",
    404,
  );
  assert(
    job.requestedBy === p.id,
    "This import belongs to another mentor.",
    403,
  );
}
function dto(job: Row, includeRows = true) {
  return {
    importId: job.importId,
    status: job.status,
    processed: job.cursor,
    total: job.people.length,
    counts: job.counts,
    ...(includeRows
      ? {
          people: job.people,
          skipped: job.skipped ?? [],
          automatic: job.automatic === true,
        }
      : {}),
  };
}
export async function previewRoster(
  db: Store,
  p: Principal,
  id: unknown,
  csv: unknown,
  groupEmail?: unknown,
) {
  mentor(p);
  assert(validId(id), "A valid upload request ID is required.");
  const { people, skipped } = parseRosterCsv(csv, groupEmail);
  const sourceHash = hash(
      JSON.stringify([people.map((person) => person.memberKind), csv]),
    ),
    k = importKey(id);
  const existing = await db.get(k);
  if (existing) {
    checkJob(existing, p);
    assert(
      existing.sourceHash === sourceHash,
      "Upload request was already used for a different CSV.",
      409,
    );
    return dto(existing);
  }
  const members = people.length
    ? await all(db, "MEMBERS", { index: "GSI1" })
    : [];
  const byEmail = new Map<string, Row[]>();
  for (const member of members)
    if (typeof member.email === "string" && member.email.trim()) {
      const email = member.email.trim().toLowerCase();
      byEmail.set(email, [...(byEmail.get(email) ?? []), member]);
    }
  const staged: StagedPerson[] = [];
  async function stage(
    person: CsvPerson,
  ): Promise<StagedPerson | SkippedRosterRow> {
    const [claim, match] = await Promise.all([
      db.get(emailKey(person.email)),
      db.get(matchKey(person)),
    ]);
    // Check known imports with a consistent read even if the roster index
    // has not caught up with a recent write.
    const candidateId = match?.memberId ?? claim?.memberId;
    const candidate = candidateId
      ? await db.get(key("MEMBER#" + candidateId))
      : undefined;
    const sameEmail = byEmail.get(person.email) ?? [];
    const exact = sameEmail.filter((member) => matchesPerson(member, person));
    if (!matchesPerson(candidate, person) && exact.length > 1)
      return {
        line: person.line,
        reason: "More than one roster entry has this name and email.",
      };
    const known = matchesPerson(candidate, person) ? candidate : exact[0];
    return {
      ...person,
      newMemberId: uid(),
      match: known ? { memberId: known.memberId, version: known.v } : undefined,
      memberKind: known?.memberKind ?? person.memberKind,
      canEnroll: claim
        ? claim.memberId === known?.memberId && !claim.retired
        : sameEmail.every((member) => member.memberId === known?.memberId),
    };
  }
  // Bound lookup concurrency so larger exports fit the request deadline.
  for (let offset = 0; offset < people.length; offset += 20) {
    const results = await Promise.all(
      people.slice(offset, offset + 20).map(stage),
    );
    for (const result of results) {
      if ("reason" in result) skipped.push(result);
      else staged.push(result);
    }
  }
  skipped.sort((a, b) => a.line - b.line);
  assert(
    Buffer.byteLength(JSON.stringify({ staged, skipped }), "utf8") <=
      256 * 1024,
    "The normalized roster is too large; split the CSV into smaller files.",
  );
  const app = new Puncher(db);
  const job = await atomic(db, async (tx) => {
    await app.livePrincipal(tx, p);
    const before = await tx.get(k);
    if (before) {
      checkJob(before, p);
      assert(before.sourceHash === sourceHash, "Upload request changed.", 409);
      return before;
    }
    const next = row(k.pk, k.sk, {
      importId: id,
      requestedBy: p.id,
      sourceHash,
      automatic: true,
      people: staged,
      skipped,
      status: staged.length ? "preview" : "completed",
      cursor: 0,
      counts: { created: 0, updated: 0, unchanged: 0 },
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
      ttl: Math.floor(Date.now() / 1000) + 86400,
    });
    await tx.put(next);
    return next;
  });
  return dto(job);
}
export async function rosterImportStatus(db: Store, p: Principal, id: string) {
  mentor(p);
  assert(validId(id), "Invalid import ID.");
  const job = await db.get(importKey(id));
  checkJob(job, p);
  return dto(job!);
}
export async function applyRosterBatch(
  db: Store,
  p: Principal,
  id: string,
  cursor: unknown,
) {
  mentor(p);
  assert(validId(id), "Invalid import ID.");
  assert(
    typeof cursor === "number" && Number.isInteger(cursor) && cursor >= 0,
    "Invalid import position.",
  );
  const app = new Puncher(db),
    k = importKey(id);
  return atomic(db, async (tx) => {
    await app.livePrincipal(tx, p);
    const job = await tx.get(k);
    checkJob(job, p);
    if (job!.status === "completed" || cursor < job!.cursor)
      return dto(job!, false);
    assert(
      cursor === job!.cursor,
      "Import position changed. Refresh its status and retry.",
      409,
    );
    const people = job!.people as StagedPerson[];
    // Previously started imports retain the choices that were already applied.
    const legacy = job!.selections as Match[] | undefined;
    assert(
      job!.automatic || legacy,
      "This preview uses an older import format. Upload the CSV again.",
      409,
    );
    const counts = { ...job!.counts },
      end = Math.min(people.length, cursor + rosterLimits.batch);
    for (let index = cursor; index < end; index++) {
      const person = people[index];
      const previousChoice = legacy?.[index];
      const match =
        previousChoice?.memberId === "new"
          ? undefined
          : (previousChoice ?? person.match);
      const memberId = match?.memberId ?? person.newMemberId;
      const memberKey = key("MEMBER#" + memberId);
      const [claim, before, recordedMatch] = await Promise.all([
        tx.get(emailKey(person.email)),
        tx.get(memberKey),
        tx.get(matchKey(person)),
      ]);
      if (match)
        assert(
          before &&
            before.v === match.version &&
            (legacy || matchesPerson(before, person)),
          `Row ${person.line}: this entry changed since preview. Upload the CSV again.`,
          409,
        );
      else
        assert(!before, "New roster entry changed. Upload the CSV again.", 409);
      if (recordedMatch && recordedMatch.memberId !== memberId) {
        const other = await tx.get(key("MEMBER#" + recordedMatch.memberId));
        assert(
          !matchesPerson(other, person),
          `Row ${person.line}: this name and email were imported since preview. Upload the CSV again.`,
          409,
        );
      }
      if (legacy) {
        assert(
          !claim || claim.memberId === memberId,
          `Row ${person.line}: this email is reserved for another account.`,
          409,
        );
        if (before?.csvEmail && before.csvEmail !== person.email) {
          const oldClaim = await tx.get(emailKey(before.csvEmail));
          assert(
            oldClaim?.memberId === memberId,
            "Existing CSV email reservation needs administrator review.",
            409,
          );
          await tx.put({ ...oldClaim, retired: true });
        }
      }
      const enroll = claim
        ? claim.memberId === memberId && (legacy || !claim.retired)
        : !!legacy || person.canEnroll;
      if (recordedMatch?.memberId !== memberId)
        await tx.put(row(matchKey(person).pk, "METADATA", { memberId }));
      const barcode = await assignCard(tx, memberId, before?.barcode);
      const next = {
        ...(before ?? row(memberKey.pk, memberKey.sk, {})),
        memberId,
        displayName:
          !legacy && before ? before.displayName : person.displayName,
        email: person.email,
        csvEmail: enroll ? person.email : before?.csvEmail,
        barcode,
        memberKind: before?.memberKind ?? person.memberKind ?? "student",
        active: before?.active ?? true,
        gsi1pk: "MEMBERS",
        gsi1sk: memberId,
      } as Row;
      const changed =
        !before ||
        ["displayName", "email", "csvEmail", "barcode"].some(
          (field) => before[field] !== next[field],
        );
      if (changed) await tx.put(next);
      if (enroll && (!claim || claim.retired))
        await tx.put(
          row(emailKey(person.email).pk, "METADATA", {
            memberId,
            retired: false,
          }),
        );
      counts[!before ? "created" : changed ? "updated" : "unchanged"]++;
    }
    const nextJob = {
      ...job!,
      counts,
      cursor: end,
      status: end === people.length ? "completed" : "running",
    };
    await tx.put(nextJob);
    await app.audit(tx, p, "roster.csv_batch", id, {
      processed: end,
      total: people.length,
      counts,
    });
    return dto(nextJob, false);
  });
}
