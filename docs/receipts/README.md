# Playback soak receipts

`AGENTS.md` asks for the log, not a claim about where an AVPlayer sat. These
are those logs.

A receipt produced from 2026-09-11 onward is self-describing: `scripts/soak-playback.swift`
writes a `soak begin` header naming the URL, label, target, duration and build,
and a `soak end` trailer naming the verdict. It reports three numbers per
sample instead of one:

    latency = edge + attach
    edge    = now minus the wall-clock time of the newest media the playlist advertises
    attach  = how far back from that live edge the player chose to sit

`attach` is the quantity the room schedule controls, so the target assertion is
on `attach`. `edge` is transport staleness and is near zero on the Mac's own
path. A run whose `attach` is on target but whose `latency` is long is a
transport problem and needs the opposite fix from a run that misses on `attach`.

## The 2026-09-11 soak lab

`soak-lab-20260911/` is the run that settled the direct-versus-relay question.
Seven arms, ten minutes, all soaked CONCURRENTLY against one live stream on a
throwaway loopback stack, by `scripts/soak-lab.mjs`. Concurrency is the point:
arms run back to back see different minutes of the stream, and the quantity
under test is a difference between arms.

| arm | tier | pin | latency | edge | attach | AVPlayer mode |
| --- | --- | --- | --- | --- | --- | --- |
| direct | multivariant | present | 2.72s | 0.10s | **2.62s** | low-latency |
| proxy-keep | multivariant | present | 2.73s | 0.10s | **2.63s** | low-latency |
| proxy-strip | multivariant | **removed** | 2.73s | 0.09s | **2.63s** | low-latency |
| holdback-1.5 | multivariant | present | n/a | 0.09s | **never played** | ordinary-live |
| holdback-3.0 | multivariant | present | 3.24s | 0.09s | **3.15s** | low-latency |
| holdback-5.0 | multivariant | present | 5.30s | 0.09s | **5.21s** | low-latency |
| relay | media | absent by construction | 3.17s | 0.27s | **2.90s** | low-latency |

What it establishes:

1. **`EXT-X-START` in the multivariant playlist is inert.** Removing it changed
   attachment by 0.00s. `proxy-keep` reproduced the unproxied `direct` arm
   within 0.01s, so the lab proxy was transparent and the comparison is valid.
   That control is the thing `scripts/bench-playlist-proxy.py` never had.
2. **The three-second cushion is a coincidence.** The shipping media playlist
   declares `PART-HOLD-BACK` but no `HOLD-BACK`, so the room inherits the HLS
   default of three target durations. gohlslib rounds `TARGETDURATION` to an
   integer second, so 500ms segments make that default 3.0s. Nothing in the code
   asks for it, and it would move on its own if the segment duration changed.
3. **`HOLD-BACK` is a real lever, upward only.** Declared at 3.0 the player sat
   at 3.15s; at 5.0 it sat at 5.21s. Declared at 1.5, below the three-target-
   duration floor, AVPlayer refused the playlist outright and never played a
   sample. `HOLD-BACK` can lengthen the cushion; it cannot shorten it below that
   floor.
4. **The relay's own delay is small; its attachment is not the problem.** On
   loopback the relay added 0.27s of `edge` against the direct path's 0.10s. A
   venue adds wide-area delay on top of that and never reduces it.

`soak-lab-20260911-replication/` is an independent ten-minute run of the same
seven arms on a fresh stack, with the machine otherwise idle. Every conclusion
reproduces within 0.1s: pin effect +0.00s, `HOLD-BACK=3.0` to 3.21s attach,
`HOLD-BACK=5.0` to 5.28s, `HOLD-BACK=1.5` refused outright, relay `edge` 0.27s.
The first run overlapped some build and test load on this Mac; the replication
did not, and did not move.

What it does NOT establish. Every arm ran over plaintext HTTP/1.1, because
AVPlayer will not attach to the throwaway certificate a lab stack presents and
this Mac's own hostname no longer resolves to it. The 2026-08-11 direct run that
measured 1.17s was HTTPS, and Go enables HTTP/2 over TLS by default. AVPlayer
reported low-latency mode on every arm here, so the LL-HLS negotiation itself is
not the difference, but the 1.17s figure has not been reproduced and the
protocol remains the leading unexamined variable. **Nothing in this lab licenses
a geometry change.** That still needs the pre-upload soak on the real guest path
and the supervised set.

## Provenance of the receipts predating that change

None of these records the URL it measured, because the harness echoed the URL
to stderr while only stdout was teed to the log. Each prints a single summed
`latency`. What is written below is what the commits that produced them say,
and nothing more. **These logs cannot be compared to each other**, and the
2026-09-11 soak lab above exists because of that.

| File | Run | What is actually known |
| --- | --- | --- |
| `soak-20260806-build125.40-260-UNKNOWN-URL-3.11s.log` | 2026-08-06, build 125.40/260 | Ten minutes, flat 3.11s, PASS. This is the "re-proven at 3.11s flat" figure that `AGENTS.md` and `internal/schedule/schedule.go` cite as the receipt for the shipped geometry. **Its URL is unrecorded.** It lived only in the gitignored `build/` directory until 2026-09-11 and was one `make clean` from deletion. The `internal/schedule` comment cites it as `scratchpad soak-july-form.log`, a path that has never existed in this repository. |
| `soak-20260811-direct-FAIL-1.17s.log` | 2026-08-11 | Two minutes, flat 1.17s, FAIL. Commit `c1a0ad5` states this was the direct path on `:8443`, multivariant, pin served. |
| `soak-20260811-direct-FAIL-1.16s-second-reproduction.log` | 2026-08-11 | The second reproduction `c1a0ad5` refers to: "reproduced under forced relay and again in clean auto/direct". |
| `soak-20260811-relay-PASS-3.33s.log` | 2026-08-11 | Two minutes, flat 3.33s, PASS. Commit `c1a0ad5` states this was the relay origin's `stream.m3u8`. That is a MEDIA playlist, which `internal/schedule` never pins, so this arm carried no attachment pin at all and its agreement with the 3.00s target is coincidence, not evidence. |
| `soak-20260811-benchproxy-pin-*.log` | 2026-08-11 | Three runs through `scripts/bench-playlist-proxy.py`: 3.12s with the pin on the multivariant, 3.20s with it also on the media playlist, 3.16s with no pin at all. A 0.08s spread across three different pin placements means the proxy dominated the measurement. **These prove nothing about any manifest** and are kept only as evidence that the bench proxy is not a valid instrument. |

Two further facts about all five of the pre-2026-09-11 runs: every one is 24
samples ending at `t=120s`, while `AGENTS.md` and the harness itself ask for
ten minutes; and every one sampled position only every five seconds, so a
backward seek that recovered inside one window would not have been seen.
