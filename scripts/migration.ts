import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "csv-parse/sync";
import {
  type Row,
  hash,
  row,
  key,
  assert,
  hoursToSeconds,
  validDate,
  reportingYear,
  uid,
} from "../service/model";
import { type Store, atomic } from "../service/store";
export const files = {
  members: "Members-Grid view.csv",
  shop: "Attendance Tracking-Grid view.csv",
  volunteer: "Volunteer Tracking-Hours.csv",
  safety: "Safety Training Tracking-Grid view.csv",
};
const required = {
  members: ["Name", "User", "Shop Hours (Career)", "Volunteer Hours (Career)"],
  shop: ["Date", "Submitted By", "Hours", "Member"],
  volunteer: [
    "Title",
    "Submitted By",
    "Event Type",
    "Volunteer Date",
    "Volunteer Hours",
    "Approved",
    "Member",
  ],
  safety: [
    "Tool/Machine",
    "Submitted By",
    "Tool",
    "Trainer",
    "Year",
    "Context",
    "Member",
  ],
};
export const normalize = (s: string) =>
  s.trim().replace(/\s+/g, " ").toLowerCase();
export const stableId = (s: string) => {
  const h = hash(s);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
export function csv(content: string, headers: string[]) {
  const rows = parse(content, {
    bom: true,
    skip_empty_lines: true,
    columns: false,
    relax_column_count: false,
  }) as string[][];
  assert(rows.length, "Empty CSV.");
  for (const h of headers)
    assert(rows[0].includes(h), `Missing required header: ${h}`);
  assert(new Set(rows[0]).size === rows[0].length, "Duplicate CSV headers.");
  return rows
    .slice(1)
    .map((values) => Object.fromEntries(rows[0].map((h, i) => [h, values[i]])));
}
function legacyDate(value: string) {
  const m = value.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  assert(m, "Missing or invalid local date.");
  return validDate(`${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`);
}
export type Mapping = {
  members?: Record<string, string>;
  aliases?: Record<string, string>;
  recordAliases?: Record<string, string>;
};
export function stage(directory: string, mapping: Mapping = {}) {
  const sources = Object.fromEntries(
    Object.entries(files).map(([kind, name]) => {
      const content = readFileSync(join(directory, name), "utf8");
      return [
        kind,
        {
          name,
          checksum: hash(content),
          rows: csv(content, required[kind as keyof typeof required]),
        },
      ];
    }),
  ) as Record<
    string,
    { name: string; checksum: string; rows: Record<string, string>[] }
  >;
  const batchId = hash(
    Object.values(sources)
      .map((x) => x.checksum)
      .join("|"),
  ).slice(0, 24);
  const members = new Map<string, Row>(),
    records: Row[] = [],
    issues: any[] = [];
  const names = new Map<string, Row>();
  sources.members.rows.forEach((raw, i) => {
    const name = normalize(raw.Name);
    assert(
      name && !members.has(name),
      `Missing or ambiguous member name at record ${i + 2}.`,
    );
    const memberId =
      mapping.members?.[name] || stableId(`airtable-member:${name}`);
    assert(
      !names.has(memberId),
      `Multiple names mapped to one member: ${name}`,
    );
    const m = row(`MEMBER#${memberId}`, "METADATA", {
      memberId,
      displayName: raw.Name.trim(),
      memberKind: "student",
      active: true,
      gsi1pk: "MEMBERS",
      gsi1sk: memberId,
      legacyReference: raw.User || undefined,
      provenance: {
        batchId,
        sourceFile: sources.members.name,
        fileChecksum: sources.members.checksum,
        recordNumber: i + 2,
        importKey: `member:${memberId}`,
      },
    });
    members.set(name, m);
    names.set(memberId, m);
    records.push(m);
  });
  const controls: any = {
    sourceCounts: Object.fromEntries(
      Object.entries(sources).map(([k, s]) => [k, s.rows.length]),
    ),
    shop: {
      missingDates: 0,
      missingHours: 0,
      negative: 0,
      zero: 0,
      above24: 0,
      repeatedBeyondFirst: 0,
      numericSeconds: 0,
    },
    volunteer: {
      missingDates: 0,
      missingHours: 0,
      approvalDistribution: {},
      numericSeconds: 0,
    },
    safety: { distinctMembers: 0 },
    unmatched: [],
    reconciliation: [],
  };
  const totals = new Map<string, { shop: number; volunteer: number }>();
  for (const kind of ["shop", "volunteer"] as const) {
    const source = sources[kind],
      frequencies = new Map<string, number>(),
      seen = new Map<string, number>();
    for (const raw of source.rows) {
      const fingerprint = hash(JSON.stringify(raw));
      frequencies.set(fingerprint, (frequencies.get(fingerprint) || 0) + 1);
    }
    source.rows.forEach((raw, index) => {
      const reasons: string[] = [],
        recordNumber = index + 2,
        fp = hash(JSON.stringify(raw)),
        occurrence = (seen.get(fp) || 0) + 1;
      seen.set(fp, occurrence);
      const importKey =
        mapping.recordAliases?.[`${source.checksum}:${recordNumber}`] ||
        hash(`${source.name}:${fp}:${occurrence}`);
      const normalized = normalize(raw.Member),
        resolved = mapping.aliases?.[normalized] || normalized;
      const member = members.get(resolved);
      if (!member) {
        reasons.push("unmatched_member");
        controls.unmatched.push({
          sourceFile: source.name,
          recordNumber,
          member: raw.Member,
        });
      }
      let date: string | undefined, seconds: number | undefined;
      const rawDate = raw[kind === "shop" ? "Date" : "Volunteer Date"],
        rawHours = raw[kind === "shop" ? "Hours" : "Volunteer Hours"];
      if (!rawDate.trim()) controls[kind].missingDates++;
      try {
        date = legacyDate(rawDate);
        if (date < "2015-01-01" || date > new Date().toISOString().slice(0, 10))
          reasons.push("suspect_date");
      } catch {
        reasons.push("missing_or_invalid_date");
      }
      if (!rawHours.trim()) {
        controls[kind].missingHours++;
        reasons.push("missing_hours");
      } else
        try {
          seconds = hoursToSeconds(rawHours);
          controls[kind].numericSeconds += seconds;
          if (seconds < 0) {
            reasons.push("negative_hours");
            if (kind === "shop") controls.shop.negative++;
          }
          if (seconds === 0) {
            reasons.push("zero_hours");
            if (kind === "shop") controls.shop.zero++;
          }
          if (seconds > 86400) {
            reasons.push("above_24_hours");
            if (kind === "shop") controls.shop.above24++;
          }
        } catch {
          reasons.push("invalid_hours");
        }
      if ((frequencies.get(fp) || 0) > 1) reasons.push("duplicate_candidate");
      if (kind === "shop" && occurrence > 1)
        controls.shop.repeatedBeyondFirst++;
      if (kind === "volunteer") {
        const approval = raw.Approved.trim();
        controls.volunteer.approvalDistribution[approval || "(blank)"] =
          (controls.volunteer.approvalDistribution[approval || "(blank)"] ||
            0) + 1;
        if (!["", "checked"].includes(approval))
          reasons.push("unknown_approval");
      }
      if (member) {
        const t = totals.get(member.memberId) || { shop: 0, volunteer: 0 };
        t[kind] += seconds || 0;
        totals.set(member.memberId, t);
      }
      const status = reasons.some((r) => r !== "zero_hours")
        ? "quarantined"
        : kind === "volunteer" && raw.Approved !== "checked"
          ? "pending_review"
          : "approved";
      const pk = member?.pk || `UNMATCHED#${batchId}`;
      const sk = `${kind === "shop" ? "LEGACYSHOP" : "VOLUNTEER"}#${date || "UNDATED"}#${importKey}`;
      const provenance = {
        batchId,
        sourceFile: source.name,
        fileChecksum: source.checksum,
        recordNumber,
        occurrence,
        importKey,
        raw,
        reasons,
      };
      records.push(
        row(pk, sk, {
          ...(member ? { memberId: member.memberId } : {}),
          ...(kind === "shop"
            ? { recordType: "legacy_shop_hours", shopDate: date }
            : {
                awardId: importKey,
                title: raw.Title,
                eventDate: date,
                originalApproval: raw.Approved,
              }),
          reportingYear: date ? reportingYear(date) : undefined,
          creditedSeconds: seconds,
          status,
          provenance,
        }),
      );
      if (reasons.length || status !== "approved")
        issues.push({
          importKey,
          sourceFile: source.name,
          recordNumber,
          displayName: member?.displayName,
          status,
          reasons,
        });
    });
  }
  const safetyMembers = new Set();
  sources.safety.rows.forEach((raw, i) => {
    const normalized = normalize(raw.Member);
    if (!members.has(mapping.aliases?.[normalized] || normalized))
      controls.unmatched.push({
        sourceFile: sources.safety.name,
        recordNumber: i + 2,
        member: raw.Member,
      });
    else if (raw.Member.trim()) safetyMembers.add(normalized);
  });
  controls.safety.distinctMembers = safetyMembers.size;
  for (const raw of sources.members.rows) {
    const m = members.get(normalize(raw.Name))!,
      actual = totals.get(m.memberId) || { shop: 0, volunteer: 0 };
    const rollup = (s: string) => {
      try {
        return hoursToSeconds(s);
      } catch {
        return null;
      }
    };
    const shop = rollup(raw["Shop Hours (Career)"]),
      volunteer = rollup(raw["Volunteer Hours (Career)"]);
    controls.reconciliation.push({
      memberId: m.memberId,
      displayName: m.displayName,
      sourceShopSeconds: actual.shop,
      rollupShopSeconds: shop,
      shopDifference: shop == null ? null : actual.shop - shop,
      sourceVolunteerSeconds: actual.volunteer,
      rollupVolunteerSeconds: volunteer,
      volunteerDifference:
        volunteer == null ? null : actual.volunteer - volunteer,
    });
  }
  return {
    schemaVersion: 1,
    batchId,
    sources: Object.values(sources).map(({ name, checksum }) => ({
      name,
      checksum,
    })),
    controls,
    issues,
    records,
  };
}
export type Staged = ReturnType<typeof stage>;
export async function applyStage(
  db: Store,
  s: Staged,
  adminSub: string,
  reviewHash: string,
) {
  assert(
    reviewHash === hash(JSON.stringify(s)),
    "Stage checksum does not match the reviewed report.",
  );
  const identity = await db.get(key(`IDENTITY#${adminSub}`));
  assert(
    identity?.enabled && identity.roles.includes("admin"),
    "Enabled administrator subject required.",
  );
  assert(
    s.controls.unmatched.length === 0,
    "Resolve unmatched member mappings before importing.",
  );
  await atomic(db, async (tx) => {
    const prior = await tx.get(key(`IMPORT#${s.batchId}`, "MANIFEST"));
    assert(
      !prior || prior.reviewHash === reviewHash,
      "A different reviewed stage already owns this batch ID. Resume the exact stage or review a new batch.",
    );
    if (!prior) {
      await tx.put(
        row(`IMPORT#${s.batchId}`, "MANIFEST", {
          batchId: s.batchId,
          status: "importing",
          sources: s.sources,
          reviewHash,
          recordCount: s.records.length,
          adminSub,
          at: new Date().toISOString(),
        }),
      );
      await tx.put(
        row("AUDIT", `${new Date().toISOString()}#${uid()}`, {
          action: "import.started",
          actor: adminSub,
          target: s.batchId,
          reviewHash,
        }),
      );
    }
  });
  // Each row and manifest pointer commit together. Existing or subsequently edited rows are never overwritten.
  for (const proposed of s.records) {
    await atomic(db, async (tx) => {
      const importKey = proposed.provenance.importKey;
      const mk = key(`IMPORT#${s.batchId}`, importKey);
      if (await tx.get(mk)) return;
      const claimKey = key(`IMPORTKEY#${importKey}`);
      const claim = await tx.get(claimKey);
      if (claim) {
        assert(
          claim.recordPk === proposed.pk && claim.recordSk === proposed.sk,
          "This import alias targets an existing record with a different date/member. Review and void the prior credit before a corrected replacement.",
        );
        // Identical rows in later exports are references to the original import, not new credits.
        await tx.put(
          row(mk.pk, mk.sk, {
            recordPk: claim.recordPk,
            recordSk: claim.recordSk,
            referencedBatch: claim.batchId,
          }),
        );
        return;
      }
      const old = await tx.get(key(proposed.pk, proposed.sk));
      assert(
        !old,
        `Record ${importKey} already exists outside this batch. Supply reviewed aliases.`,
      );
      const { raw, ...provenance } = proposed.provenance;
      await tx.put({ ...proposed, provenance });
      if (raw)
        await tx.put(
          row(`SOURCE#${s.batchId}`, importKey, {
            raw,
            sourceFile: provenance.sourceFile,
            fileChecksum: provenance.fileChecksum,
            recordNumber: provenance.recordNumber,
          }),
        );
      await tx.put(
        row(claimKey.pk, claimKey.sk, {
          batchId: s.batchId,
          recordPk: proposed.pk,
          recordSk: proposed.sk,
        }),
      );
      await tx.put(
        row(mk.pk, mk.sk, {
          recordPk: proposed.pk,
          recordSk: proposed.sk,
          importedVersion: 1,
          contentHash: hash(JSON.stringify(proposed)),
        }),
      );
      if (!proposed.sk.startsWith("METADATA"))
        await tx.put(
          row("REVIEWS", importKey, {
            recordPk: proposed.pk,
            recordSk: proposed.sk,
            importKey,
            status: proposed.status,
            title: proposed.title,
            localDate: proposed.shopDate || proposed.eventDate,
            creditedSeconds: proposed.creditedSeconds,
            originalApproval: proposed.originalApproval,
            displayName: s.records.find(
              (r) => r.memberId === proposed.memberId && r.sk === "METADATA",
            )?.displayName,
            reasons: proposed.provenance.reasons,
            sourceFile: proposed.provenance.sourceFile,
            recordNumber: proposed.provenance.recordNumber,
          }),
        );
    });
  }
  await atomic(db, async (tx) => {
    await tx.put(
      row(`IMPORT#${s.batchId}`, "MANIFEST", {
        batchId: s.batchId,
        sources: s.sources,
        status: "complete",
        reviewHash,
        recordCount: s.records.length,
        adminSub,
        at: new Date().toISOString(),
      }),
    );
    await tx.put(
      row("AUDIT", `${new Date().toISOString()}#${uid()}`, {
        action: "import.complete",
        target: s.batchId,
        actor: adminSub,
        reviewHash,
      }),
    );
  });
  return { imported: s.records.length };
}
export async function rollback(db: Store, batchId: string, adminSub: string) {
  const identity = await db.get(key(`IDENTITY#${adminSub}`));
  assert(
    identity?.enabled && identity.roles.includes("admin"),
    "Enabled administrator required.",
  );
  let cursor;
  let removed = 0,
    skipped = 0;
  do {
    const page = await db.query(`IMPORT#${batchId}`, { cursor });
    for (const pointer of page.items) {
      if (pointer.sk === "MANIFEST") continue;
      if (pointer.referencedBatch) {
        skipped++;
        continue;
      }
      await atomic(db, async (tx) => {
        const r = await tx.get(key(pointer.recordPk, pointer.recordSk));
        if (!r) {
          return;
        }
        if (
          r.provenance?.batchId !== batchId ||
          r.v !== pointer.importedVersion
        ) {
          skipped++;
          return;
        }
        // Members with any later history or card/auth mapping must remain.
        if (r.sk === "METADATA") {
          const related = await db.query(r.pk, { limit: 2 });
          if (
            related.items.length > 1 ||
            r.barcode ||
            (await tx.get(key(`BINDING#${r.memberId}`)))
          ) {
            skipped++;
            return;
          }
        }
        await tx.del(key(r.pk, r.sk));
        await tx.del(key(pointer.pk, pointer.sk));
        await tx.del(key(`IMPORTKEY#${r.provenance.importKey}`));
        const source = await tx.get(
          key(`SOURCE#${batchId}`, r.provenance.importKey),
        );
        if (source) await tx.del(key(source.pk, source.sk));
        const review = await tx.get(key("REVIEWS", r.provenance.importKey));
        if (review) await tx.del(key(review.pk, review.sk));
        removed++;
      });
    }
    cursor = page.cursor;
  } while (cursor);
  await atomic(db, async (tx) => {
    await tx.put(
      row("AUDIT", `${new Date().toISOString()}#${uid()}`, {
        action: "import.rollback",
        actor: adminSub,
        target: batchId,
        removed,
        skipped,
      }),
    );
  });
  return { removed, skipped };
}
export function writeStage(s: Staged, out: string) {
  mkdirSync(out, { recursive: true });
  const content = JSON.stringify(s, null, 2);
  writeFileSync(join(out, "stage.json"), content);
  writeFileSync(join(out, "stage.sha256"), hash(JSON.stringify(s)));
  const c = s.controls;
  writeFileSync(
    join(out, "report.md"),
    `# AIRTABLE DRY RUN\n\nBatch: ${s.batchId}\n\nNo source files or database records were modified. Private stage.json contains names and source data; restrict access and do not commit it.\n\nSource counts: ${JSON.stringify(c.sourceCounts)}\n\nShop: ${JSON.stringify(c.shop)}\n\nVolunteer: ${JSON.stringify(c.volunteer)}\n\nUnmatched joins: ${c.unmatched.length}\n\nShop rollup discrepancies: ${c.reconciliation.filter((r: any) => r.shopDifference !== 0).length}\n\nVolunteer rollup discrepancies: ${c.reconciliation.filter((r: any) => r.volunteerDifference !== 0).length}\n\nReview candidates: ${s.issues.length}\n\nOnly dated, nonnegative, valid approved credits are eligible. Duplicate candidates and unusual historical rows remain quarantined. Blank volunteer approval remains pending_review. Safety rows and member rollups create no credits.\n`,
  );
}
