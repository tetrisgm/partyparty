// ppcapture - captures macOS system audio via a Core Audio process tap and
// writes raw interleaved Float32 PCM to stdout; PartyParty pipes it into
// FFmpeg. macOS 26+ only - no ScreenCaptureKit, no screen-recording TCC.
//
// The "System Audio Recording" permission prompts INLINE (a one-click Allow
// dialog, like microphone) on first use and survives app updates - no
// System Settings visit, ever.
//
// The tap's stream format follows the current OUTPUT device (44.1k or 48k),
// so the helper reports it on stderr before audio flows:
//     ppcapture: FORMAT <rate> <channels>
// and the parent builds ffmpeg's input args from that line.

import Foundation
import CoreAudio
import AVFoundation

let errOut = FileHandle.standardError
func elog(_ s: String) { errOut.write((s + "\n").data(using: .utf8)!) }

let outHandle = FileHandle.standardOutput
func writeOut(_ data: Data) {
    do { try outHandle.write(contentsOf: data) } catch { exit(0) } // pipe closed -> done
}

/// Ring buffer between the HAL's realtime IO thread and a blocking writer
/// thread. The IO thread must NEVER block (a blocked HAL glitches ALL system
/// audio) - on overflow we drop and count instead.
final class PCMRing {
    private var buf: [Float32]
    private var head = 0, tail = 0, used = 0
    private let cap: Int
    private let cond = NSCondition()
    private var dropped = 0

    init(capacitySamples: Int) {
        cap = max(capacitySamples, 4096)
        buf = [Float32](repeating: 0, count: cap)
    }

    private(set) var totalPushed = 0 // monotonic frame counter for the stall monitor

    func pushedCount() -> Int { cond.lock(); defer { cond.unlock() }; return totalPushed }

    func push(_ p: UnsafePointer<Float32>, _ n: Int) {
        cond.lock()
        totalPushed &+= n
        if used + n > cap {
            dropped += n // never block the HAL thread
            if dropped % (48000 * 2) < n { elog("ppcapture: output backpressure - dropped ~\(dropped / 96000)s so far") }
            cond.unlock()
            return
        }
        for i in 0..<n {
            buf[(tail + i) % cap] = p[i]
        }
        tail = (tail + n) % cap
        used += n
        cond.signal()
        cond.unlock()
    }

    func writerLoop(onChunk: (([Float32]) -> Void)? = nil) {
        var out = [Float32](repeating: 0, count: 16384)
        while true {
            cond.lock()
            while used == 0 { cond.wait() }
            let n = min(used, out.count)
            for i in 0..<n {
                out[i] = buf[(head + i) % cap]
            }
            head = (head + n) % cap
            used -= n
            cond.unlock()
            out.withUnsafeBytes { writeOut(Data(bytes: $0.baseAddress!, count: n * 4)) }
            if let onChunk {
                onChunk(Array(out.prefix(n)))
            }
        }
    }
}

func fail(_ msg: String, code: Int32) -> Never {
    elog("ppcapture: " + msg)
    exit(code)
}

// 1. Global stereo mixdown of all system audio (excluding no processes). The
//    one-click "record system audio" permission prompt fires here on first use.
let desc = CATapDescription(stereoGlobalTapButExcludeProcesses: [])
desc.uuid = UUID()
desc.isPrivate = true
var tapID = AudioObjectID(kAudioObjectUnknown)
var err = AudioHardwareCreateProcessTap(desc, &tapID)
guard err == noErr, tapID != kAudioObjectUnknown else {
    fail("system-audio tap failed (err \(err)) - if a permission prompt appeared, click Allow and start again", code: 3)
}

// 2. The tap's format follows the current output device.
var fmtAddr = AudioObjectPropertyAddress(
    mSelector: kAudioTapPropertyFormat,
    mScope: kAudioObjectPropertyScopeGlobal,
    mElement: kAudioObjectPropertyElementMain)
