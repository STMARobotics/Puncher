import { store } from "./runtime";
import { runRosterSync } from "./roster";
import { readGoogleDirectory } from "./google-directory";
export async function handler(event: {
  Records: { messageId: string; body: string }[];
}) {
  const failures: { itemIdentifier: string }[] = [];
  for (const record of event.Records) {
    try {
      const { jobId } = JSON.parse(record.body);
      if (typeof jobId !== "string" || !/^[0-9a-f-]{36}$/.test(jobId))
        throw new Error("Invalid roster job");
      await runRosterSync(store(), jobId, () =>
        readGoogleDirectory({
          domain: process.env.GOOGLE_ROSTER_DOMAIN ?? "",
          delegatedAdmin: process.env.GOOGLE_ROSTER_DELEGATED_ADMIN ?? "",
          secretArn: process.env.GOOGLE_ROSTER_SECRET_ARN ?? "",
        }),
      );
    } catch {
      console.error(
        JSON.stringify({
          event: "roster_delivery_failed",
          messageId: record.messageId,
        }),
      );
      failures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures: failures };
}
