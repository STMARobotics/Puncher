import { it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { csv, stage, files, applyStage, rollback } from "../scripts/migration";
import { fixture, admin } from "./helpers";
import { hash, key } from "../service/model";
import { all, atomic } from "../service/store";
function synthetic() {
  const dir = mkdtempSync(join(tmpdir(), "puncher-csv-"));
  writeFileSync(
    join(dir, files.members),
    'Name,User,Shop Hours (Career),Volunteer Hours (Career)\n"Example, Alex",,2,1\n',
  );
  writeFileSync(
    join(dir, files.shop),
    'Date,Submitted By,Hours,Member\n5/1/2026,,1,"Example, Alex"\n5/1/2026,,1,"Example, Alex"\n,,,"Example, Alex"\n5/2/2026,,-1,"Example, Alex"\n5/3/2026,,300,"Example, Alex"\n',
  );
  writeFileSync(
    join(dir, files.volunteer),
    'Title,Submitted By,Event Type,Volunteer Date,Volunteer Hours,Approved,Member\n"Open\nhouse",,,5/1/2026,1,checked,"Example, Alex"\nSecond,,,5/2/2026,1,,"Example, Alex"\n',
  );
  writeFileSync(
    join(dir, files.safety),
    "Tool/Machine,Submitted By,Tool,Trainer,Year,Context,Member\n",
  );
  return dir;
}
it("parses BOM quoted commas multiline and empty fields with strict row shapes", () => {
  expect(
    csv('\ufeffName,Value\n"Example, Alex","first\nsecond"\nOther,\n', [
      "Name",
      "Value",
    ]),
  ).toEqual([
    { Name: "Example, Alex", Value: "first\nsecond" },
    { Name: "Other", Value: "" },
  ]);
  expect(() => csv("Name,Value\nExtra,1,2", ["Name"])).toThrow();
});
it("stages duplicates separately, quarantines anomalies, preserves approval and never imports rollups", () => {
  const dir = synthetic();
  try {
    const s = stage(dir);
    expect(s.controls.sourceCounts).toEqual({
      members: 1,
      shop: 5,
      volunteer: 2,
      safety: 0,
    });
    expect(s.controls.shop.repeatedBeyondFirst).toBe(1);
    expect(
      s.records.filter((r) => r.sk.startsWith("LEGACYSHOP#")),
    ).toHaveLength(5);
    expect(new Set(s.records.map((r) => r.provenance.importKey)).size).toBe(8);
    const vs = s.records.filter((r) => r.sk.startsWith("VOLUNTEER#"));
    expect(vs.map((r) => r.status)).toEqual(["approved", "pending_review"]);
    expect(vs[0].title).toBe("Open\nhouse");
    expect(
      s.records
        .filter((r) => r.sk.startsWith("LEGACYSHOP#"))
        .every((r) => r.status === "quarantined"),
    ).toBe(true);
    expect(s.records.some((r) => r.startedAt)).toBe(false);
  } finally {
    rmSync(dir, { recursive: true });
  }
});
it("resumes exactly, requires reviewed hash and skips modified records during rollback", async () => {
  const dir = synthetic();
  try {
    const s = stage(dir),
      { db } = await fixture();
    await expect(applyStage(db, s, admin.id, "wrong")).rejects.toThrow(
      "checksum",
    );
    await applyStage(db, s, admin.id, hash(JSON.stringify(s)));
    await applyStage(db, s, admin.id, hash(JSON.stringify(s)));
    const credits = s.records.filter((r) => r.sk.startsWith("VOLUNTEER#"));
    expect(await all(db, credits[0].pk, { prefix: "VOLUNTEER#" })).toHaveLength(
      2,
    );
    await atomic(db, async (tx) => {
      const r = await tx.get(key(credits[0].pk, credits[0].sk));
      await tx.put({ ...r!, reviewReason: "Reviewed later" });
    });
    const r = await rollback(db, s.batchId, admin.id);
    expect(r.skipped).toBeGreaterThan(0);
    expect(await db.get(key(credits[0].pk, credits[0].sk))).toBeTruthy();
  } finally {
    rmSync(dir, { recursive: true });
  }
});
it("references unchanged rows in a later export without awarding duplicates", async () => {
  const dir = synthetic();
  try {
    const { db } = await fixture();
    const first = stage(dir);
    await applyStage(db, first, admin.id, hash(JSON.stringify(first)));
    const filename = join(dir, files.shop);
    const fs = await import("node:fs");
    fs.appendFileSync(filename, '5/4/2026,,2,"Example, Alex"\n');
    const second = stage(dir);
    await applyStage(db, second, admin.id, hash(JSON.stringify(second)));
    const member = first.records.find((r) => r.sk === "METADATA")!;
    expect(await all(db, member.pk, { prefix: "LEGACYSHOP#" })).toHaveLength(6);
    await rollback(db, second.batchId, admin.id);
    expect(await all(db, member.pk, { prefix: "LEGACYSHOP#" })).toHaveLength(5);
  } finally {
    rmSync(dir, { recursive: true });
  }
});
