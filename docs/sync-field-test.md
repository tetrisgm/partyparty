# Sync-approach field test

The one thing that can't be tested at the keyboard: which sync scheme actually
behaves on the **real phones**. The v53.61 "Sync approach" radio (DJ Settings)
lets you A/B all of them in one party. This is the protocol that makes that one
party yield clean, comparable data.

## What we're trying to learn (in priority order)

1. **Does any approach leave a phone silent?** (the iOS-27 "never synced" bug).
   This is the #1 disqualifier — an approach that silences a phone is out.
2. **Any gross device-to-device gaps?** (the iOS-26 "seconds apart" bug).
3. **Tightest spread / lowest livable latency** among the approaches that pass 1 & 2.

## Setup (do this once)

- All test phones + the DJ Mac on the **same Wi-Fi**.
- **Built-in speaker on every phone. No Bluetooth, no AirPods.** Bluetooth adds
  150–300 ms of output latency that no sync scheme removes and that the logs
  can't see — it will confound every reading.
- The **iOS-27 phone is the key subject** — it's the one that went silent before.
  Make sure it's in the room for every approach.
- DJ Mac on **53.61** (it is). Start a broadcast, grab the guest link, open it on
  every phone, let them all reach "live" once on the default before you start.

## The run

Open **Settings → Sync approach** on the Mac. For each approach below, in order:

1. Click the approach.
2. **Wait ~10 s** — every phone drops and re-aligns onto the new scheme.
3. **Let it settle ~60–90 s.** Hold the phones together and listen.
4. Note, per phone: **playing or silent?** and **together or audibly apart?**
   (Watch the iOS-27 phone especially.)
5. Move to the next approach.

**Order** (baseline first and last, so drift in conditions is visible):

| # | Approach | Watch for |
|---|----------|-----------|
| 1 | **Balanced** | baseline — should match what shipped |
| 2 | **Seek to align** | ⚠ does the iOS-27 phone go **silent** again, at 3 s instead of 7 s? |
| 3 | **No pin** | do the phones drift apart without the pin? |
| 4 | **Deep buffer** | do gross gaps disappear with more cushion? |
| 5 | **Tight** | does anything break at 2 s? |
| 6 | **Balanced** | re-confirm the baseline is stable |

Don't rush the flips — give each approach a real dwell so the phones fully settle
before you judge it. A too-fast flip just measures the transition, not the scheme.

## Two measurement layers

- **Ears (immediate):** silent phone? gross echo/slapback between phones? This
  alone answers priority #1 and catches gross gaps.
- **Logs (the numbers):** every phone stamps the approach it ran (`mMode`) onto
  its telemetry. After the party, pull the DJ session log and run:

  ```
  node scripts/analyze-session-log.mjs <session-log>
  ```

  The **"Sync approaches (A/B)"** section ranks them best-behaved first and, per
  approach, reports: devices that **opened audio vs stayed silent**, startup
  **spread**, **latency** band, degraded opens, and max seeks. A `⚠ SILENT` /
  `FAIL` line means a phone polled but never opened audio under that approach —
  the disqualifier. (I pull and read this for you; just tell me when a test party
  has happened.)

- **Mic test (optional, the only acoustic ground truth):** for the best one or two
  approaches, `scripts/synctest/` measures true speaker-to-speaker spread. Browser
  telemetry only sees the media clock, not the actual sound.

## Per-device override (only if you want it)

The room approach applies to everyone, but a single phone can still be pinned to
a variant via its guest-link URL — `?seek=1`, `?d=<sec>`, `?pin=0`. Rarely needed
now that the radio drives the room; it's there if you want one phone held apart.
