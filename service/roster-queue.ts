import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { assert } from "./model";
export async function enqueueRosterSync(jobId: string) {
  const queue = process.env.ROSTER_SYNC_QUEUE_URL;
  assert(queue, "Google roster sync is not configured.", 503);
  await new SQSClient({}).send(
    new SendMessageCommand({
      QueueUrl: queue,
      MessageBody: JSON.stringify({ jobId }),
      MessageGroupId: "google-roster",
      MessageDeduplicationId: jobId,
    }),
  );
}