var asbd = AudioStreamBasicDescription()
var fmtSize = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
err = AudioObjectGetPropertyData(tapID, &fmtAddr, 0, nil, &fmtSize, &asbd)
guard err == noErr, asbd.mSampleRate > 0 else {
    fail("tap format query failed (err \(err))", code: 4)
}
let rate = Int(asbd.mSampleRate)
let ch = min(Int(asbd.mChannelsPerFrame), 2)

// 3. Wrap the tap in a private aggregate device and read it with an IOProc.
let aggDict: [String: Any] = [
    kAudioAggregateDeviceNameKey as String: "PartyParty tap",
    kAudioAggregateDeviceUIDKey as String: "party.partyparty.tap." + desc.uuid.uuidString,
    kAudioAggregateDeviceIsPrivateKey as String: true,
    kAudioAggregateDeviceTapAutoStartKey as String: true,
    kAudioAggregateDeviceTapListKey as String: [
        [kAudioSubTapUIDKey as String: desc.uuid.uuidString,
         kAudioSubTapDriftCompensationKey as String: true],
    ],
]
var aggID = AudioObjectID(kAudioObjectUnknown)
err = AudioHardwareCreateAggregateDevice(aggDict as CFDictionary, &aggID)
guard err == noErr, aggID != kAudioObjectUnknown else {
    fail("aggregate device failed (err \(err))", code: 4)
}

// ~0.5s ring. It only needs to absorb producer/consumer scheduling jitter (HAL
// IOProc -> blocking writer), which is tens of ms - the tee legs now
// drop-on-overflow so a downstream stall no longer back-pressures the writer. A
// deep (was 8s) ring turned a transient stall into seconds of ACCUMULATING
// latency before it finally dropped (the ratchet); a shallow ring makes a stall
// cost a short bounded gap + instant resync instead. Drop path already exists in
// PCMRing.push().
let ring = PCMRing(capacitySamples: rate * ch / 2)

// The device clock is the only clock. Every IO cycle yields samples: the tap's
// real data when something is rendering, zeros when the Mac is quiet. Silence
// is ordinary audio - downstream never distinguishes a quiet Mac from a
// playing one, the channel is live from the first cycle, and nothing else may
// ever synthesize audio. (A wall-clock keepalive shipped 2026-08-04 and raced
// late HAL callbacks: any callback later than 120ms got zeros spliced into
// PLAYING audio - simultaneous dropouts for every listener at a venue that
// same day. The realMeter below is how a truly wedged tap still gets caught:
// zeros advance the ring but never the meter.)
final class RealMeter {
    private let lock = NSLock()
    private var real = 0
    private var cycles = 0
    private var empty = 0
    func count(realSamples: Int) {
        lock.lock()
        cycles += 1
        if realSamples > 0 { real += realSamples } else { empty += 1 }
        lock.unlock()
    }
    func realCount() -> Int { lock.lock(); defer { lock.unlock() }; return real }
    func report() -> (cycles: Int, real: Int, empty: Int) {
        lock.lock()
        defer { lock.unlock() }
        return (cycles, real, empty)
    }
}
let realMeter = RealMeter()
// Zeros are cut to the cycle's exact device-clock length (mSampleTime delta),
// never a guessed buffer size: a fixed guess that ran long would inflate the
// stream clock a few frames per cycle and turn a long quiet stretch into
// minutes of accumulated delay. maxFill bounds a resumed/jumped clock.
let maxFillFrames = 4096
let zeroChunk = [Float32](repeating: 0, count: 9600 * ch) // 0.2s at 48k, shared by both fillers
var lastSampleTime: Float64 = -1 // HAL IO thread only; no lock needed
// Set by the wall-clock filler while it is filling; the next REAL frames get a
// 5ms fade-in so the silence->music splice never clicks. Benign race: a missed
// fade is a click at worst, never corruption.
var fadePending = false
var procID: AudioDeviceIOProcID?
err = AudioDeviceCreateIOProcIDWithBlock(&procID, aggID, nil) { inNow, inInputData, _, _, _ in
    let nowST = inNow.pointee.mSampleTime
    let elapsed = lastSampleTime < 0 ? 0 : Int(nowST - lastSampleTime)
    lastSampleTime = nowST
    let abl = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: inInputData))
    var realSamples = 0
    if abl.count >= 2, abl[0].mNumberChannels == 1 {
        // planar L/R -> interleave
        let lBuf = abl[0], rBuf = abl[1]
        let frames = Int(lBuf.mDataByteSize) / MemoryLayout<Float32>.size
        if frames > 0, let lp = lBuf.mData, let rp = rBuf.mData {
            let l = lp.assumingMemoryBound(to: Float32.self)
            let r = rp.assumingMemoryBound(to: Float32.self)
            var inter = [Float32](repeating: 0, count: frames * 2)
            for i in 0..<frames {
                inter[2 * i] = l[i]
                inter[2 * i + 1] = r[i]
            }
            if fadePending {
                fadePending = false
                let rampFrames = min(240, frames) // 5ms at 48k
                for i in 0..<rampFrames {
                    let g = Float32(i) / Float32(rampFrames)
                    inter[2 * i] *= g
                    inter[2 * i + 1] *= g
                }
            }
            inter.withUnsafeBufferPointer { ring.push($0.baseAddress!, frames * 2) }
            realSamples = frames * 2
        }
    } else if let first = abl.first, let p = first.mData {
        let n = Int(first.mDataByteSize) / MemoryLayout<Float32>.size
        if n > 0 {
            ring.push(p.assumingMemoryBound(to: Float32.self), n)
            realSamples = n
        }
    }
    if realSamples == 0, elapsed > 0, elapsed <= maxFillFrames {
        zeroChunk.withUnsafeBufferPointer { ring.push($0.baseAddress!, elapsed * ch) }
    }
    realMeter.count(realSamples: realSamples)
}
guard err == noErr, let pid = procID else {
    fail("IOProc failed (err \(err))", code: 4)
}
guard AudioDeviceStart(aggID, pid) == noErr else {
    fail("device start failed", code: 4)
}

