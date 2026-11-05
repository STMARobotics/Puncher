# Mentor access, roster CSV uploads and ID cards

Mentors sign in with Google to manage attendance members, create volunteer events and launch the kiosk. New mentors sign in once to request access. A mentor administrator approves the request under Manage members → Mentor access. Existing Google login uses the OAuth web-client secret in Parameter Store as described in [deployment](deployment.md).

## Upload members

1. Export the team group's member list from Google Workspace. Use the UTF-8 CSV with Member Name, Member Email and Member Role headings. [Google Workspace group export instructions](https://knowledge.workspace.google.com/admin/groups/view-a-groups-members#export-a-list-of-group-members)
2. In Puncher, open **Manage members → Upload members CSV**, choose the file and select **Preview CSV**. Each file can contain up to 500 people and 128 KB. Use individual stmarobotics.org members. If the export includes a Member Type column, rows must be USER. The parser accepts quoted fields, a UTF-8 BOM and standard line endings. It reports invalid or duplicate emails before enrollment starts.
3. Review existing-member suggestions by email. For a person with an old record or a renamed address, choose that existing member to retain the card and hours. Choose **Create new member** for genuinely new people, or mark the remaining unmatched rows as new in one step. A Google group role is discarded after validation. Login permissions come from separately approved identities.
4. Select **Import reviewed members**. New members start active with a unique six-digit code. Existing members keep their card codes, history and activation settings. Omitted members retain their status, which lets mentors import a subset of the roster. Manage activation from the member's edit form.
5. Use **Export active roster CSV** to get name, email and barcode for external card generation. Import the barcode column as text to preserve leading zeros in older codes.

The preview records a proposed match only. Email reservations make repeated imports safe and prevent two CSV requests from creating separate accounts for the same email. A renamed address can be linked explicitly to the existing member, and the previous email reservation is retained for review. Use the current roster when deciding how to handle a recycled address. A previously disabled member can be re-enabled through the edit form after mentor review.

## Progress and recovery

The existing mentor API validates the file, then stores the normalized preview and progress for up to 24 hours. Each request applies up to ten reviewed rows atomically. A retry at an already processed position returns saved progress. The browser can resume a partially completed import after a reload. Completed batches remain saved. If a reviewed member changes mid-import, upload again to review the latest record and continue. The original file and Google group roles are discarded after parsing.

CSV enrollment uses the existing API and DynamoDB table. Directory API sync, its optional worker and its queue have been retired. Deployments that previously configured that worker should finish outstanding roster jobs and remove the old rosterSync context during rollout. The import keeps native attendance identifiers and does not generate activity credits.

## Kiosk launch and recovery

Select **Start kiosk** on the shared device. On their phone, a mentor signs in and selects **Generate kiosk activation QR**. The kiosk accepts the code once within two minutes and records the mentor and server start time. Activation creates a scoped kiosk session and clears any human session in that browser. The mentor phone stays signed in.

Members sign in with their Workspace accounts to display their six-digit attendance code as a Code 128 barcode. Puncher accepts an approved student account link or an active CSV roster email matching the verified Google email. The first verified CSV login is tied to the Google subject. A replacement Google account using the same email requires review. Scanning the phone barcode uses the same attendance record as the printed card.

The server expires kiosk authorization after 12 hours. The renewal cookie can remain for 30 days, but cannot authorize scans after expiry without a new mentor login/launch. Renewal rotates the secret and retains the operation namespace so a saved unconfirmed scan cannot become a fresh toggle. Sessions can be ended from the kiosk or revoked from mentor tools; mentor administrators can revoke any session. Disabling the launching mentor also invalidates their kiosks immediately. Old manually provisioned devices are rejected until a mentor relaunches the kiosk.

If browser/session storage is lost or a pending scan belongs to a different kiosk session, scanning stays locked for mentor review. Check canonical attendance before using Clear reviewed scan. Do not resolve uncertainty by scanning the same card again with a new operation. Use a dedicated, secured kiosk browser profile; leaving kiosk mode does not grant mentor API permissions, though the browser's Google account itself may remain signed into Google.
