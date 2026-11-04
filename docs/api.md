# API AND OPERATIONS

All browser writes send JSON and the exact configured Origin. Human routes use a seven-day, server-side DynamoDB session referenced by a Secure, HttpOnly, SameSite=Lax cookie; the raw session value is never stored in DynamoDB. Google authorization-code flow uses state, nonce and PKCE. The callback validates Google's signed ID token before creating the session. Kiosk routes use a separate mentor-launched HttpOnly session cookie. Launching the kiosk revokes and clears the current human session. Students cannot sign into Puncher. No ordinary human password exists. Lambda authorizers have zero cache TTL; handlers recheck enabled identities, roles, membership and event ownership. Student role alone grants no operational API access.

| Method | Path | Authorization / behavior |
| --- | --- | --- |
| GET | /api/health | Public schema availability, no student data |
| GET | /api/auth/login | Starts Google OIDC authorization-code flow |
| GET | /api/auth/callback | Validates one-time OAuth state/code, creates session and redirects |
| POST | /api/auth/logout | Origin-checked session revocation and cookie clearing |
| GET | /api/me | Verified mapped human; role/setup DTO |
| POST | /api/mentor/kiosk/launch | Mentor; creates/renews scoped HttpOnly kiosk session, no secret in JSON |
| GET | /api/mentor/kiosks | Mentor's sessions; administrator sees all |
| DELETE | /api/mentor/kiosks/{sessionId} | Launching mentor or administrator; immediate revocation |
| POST | /api/kiosk/end | Exact Origin and JSON; ends current session and clears cookie |
| GET / POST | /api/mentor/members | Mentor; safe roster / create with automatic code and optional client-generated memberId UUID for retries |
| PATCH | /api/mentor/members/{memberId} | Mentor; edit attendance member without changing native ID |
| POST | /api/mentor/members/{memberId}/replace-card | Mentor; operationId UUID makes replacement idempotent |
| POST | /api/mentor/roster/sync | Mentor; 202 durable background job; requires configured connection |
| GET | /api/mentor/roster/status | Mentor; job status/counts |
| GET | /api/mentor/roster/pending | Mentor; unresolved directory candidates |
| POST | /api/mentor/roster/link | Mentor; explicit existing member or confirmed new member |
| GET | /api/admin/mentor-requests | Administrator; verified Google login requests |
| POST | /api/admin/mentor-requests/{subject}/approve | Administrator; grants mentor plus explicitly selected extra permissions |
| GET | /api/kiosk/status | Kiosk session availability |
| GET | /api/kiosk/totals | Device; anonymous team shop-hour totals only (week/year/all time) |
| GET | /api/kiosk/occupants | Device; current display names only for the kiosk splash display |
| POST | /api/kiosk/scan | Device; `{barcode: "000123", operationId: "UUID"}` |
| GET | /api/kiosk/operations/{operationId} | Original device only; saved result |
| POST | /api/kiosk/operations/{operationId} | Original device; `{warningId}` after visible delivery |
| GET / POST | /api/events | Mentor's events; admin all events / create event |
| PATCH | /api/events/{eventId} | Owner/admin; title/date/hours lock after participation |
| GET | /api/events/{eventId}/participants | Owner/admin roster |
| POST | /api/events/{eventId}/scan | Owner/admin; `{barcode}` adds one server-derived award |
| DELETE | /api/events/{eventId}/participants/{memberId} | Owner/admin; required `{reason}`; voids prior award |
| GET / POST | /api/admin/members | Admin; roster / create explicit member/card |
| PATCH | /api/admin/members/{memberId} | Admin; replace card or deactivate without changing history ID |
| GET / POST | /api/admin/identities | Admin; exact subject/email/member/permissions mapping |
| GET | /api/admin/devices | Legacy administrator session list; POST provisioning is retired |
| DELETE | /api/admin/devices/{deviceId} | Admin; immediate revocation |
| GET | /api/admin/active | Admin; active roster excludes logically expired visits |
| GET | /api/admin/audit | Admin; recent scans/changes/rejected scans, paginated |
| GET / POST | /api/admin/review | Admin; paginated imported rows / explicit reviewed disposition with reason |

