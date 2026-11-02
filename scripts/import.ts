import { readFileSync } from "node:fs";
import { stage, writeStage, applyStage, rollback } from "./migration";
import { hash, assert } from "../service/model";
const args = process.argv.slice(2);
const arg = (name: string, fallback = "") =>
  args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
if (args.includes("--apply")) {
  assert(
    arg("--stage") && arg("--review-sha") && arg("--admin-sub"),
    "Apply requires --stage, --review-sha and --admin-sub.",
  );
  assert(
    process.env.CONFIRM_IMPORT === "true",
    "Set CONFIRM_IMPORT=true only after reviewing the staged report.",
  );
  const { store } = await import("../service/runtime");
  const s = JSON.parse(readFileSync(arg("--stage"), "utf8"));
  console.log(
    await applyStage(store(), s, arg("--admin-sub"), arg("--review-sha")),
  );
} else if (args.includes("--rollback")) {
  assert(
    process.env.CONFIRM_IMPORT === "true",
    "Rollback requires CONFIRM_IMPORT=true.",
  );
  const { store } = await import("../service/runtime");
  console.log(await rollback(store(), arg("--rollback"), arg("--admin-sub")));
} else {
  const directory = arg(
    "--directory",
    "C:\\Users\\zacharyo\\Documents\\Airtable data",
  );
  const mapping = arg("--mapping")
    ? JSON.parse(readFileSync(arg("--mapping"), "utf8"))
    : {};
  const s = stage(directory, mapping);
  const out = arg("--out", "migration-private/dry-run");
  writeStage(s, out);
  console.log(
    JSON.stringify(
      {
        out,
        batchId: s.batchId,
        sourceCounts: s.controls.sourceCounts,
        shop: s.controls.shop,
        volunteer: s.controls.volunteer,
        unmatched: s.controls.unmatched.length,
        reviewCandidates: s.issues.length,
        reviewHash: hash(JSON.stringify(s)),
      },
      null,
      2,
    ),
  );
}
