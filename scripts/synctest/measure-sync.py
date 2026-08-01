#!/usr/bin/env python3
"""Measure device-to-device audio sync from a room recording of the click track.

The click track (make-clicktrack.sh) plays a sharp 1kHz impulse every 2s through
PartyParty to every device. One mic (record-room.sh) hears the SUPERPOSITION of
all devices' clicks per event; the temporal spread of that burst IS the
device-to-device spread - the one thing browser telemetry can never see (it
includes the speaker/DAC/Bluetooth output path).

  python3 scripts/synctest/measure-sync.py [room.wav]

numpy only. Reports per-click spread and a median/p95/max verdict against the
<250ms (great) / <500ms (ok) product bar.
"""
import sys, os, wave, struct
import numpy as np

CLICK_HZ = 1000.0
EXPECT_PERIOD = 2.0          # seconds between clicks in the track
INTRINSIC_MS = 12.0         # single-click burst width baked into the track
GREAT_MS, OK_MS = 250.0, 500.0

def load_wav(path):
    with wave.open(path, "rb") as w:
        sr, n, ch = w.getframerate(), w.getnframes(), w.getnchannels()
        raw = w.readframes(n)
    x = np.frombuffer(raw, dtype=np.int16).astype(np.float64)
    if ch > 1:
        x = x.reshape(-1, ch).mean(axis=1)
    return x / (np.abs(x).max() or 1.0), sr

def bandpass_env(x, sr):
    # FFT band-pass around the click frequency to reject room noise/voices, then
    # a rectified + smoothed envelope.
    X = np.fft.rfft(x)
    f = np.fft.rfftfreq(len(x), 1.0 / sr)
    X[(f < CLICK_HZ - 300) | (f > CLICK_HZ + 300)] = 0
    band = np.fft.irfft(X, len(x))
    env = np.abs(band)
    win = max(1, int(sr * 0.004))                     # ~4ms smoothing
    env = np.convolve(env, np.ones(win) / win, mode="same")
    return env / (env.max() or 1.0)

def find_events(env, sr):
    # Click events are ~EXPECT_PERIOD apart; take the strongest local maxima with
    # that minimum spacing.
    thr = max(0.15, np.percentile(env, 99.5) * 0.4)
    mind = int(sr * EXPECT_PERIOD * 0.6)
    peaks, i, N = [], 1, len(env) - 1
    while i < N:
        if env[i] > thr and env[i] >= env[i - 1] and env[i] >= env[i + 1]:
            if peaks and i - peaks[-1] < mind:
                if env[i] > env[peaks[-1]]:
                    peaks[-1] = i
            else:
                peaks.append(i)
        i += 1
    return peaks

def event_spread_ms(env, sr, center):
    # In a +/-500ms window around the event, find sub-peaks (each an arrival
    # cohort). The span from first to last sub-peak is the device spread.
    half = int(sr * 0.5)
    a, b = max(0, center - half), min(len(env), center + half)
    seg = env[a:b]
    if seg.size == 0:
        return None, 1
    thr = seg.max() * 0.4
    mind = int(sr * 0.02)                              # merge arrivals <20ms apart
    subs, i = [], 1
    while i < seg.size - 1:
        if seg[i] > thr and seg[i] >= seg[i - 1] and seg[i] >= seg[i + 1]:
            if subs and i - subs[-1] < mind:
                if seg[i] > seg[subs[-1]]:
                    subs[-1] = i
            else:
                subs.append(i)
        i += 1
    if not subs:
        return None, 0
    span_ms = (subs[-1] - subs[0]) / sr * 1000.0
    # subtract the intrinsic single-click width so a perfectly-synced room reads ~0
    return max(0.0, span_ms - (INTRINSIC_MS if len(subs) == 1 else 0.0)), len(subs)

def main():
    path = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), "room.wav")
    if not os.path.exists(path):
        sys.exit(f"no recording at {path} - run record-room.sh first")
    x, sr = load_wav(path)
    env = bandpass_env(x, sr)
    events = find_events(env, sr)
    print(f"recording: {len(x)/sr:.1f}s @ {sr}Hz, detected {len(events)} click events\n")
    spreads = []
    for k, c in enumerate(events):
        s, ncoh = event_spread_ms(env, sr, c)
        if s is None:
            continue
        spreads.append(s)
        flag = "  <-- LATE OUTLIER" if ncoh >= 2 and s > OK_MS else ("  (multi-cohort)" if ncoh >= 2 else "")
        print(f"  click {k+1:2d} @ {c/sr:6.2f}s   spread ~{s:6.1f} ms   cohorts={ncoh}{flag}")
    if not spreads:
        sys.exit("\ncould not measure any clicks - check mic placement / volume / that the track was playing.")
    a = np.array(spreads)
    med, p95, mx = np.median(a), np.percentile(a, 95), a.max()
    verdict = "GREAT (<250ms)" if p95 < GREAT_MS else ("OK (<500ms)" if p95 < OK_MS else "TOO WIDE (>500ms)")
    print(f"\n=== device-to-device spread: median {med:.0f} ms | p95 {p95:.0f} ms | max {mx:.0f} ms ===")
    print(f"=== VERDICT: {verdict} ===")
    print("note: Bluetooth output adds 150-300ms that NO sync scheme can remove - keep")
    print("      all test devices on built-in speaker for a clean media-clock reading.")

if __name__ == "__main__":
    main()
