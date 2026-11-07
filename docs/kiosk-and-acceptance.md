# KIOSK SETUP AND PHYSICAL ACCEPTANCE

Connect the purchased NetumScan NSA5 as a USB keyboard scanner. Using its manufacturer's programming guide, select hands-free/continuous reading and an Enter/CR terminator. Disable repeated automatic reading of a stationary card if the scanner supports a sensible release/rearm setting. Do not guess programming barcodes. Test an actual student card in a temporary plain text field: exactly six digits, including leading zeros, followed by one Enter. Clear the test field afterward. CR, LF and CRLF are accepted once by the kiosk's scan buffer. Card symbology must be confirmed with the actual printed cards.

On the scanner device, select **Start kiosk**. On a separate phone, sign in as a mentor and select **GENERATE KIOSK**. Scan the QR on the waiting kiosk. The kiosk records the activating mentor and start time and opens the attendance screen. A member can sign in on their phone and scan their attendance barcode, or use their printed card. Check both phone QR and Code 128 scans on the actual kiosk scanner before rollout.

The page restores scanner focus when the browser regains focus. A web page cannot recover OS foreground focus after another application takes it. An adult must return to the kiosk window; the visible focus warning explains this. Check the scanner on startup and after OS dialogs, lock screens, updates and USB reconnection. No per-student button press, password, Google sign-in or confirmation scan is needed. The scanner decode beep only means the scanner read a barcode; Puncher's saved confirmation means the server committed it. When the last mentor or admin clocks out and closes the shop, the kiosk plays `Semisonic_-_Closing_Time.mid`; keep kiosk audio enabled.

For manual local testing, type all six digits (including leading zeros), then press Enter. Normal pauses are allowed; an abandoned partial entry expires after ten seconds without a key. Backspace corrects a character, Ctrl/Cmd+A replaces the whole buffered entry, and Escape or Delete clears it. Masked dots show entry progress without exposing the card number. Empty CR/LF terminators are ignored and malformed entries never reach the attendance API. Rapid repeats still use the same per-card cooldown, so a second immediate scan cannot reverse a saved clock-in. Physical scans remain one-card/one-Enter; there is no new per-student confirmation step.

New writes need internet. A timed-out operation persists its UUID and payload in sessionStorage only until the server confirms the original operation. It automatically retries the same operation and survives a page reload; this is an uncertainty recovery record, not an offline queue or source of timestamps. New scans are held while that request is unresolved. Do not tell students to toggle again to resolve uncertainty. If the durable operation response window expires after 24 hours, involve an administrator to inspect operational history. Never generate a new toggle as an automatic recovery. Secure unattended browser profiles and clear abandoned pending data only after an adult reconciles its saved operation.

At midnight an unfinished visit is forfeited with zero credit; earlier completed visits remain. On the next scan a new visit starts and a persistent warning appears. It is acknowledged server-side only after being displayed in a visible page for 1.5 seconds; interrupted delivery is repeated on a later scan. Confirmation clears after five seconds, or twelve seconds for a missed-checkout warning. No hours recovery feature exists.

Before production, manually verify and record these on actual hardware (not completed by automated tests):

- NSA5 normal/worn cards, leading zeros, hands-free trigger, repeated stationary reads and rapid different students.
- Dedicated computer startup/kiosk, sleep settings, lost focus, USB reconnect, network disconnect during save and reconnect/reload.
- iPhone Safari and Android Chrome mentor sign-in, event creation and adding participants by name.
- A real local-midnight scenario (plus DST calendar tests): unfinished visit expires, completed earlier time remains, next scan starts a new visit with warning, delayed cleanup cannot clear it.
- Production Google/OIDC audience/origin setup, direct API auth denial, kiosk revocation, SNS alarm delivery, cleanup failure queue and separately deployed Stats read-only integration.

Automated Chromium desktop and narrow mobile viewport checks do not establish Safari, Android Chrome, scanner or operating-system acceptance.
