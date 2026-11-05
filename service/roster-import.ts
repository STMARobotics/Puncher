import { Puncher } from "./domain";
import { assignCard } from "./card-codes";
import { parseRosterCsv, rosterLimits, type CsvPerson } from "./roster-csv";
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

type Choice = { memberId: string; version?: number };
type StagedPerson = CsvPerson & {
  newMemberId: string;
  suggested: Choice;
  allowNew: boolean;
  reason: string;
};
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
    ...(includeRows ? { people: job.people, selections: job.selections } : {}),
  };
}
export async function previewRoster(
  db: Store,
  p: Principal,
  id: unknown,
  csv: unknown,
) {
  mentor(p);
  assert(validId(id), "A valid upload request ID is required.");
  const people = parseRosterCsv(csv),
    sourceHash = hash(csv as string),
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
  const members = await all(db, "MEMBERS", { index: "GSI1" });
  const byEmail = new Map<string, Row[]>();
  for (const member of members)
    if (typeof member.email === "string" && member.email.trim()) {
      const email = member.email.trim().toLowerCase();
      byEmail.set(email, [...(byEmail.get(email) ?? []), member]);
    }
  const staged: StagedPerson[] = [];
  async function stage(person: CsvPerson): Promise<StagedPerson> {
    const claim = await db.get(emailKey(person.email));
    const claimedMember = claim
      ? await db.get(key("MEMBER#" + claim.memberId))
      : undefined;
    const matches = byEmail.get(person.email) ?? [];
    const known =
      claim && !claim.retired && claimedMember?.csvEmail === person.email
        ? claimedMember
        : !claim && matches.length === 1
          ? matches[0]
          : undefined;
    const needsReview =
      (!!claim && !known) ||
      matches.length > 1 ||
      (members.length > 0 && !known);
    return {
      ...person,
      newMemberId: uid(),
      allowNew: !claim && matches.length === 0,
      suggested: known
        ? { memberId: known.memberId, version: known.v }
        : { memberId: needsReview ? "" : "new" },
      reason: known
        ? "Existing email — review this match"
        : needsReview
          ? "Choose an existing member or confirm this is a new person"
          : "New member",
    };
  }
  // Bound lookup concurrency so larger exports fit the request deadline.
  for (let offset = 0; offset < people.length; offset += 20) {
    staged.push(
      ...(await Promise.all(people.slice(offset, offset + 20).map(stage))),
    );
  }
  assert(
    Buffer.byteLength(JSON.stringify(staged), "utf8") <= 256 * 1024,
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
      people: staged,
      status: "preview",
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
  choices?: unknown,
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
    let selections = job!.selections as Choice[] | undefined;
    if (!selections) {
      assert(
        Array.isArray(choices) && choices.length === people.length,
        "Review every CSV row before importing.",
      );
      const selected = new Set<string>();
      selections = choices.map((choice: any) => {
        assert(
          choice &&
            typeof choice.memberId === "string" &&
            choice.memberId.length > 0 &&
            choice.memberId.length <= 256,
          "Choose an existing member or Create new member for every row.",
        );
        if (choice.memberId !== "new") {
          assert(
            Number.isInteger(choice.version) && choice.version > 0,
            "Refresh members before choosing an existing account.",
          );
          assert(
            !selected.has(choice.memberId),
            "Two CSV rows cannot be linked to the same member.",
          );
          selected.add(choice.memberId);
        }
        return {
          memberId: choice.memberId,
          ...(choice.memberId !== "new" ? { version: choice.version } : {}),
        };
      });
    }
    const counts = { ...job!.counts },
      end = Math.min(people.length, cursor + rosterLimits.batch);
    for (let index = cursor; index < end; index++) {
      const person = people[index],
        selection = selections[index];
      assert(
        selection.memberId !== "new" || person.allowNew,
        `Row ${person.line}: this email already belongs to an existing member. Choose an existing account.`,
        409,
      );
      const claim = await tx.get(emailKey(person.email));
      const memberId =
        selection.memberId === "new" ? person.newMemberId : selection.memberId;
      assert(
        !claim || claim.memberId === memberId,
        `Row ${person.line}: this email is already reserved for another member. Upload again and review the match.`,
        409,
      );
      const memberKey = key("MEMBER#" + memberId),
        before = await tx.get(memberKey);
      if (selection.memberId === "new")
        assert(!before, "New-member request changed. Upload again.", 409);
      else
        assert(
          before && before.v === selection.version,
          `Row ${person.line}: this member changed since preview. Upload again to review current data; completed batches remain saved.`,
          409,
        );
      if (before?.csvEmail && before.csvEmail !== person.email) {
        const oldKey = emailKey(before.csvEmail),
          oldClaim = await tx.get(oldKey);
        assert(
          oldClaim?.memberId === memberId,
          "Existing CSV email reservation needs administrator review.",
          409,
        );
        await tx.put({ ...oldClaim, retired: true });
      }
      const barcode = await assignCard(tx, memberId, before?.barcode);
      const next = {
        ...(before ?? row(memberKey.pk, memberKey.sk, {})),
        memberId,
        displayName: person.displayName,
        email: person.email,
        csvEmail: person.email,
        barcode,
        memberKind: before?.memberKind ?? "student",
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
      if (!claim || claim.retired)
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
      selections,
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