Lists for members/events are paginated internally by the server at this team size; audit/review expose an opaque cursor. GET audit defaults to newest first. The frontend gets one bounded operation list rather than per-row browser requests. Event creation/edit uses `{title,eventDate,hours,notes?}`. Member mutation uses `{displayName,memberKind,active,barcode?}`; an omitted/blank card preserves an existing code or assigns a new one. Mentor UI always assigns codes automatically; use the idempotent replacement endpoint for a lost card. Identity mutation uses `{googleSub,email,enabled,roles,memberId?}`. Separate CLI mapping format is documented in migration.md.

Kiosk replies distinguish in/out/cooldown and contain only display name, confirmation times, exact credited seconds/today total when applicable and pending missed-checkout warning. The browser never derives attendance state from a beep or guesses checkout time. A lost response reuses the same UUID and payload; a replay bound to another card is 409. Saved response retention is 24 hours with permanent replay tombstones; expired replay is 409 and needs adult reconciliation. No silent toggle retry with a fresh UUID and no offline queue. SCAN_COOLDOWN_SECONDS is configurable (1–60, default 5) on the API environment; cooldown also runs on the server and is per member. Each date transition bypasses the prior date's cooldown.

400 means invalid data; 401 means missing/invalid/expired auth; 403 means role/origin/disabled/setup restriction; 404 means unknown mapping/resource; 409 means conflicting state/replay/review; 429 means rate limit; 500/503 means unavailable/unconfirmed. Rejected authenticated scans are audited without card payloads. Gateway throttling plus DynamoDB per-caller rate records apply across Lambda instances. Credential and token values are never logged.

No route restores forfeited shop time, assigns roles based on a scanned card, enrolls an unknown card, accepts unchecked volunteer hours on scan, or writes Stats summaries. Imported credit review is limited to LEGACYSHOP#/legacy VOLUNTEER# with import provenance and rejects missing date/duration or negative approval.

The kiosk's three totals are a narrow aggregate display requested by the owner. They contain no member IDs, names, cards, rosters or individual totals. A separate ShopTotals Lambda can query canonical shop records and write only its internal cache/lease and rate-limit records; the shop-scan Lambda's IAM permissions stay unchanged. Weeks run Monday–Sunday in America/Chicago. “This year” uses June 2–June 1, matching the shared reader contract. Completed shop sessions and approved, valid dated legacy shop credits count, including inactive members' history. Volunteer credits, open/forfeited sessions, unapproved/invalid/negative credits and rollups do not count.

The owner also requested a name display for everyone currently clocked in. `/api/kiosk/occupants` is a separate, device-authorized minimal DTO: `occupants: [{displayName}]`, `asOf` and `validUntil`. It never returns member IDs, cards, emails, roles, session times or history. It queries the paginated ACTIVE partition and checks each exact CURRENT pointer, active session status, cutoff and member state with authoritative reads. Stale discovery items, checked-out/disabled members and expired visits are excluded before cleanup. No extra IAM or full-roster route is granted to the kiosk.

The name grid refreshes after saved scans, on focus, and every ten seconds. Its response is valid for at most fifteen seconds and never past the earliest session cutoff. The browser uses a conservative monotonic timer to hide expired names, and clears the grid on connection failure rather than displaying a stale roster or claiming the shop is empty. Other kiosks' changes are visible on the next poll. This is a current-presence display, not a historical report or an atomic attendance snapshot.

Puncher owns SUMMARY#SHOP / TOTALS and REFRESH. The cache is rebuilt from source records, never incremented as extra credit; refresh is idempotent and uses a conditional 30-second database lease across workers. Per-member queries and roster discovery are fully paginated, with four members processed concurrently. The browser refreshes once a minute; cached values last 60 seconds, or at most 120 seconds while another worker refreshes. Year/week boundaries force a new period. This is an eventually consistent operational display, not an atomic reporting snapshot. Refresh errors show unavailable values, never fabricated zeros. Recover a failed refresh by retrying after the lease expires. Stats must ignore SUMMARY# records and continue to calculate its own authorized reports from canonical records.