signal(SIGPIPE, SIG_IGN)
signal(SIGINT) { _ in exit(0) }
signal(SIGTERM) { _ in exit(0) }

elog("ppcapture: FORMAT \(rate) \(ch)")
elog("ppcapture: capturing system audio via Core Audio tap (\(rate) Hz, \(ch) ch, f32le)")
Thread.detachNewThread {
    ring.writerLoop()
}

// One-time clock report. Empirical fact this design rests on (measured
// 2026-08-05, cycles=0 over 10 silent seconds): when the Mac is silent the
// aggregate's IO cycle stops COMPLETELY - no callbacks, no device clock - so
// dead air cannot be device-clocked and the wall-clock filler below is not
// optional. This line re-proves it on every launch.
Thread.detachNewThread {
    Thread.sleep(forTimeInterval: 10)
    let r = realMeter.report()
    elog("ppcapture: clock report 10s cycles=\(r.cycles) realSamples=\(r.real) emptyCycles=\(r.empty)")
}

// Wall-clock silence filler - the last resort, provably incapable of touching
// playing audio. The 2026-08-04 version fired 120ms after the last frame,
// which is INSIDE normal HAL callback jitter: any late callback got zeros
// spliced into playing music, and every listener heard the same hole at the
// same moment (the Shack15 cutoffs). The gate now is quietAfter=1.5s -
// strictly beyond what the 0.5s ring plus the 0.9s player hold-back can
// absorb - so by the time it fires, listeners were starving no matter what:
// it can only ever fill air that was already dead. It stands down the instant
// real frames flow, never advances the real-frames meter (a wedged tap still
// looks wedged to the health monitor), and arms the 5ms fade-in so music
// returning after dead air never clicks.
Thread.detachNewThread {
    let tick = 0.1
    let quietAfter = 1.5
    var lastReal = realMeter.realCount()
    var lastRealAt = Date()
    var filledTo = Date()
    var filling = false
    while true {
        Thread.sleep(forTimeInterval: tick)
        let now = Date()
        let real = realMeter.realCount()
        if real != lastReal {
            lastReal = real
            lastRealAt = now
            filling = false
            continue
        }
        if now.timeIntervalSince(lastRealAt) < quietAfter { continue }
        if !filling {
            filling = true
            filledTo = now
            fadePending = true
        }
        // Fill wall-clock owed in bounded steps; the clamp keeps a stretched
        // sleep from bursting a backlog of zeros into a 0.5s ring.
        if filledTo < now.addingTimeInterval(-0.4) { filledTo = now.addingTimeInterval(-0.4) }
        let oweFrames = Int(now.timeIntervalSince(filledTo) * Double(rate))
        let frames = min(oweFrames, zeroChunk.count / ch)
        if frames <= 0 { continue }
        zeroChunk.withUnsafeBufferPointer { ring.push($0.baseAddress!, frames * ch) }
        filledTo = filledTo.addingTimeInterval(Double(frames) / Double(rate))
    }
}

