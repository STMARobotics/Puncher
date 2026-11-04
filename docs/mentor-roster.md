# Mentor access, roster sync and ID cards

Puncher's home page is mentor Google login. Approved mentors can manage attendance members, create volunteer events and launch the kiosk. Mentor login uses the current main branch's server-side OAuth flow and seven-day HttpOnly session, including restoration after a page refresh. Students do not sign into Puncher. An attendance member's participant type is independent of permission to use mentor tools. Only a mentor administrator can grant mentor/administrator access. New mentors sign in once to create a verified access request; the administrator approves it under Manage members → mentor access. The first administrator still uses the existing AWS-authorized bootstrap command. Approval preserves existing Stats roles and member links; roster sync grants no login/reporting permissions.

## Daily workflow

1. A mentor opens Manage members and presses **Sync roster**. The button is disabled until the Google connection is configured. Nothing runs on a roster schedule.
2. The background job reads the complete `stmarobotics.org` directory, then creates or updates members using Google's immutable directory user ID. On a new empty roster, active users are enabled and receive unique random six-digit codes automatically. Existing codes, native member IDs and attendance history remain stable across name/email changes and repeated syncs.
3. For an existing roster, exact previously approved Google identity bindings can be reused. Unmapped users require a one-time explicit **Link existing** or **Create new member** decision while legacy members remain. Names, emails and barcode values are never used to infer identity. This avoids assigning old attendance to the wrong person. Inactive historical legacy members must also be considered before choosing Create new.
4. **Export active roster CSV** downloads name, email and barcode for external ID-card generation. Puncher has no print function. New codes use 100000–999999; existing leading-zero codes stay valid. Import the barcode column as text in spreadsheet/label tools so those existing zeros survive. Codes identify members; they are not passwords.

Mentors can add an exceptional/manual member without a Google account. Roster sync does not delete unmanaged members. Suspended, archived or removed managed users are disabled after a successful full directory read. A mentor's explicit inactive override survives later syncs; a Google-disabled member must first be reactivated in Google. Removing a user from Google does not remove their attendance history. **Replace card code** invalidates the previous claim and preserves the same member/history. Retired codes are permanently reserved against reassignment to a different member; retries of the same replacement return the same code.

## One-time Google Workspace setup

A Workspace administrator must configure this connection; ordinary mentor login does not authorize reading the domain directory. The roster service-account credential in Secrets Manager is separate from the OAuth web-client secret in Parameter Store described in [deployment](deployment.md). The existing OAuth login configuration is retained.

1. In a controlled Google Cloud project, enable the Admin SDK API and create a dedicated service account with domain-wide delegation. Generate its JSON credential securely.
2. A Workspace super administrator authorizes that service account's client ID for **only** `https://www.googleapis.com/auth/admin.directory.user.readonly`. Use a dedicated delegated Workspace account with directory user read privileges covering the whole selected domain. Do not scope it to a subset of organizational units: absent users in a completed snapshot are treated as removed.
3. Store the JSON as a Secrets Manager SecretString in Puncher's AWS account and region. Never put the JSON/private key in Git, browser configuration, CDK context or logs. Use the AWS-managed default secret encryption, or separately grant the roster worker decrypt access if using a customer-managed KMS key. Rotate the credential through Secrets Manager/Google operationally; the worker reads the current secret each invocation.
4. Add non-secret `rosterSync` configuration to the CDK app context, for example in the deployment checkout's `cdk/cdk.json`. Keep it in the actual deployment configuration so GitHub main deployments use it too:

```json
{
  "context": {
    "rosterSync": {
      "domain": "stmarobotics.org",
      "delegatedAdminEmail": "directory-reader@stmarobotics.org",
      "credentialsSecretArn": "arn:aws:secretsmanager:us-east-2:ACCOUNT:secret:puncher-google-roster-SUFFIX"
    }
  }
}
```

Merge this object into the existing context; preserve its other keys. Replace ACCOUNT/SUFFIX with the actual complete same-account/region ARN. Synthesize/review and deploy backend and frontend together so the button capability flag matches the queue. The default build creates no roster worker/queue and grants no Google-secret access.

The enabled topology is mentor-authenticated HTTP request → FIFO SQS → one on-demand Lambda worker → Google Directory and Puncher's existing table. Only the worker can read the secret. It cannot write identity roles or attendance credits. SQS is a work queue for this bounded command, not a change to the cross-app EventBridge design. Existing activity contracts and native `puncher.member` subjects remain unchanged. New cross-app identity unification and automatic Stats login provisioning remain separate from attendance enrollment.

Official references: [Google service-account and domain-wide delegation setup](https://developers.google.com/workspace/guides/create-credentials), [Directory users.list and read-only authorization scope](https://developers.google.com/workspace/admin/directory/reference/rest/v1/users/list).

## Failure and retry behavior

The job has a durable ID/status/counts record and a ten-minute lease. Repeated clicks reuse the active job; stale deliveries cannot update a newer run. The browser polls only while the job is active. Google pages are fully fetched and validated before any membership changes; malformed, partial or suspiciously empty responses fail without applying removals. There is no all-roster transaction: a database/authorization failure during application can leave some members updated. Inspect status and rerun; stable directory links, conditional transactions and reserved codes make the rerun safe. A timed-out run expires; retry from the button. Unexpected delivery failures use the FIFO dead-letter queue/alarm. The worker is limited to 300 seconds and 10,000 source users; review chunking/checkpointing before scaling beyond the team's roster.

## Kiosk launch and recovery

**Launch kiosk** requires a current mentor login and sets a random HttpOnly, Secure, SameSite=Strict cookie. The server revokes this browser's seven-day mentor session in the same DynamoDB transaction that creates/renews the kiosk session, then clears the mentor and pending OAuth cookies in the response. The browser also clears any in-memory fixture/bearer token and replaces the dashboard with `/kiosk`. A failed transaction leaves the mentor session intact. Other browsers' mentor sessions are unaffected. No operator copies a device ID or secret. An internal session ID remains necessary for revocation, audit and idempotent scan recovery; the existing DEVICE key namespace is retained to preserve deployment and data compatibility.

The server expires kiosk authorization after 12 hours. The renewal cookie can remain for 30 days, but cannot authorize scans after expiry without a new mentor login/launch. Renewal rotates the secret and retains the operation namespace so a saved unconfirmed scan cannot become a fresh toggle. Sessions can be ended from the kiosk or revoked from mentor tools; mentor administrators can revoke any session. Disabling the launching mentor also invalidates their kiosks immediately. Old manually provisioned devices are rejected until a mentor relaunches the kiosk.

If browser/session storage is lost or a pending scan belongs to a different kiosk session, scanning stays locked for mentor review. Check canonical attendance before using Clear reviewed scan. Do not resolve uncertainty by scanning the same card again with a new operation. Use a dedicated, secured kiosk browser profile; leaving kiosk mode does not grant mentor API permissions, though the browser's Google account itself may remain signed into Google.

Local/CI testing can set `LOCAL_ROSTER_FIXTURES=true` together with explicit DynamoDB Local and auth fixtures. This uses a small synthetic directory only; production rejects these flags. Live Google delegation, actual printed-card/scanner behavior and deployed AWS acceptance still require operational verification.
