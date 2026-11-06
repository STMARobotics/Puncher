# Member sign-in, roles and attendance cards

Sign in with a verified stmarobotics.org Google account. On first sign-in Puncher creates a Student account and assigns a six-digit attendance code. The same account and card are used on later sign-ins.

| Role | Access |
| --- | --- |
| Student | View their barcode, clock in and out, and appear in the Students kiosk column. |
| Mentor | View their barcode and the active member directory, appear in the Mentors kiosk column, create outreach and competition events, and generate kiosk activation QR codes. |
| Admin | Mentor capabilities plus member, role, card, and audit administration. Admins also appear in the Mentors column. |

When the last Mentor or Admin clocks out, the shop switches to checkout-only mode. A Mentor or Admin can reopen it with a kiosk activation QR.

In **Manage members**, an Admin selects **Edit member** and chooses one role. The person must sign in first to appear in the roster. A member must clock out before an Admin can change their role or active status. An Admin can also replace a card or export active member details for external ID-card printing.

## Event attendance

Choose **CREATE EVENT** and select **Outreach** or **Competition**. After saving, search for active students by name and select **Add** beside each participant. The event awards the specified hours to each participant. Earlier volunteer events appear as Outreach. Competition credit is recorded separately from the outreach hours sent to Stats.

## Kiosk launch and recovery

Select **Start kiosk** on the shared device. On their phone, a mentor signs in and selects **GENERATE KIOSK**. The kiosk accepts the code once within two minutes and records the mentor and server start time. Activation creates a scoped kiosk session and clears any human session in that browser. The mentor phone stays signed in. Scan a new mentor QR into the same scanner to reopen the shop.

Every signed-in member can display their six-digit attendance code as a Code 128 barcode. The phone and printed barcode identify the same attendance account. Tap the barcode to copy its code.

The server expires kiosk authorization at Chicago midnight or after 12 hours, whichever comes first. Unfinished shop visits forfeit at midnight and earn zero hours. The renewal cookie can remain for 30 days, but cannot authorize scans after expiry without a new mentor login/launch. Same-day renewal rotates the secret and retains the operation namespace for safe scan retries. The next day uses a new kiosk session. Sessions can be ended from the kiosk or revoked from mentor tools; mentor administrators can revoke any session. Disabling the launching mentor also invalidates their kiosks immediately. Old manually provisioned devices are rejected until a mentor relaunches the kiosk.

If browser/session storage is lost or a pending scan belongs to a different kiosk session, scanning stays locked for mentor review. Check canonical attendance before using Clear reviewed scan. Do not resolve uncertainty by scanning the same card again with a new operation. Use a dedicated, secured kiosk browser profile; leaving kiosk mode does not grant mentor API permissions, though the browser's Google account itself may remain signed into Google.