// Capture-health monitor. A quiet Mac produces empty cycles (zeros in the
// ring, nothing on the real-frames meter), so absence of REAL frames alone is
// not a failure signal. Exclusive/HOG ownership is authoritative: surface it,
// then rebuild once the owner releases the device. Default-device changes are
// handled separately.
func defaultOutputDevice() -> AudioObjectID {
    var dev = AudioObjectID(0)
    var addr = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyDefaultOutputDevice,
        mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var size = UInt32(MemoryLayout<AudioObjectID>.size)
    AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &dev)
    return dev
}
func hogOwner(_ dev: AudioObjectID) -> pid_t {
    var owner = pid_t(-1)
    var addr = AudioObjectPropertyAddress(
        mSelector: kAudioDevicePropertyHogMode,
        mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var size = UInt32(MemoryLayout<pid_t>.size)
    AudioObjectGetPropertyData(dev, &addr, 0, nil, &size, &owner)
    return owner
}
Thread.detachNewThread {
    let me = getpid()
    var last = realMeter.realCount()
    var quietFor = 0
    var flagged = false
    var wasHogged = false
    while true {
        Thread.sleep(forTimeInterval: 2)
        let now = realMeter.realCount()
        let advancing = now != last
        last = now
        if advancing {
            if flagged { elog("ppcapture: CAPTURE-OK"); flagged = false; wasHogged = false }
            quietFor = 0
            continue
        }
        quietFor += 2
        let owner = hogOwner(defaultOutputDevice())
        let hoggedNow = owner > 0 && owner != me
        if quietFor >= 4 && hoggedNow && !flagged {
            flagged = true
            wasHogged = true
            elog("ppcapture: CAPTURE-BLOCKED exclusive-mode pid=\(owner)")
        } else if flagged && wasHogged && !hoggedNow {
            // The exclusive app released the device but our tap is still wedged
            // (frames never resumed) - the aggregate device needs a clean
            // rebuild. Signal the parent to restart capture.
            wasHogged = false
            elog("ppcapture: CAPTURE-UNHOGGED")
        }
    }
}

// Default-output-device change (AirPods connect to the Mac and macOS makes
// them the current output, the DJ switches speakers↔interface, a display with
// speakers is plugged in, …). The global tap's aggregate device is bound to
// the OLD device's clock/format and stops delivering frames - guests get stuck
// buffering with no recovery. The tap must be rebuilt against the new device
// (which also re-reads its sample rate), so signal the parent to restart
// capture. Debounced + throttled parent-side so a settling AirPods handshake
// can't thrash the room.
var devChangeAddr = AudioObjectPropertyAddress(
    mSelector: kAudioHardwarePropertyDefaultOutputDevice,
    mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
var lastDevSignal = Date.distantPast
AudioObjectAddPropertyListenerBlock(AudioObjectID(kAudioObjectSystemObject), &devChangeAddr, DispatchQueue.main) { _, _ in
    // Settle briefly (a device switch fires several property changes), then
    // signal once. The 2s local debounce plus the parent's 15s throttle keep
    // a flapping connection from restarting repeatedly.
    let now = Date()
    if now.timeIntervalSince(lastDevSignal) < 2 { return }
    lastDevSignal = now
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) {
        elog("ppcapture: CAPTURE-DEVICECHANGE")
    }
}
dispatchMain()
