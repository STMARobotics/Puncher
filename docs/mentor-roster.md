# Mentor access, roster CSV uploads and ID cards

Mentors sign in with Google to manage attendance members, create volunteer events and launch the kiosk. New mentors sign in once to request access. A mentor administrator approves the request under Manage students → Mentor access. Existing Google login uses the OAuth web-client secret in Parameter Store as described in [deployment](deployment.md).

## Upload the roster

1. Export the Google Workspace group roster. The current format includes Group Email [Required], Member Email, Member Name, Member Role and Member Type. [Google Workspace group export instructions](https://knowledge.workspace.google.com/admin/groups/view-a-groups-members#export-a-list-of-group-members)
2. In Puncher, open **Manage students → Upload roster CSV** and choose **Preview CSV**. For older exports without a group email column, select the source group once for the file. Uploads accept up to 500 individual users and 128 KB per file.
3. Review the automatic matches, then select **Import roster**. Both name and email must match an existing entry to reuse its card, role, history and activation status. New entries receive an active six-digit card. The `frc.students` group assigns Student, and `frc.mentors` assigns Mentor for attendance. Google group ownership and attendance roles are separate from approved Puncher login privileges.
4. If a different name already uses the same email, Puncher creates a separate card and keeps the existing sign-in binding. An administrator can review account access separately.
5. Use **Export active roster CSV** for external card generation. Import the barcode column as text to preserve leading zeros.

## Progress and recovery

The existing mentor API validates the file, then stores the normalized preview and progress for up to 24 hours. Each request applies up to ten rows atomically. A retry at an already processed position returns saved progress. The browser can resume a partially completed import after a reload. Completed batches remain saved. If a matched entry changes mid-import, upload again to review the latest record and continue. The original file and Google group roles are discarded after parsing.

CSV enrollment uses the existing API and DynamoDB table. Directory API sync, its optional worker and its queue have been retired. Deployments that previously configured that worker should finish outstanding roster jobs and remove the old rosterSync context during rollout. The import keeps native attendance identifiers and does not generate activity credits.

## Kiosk launch and recovery

Select **Start kiosk** on the shared device. On their phone, a mentor signs in and selects **Generate kiosk activation QR**. The kiosk accepts the code once within two minutes and records the mentor and server start time. Activation creates a scoped kiosk session and clears any human session in that browser. The mentor phone stays signed in. Scan a new mentor QR into the same scanner to reopen the shop.

Students sign in with their Workspace accounts to display their six-digit attendance code as a Code 128 barcode. Puncher accepts an approved student account link or an active CSV roster email matching the verified Google email. The first verified CSV login is tied to the Google subject. A replacement Google account using the same email requires review. Scanning the phone barcode uses the same attendance record as the printed card. Tap the barcode to copy its ID.

The server expires kiosk authorization at Chicago midnight or after 12 hours, whichever comes first. Unfinished shop visits forfeit at midnight and earn zero hours. The renewal cookie can remain for 30 days, but cannot authorize scans after expiry without a new mentor login/launch. Same-day renewal rotates the secret and retains the operation namespace for safe scan retries. The next day uses a new kiosk session. Sessions can be ended from the kiosk or revoked from mentor tools; mentor administrators can revoke any session. Disabling the launching mentor also invalidates their kiosks immediately. Old manually provisioned devices are rejected until a mentor relaunches the kiosk.

If browser/session storage is lost or a pending scan belongs to a different kiosk session, scanning stays locked for mentor review. Check canonical attendance before using Clear reviewed scan. Do not resolve uncertainty by scanning the same card again with a new operation. Use a dedicated, secured kiosk browser profile; leaving kiosk mode does not grant mentor API permissions, though the browser's Google account itself may remain signed into Google.
