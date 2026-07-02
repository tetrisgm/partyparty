// ppcapture — captures macOS system audio via a Core Audio process tap and
// writes raw interleaved Float32 PCM to stdout; partyparty pipes it into
// FFmpeg. macOS 26+ only — no ScreenCaptureKit, no screen-recording TCC.
//
// The "System Audio Recording" permission prompts INLINE (a one-click Allow
// dialog, like microphone) on first use and survives app updates — no
// System Settings visit, ever.
//
// The tap's stream format follows the current OUTPUT device (44.1k or 48k),
// so the helper reports it on stderr before audio flows:
//     ppcapture: FORMAT <rate> <channels>
// and the parent builds ffmpeg's input args from that line.

import Foundation
import CoreAudio

let errOut = FileHandle.standardError
func elog(_ s: String) { errOut.write((s + "\n").data(using: .utf8)!) }

let outHandle = FileHandle.standardOutput
func writeOut(_ data: Data) {
    do { try outHandle.write(contentsOf: data) } catch { exit(0) } // pipe closed -> done
}

/// Ring buffer between the HAL's realtime IO thread and a blocking writer
/// thread. The IO thread must NEVER block (a blocked HAL glitches ALL system
/// audio) — on overflow we drop and count instead.
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
            if dropped % (48000 * 2) < n { elog("ppcapture: output backpressure — dropped ~\(dropped / 96000)s so far") }
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

    func writerLoop() {
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
    fail("system-audio tap failed (err \(err)) — if a permission prompt appeared, click Allow and start again", code: 3)
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
    kAudioAggregateDeviceNameKey as String: "partyparty tap",
    kAudioAggregateDeviceUIDKey as String: "net.ramine.partyparty.tap." + desc.uuid.uuidString,
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

let ring = PCMRing(capacitySamples: rate * ch * 8) // ~8s of headroom
var procID: AudioDeviceIOProcID?
err = AudioDeviceCreateIOProcIDWithBlock(&procID, aggID, nil) { _, inInputData, _, _, _ in
    let abl = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: inInputData))
    if abl.count >= 2, abl[0].mNumberChannels == 1 {
        // planar L/R -> interleave
        let lBuf = abl[0], rBuf = abl[1]
        let frames = Int(lBuf.mDataByteSize) / MemoryLayout<Float32>.size
        guard frames > 0, let lp = lBuf.mData, let rp = rBuf.mData else { return }
        let l = lp.assumingMemoryBound(to: Float32.self)
        let r = rp.assumingMemoryBound(to: Float32.self)
        var inter = [Float32](repeating: 0, count: frames * 2)
        for i in 0..<frames {
            inter[2 * i] = l[i]
            inter[2 * i + 1] = r[i]
        }
        inter.withUnsafeBufferPointer { ring.push($0.baseAddress!, frames * 2) }
    } else if let first = abl.first, let p = first.mData {
        let n = Int(first.mDataByteSize) / MemoryLayout<Float32>.size
        guard n > 0 else { return }
        ring.push(p.assumingMemoryBound(to: Float32.self), n)
    }
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
Thread.detachNewThread { ring.writerLoop() }

// Capture-health monitor. The global tap goes SILENT (no IOProc frames) when
// another app takes EXCLUSIVE/HOG mode of the output device — Roon, Audirvana,
// etc. in "Exclusive Mode" bypass the system mixer entirely, so there's nothing
// to tap. The Mac side otherwise can't tell (ffmpeg keeps running on an empty
// pipe), so we detect the frame stall here, attribute it to hog mode when we
// can, and print machine-readable markers the parent surfaces to the DJ.
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
    var last = ring.pushedCount()
    var stalledFor = 0
    var flagged = false
    while true {
        Thread.sleep(forTimeInterval: 2)
        let now = ring.pushedCount()
        let advancing = now != last
        last = now
        if advancing {
            if flagged { elog("ppcapture: CAPTURE-OK"); flagged = false }
            stalledFor = 0
            continue
        }
        stalledFor += 2
        if stalledFor >= 4 && !flagged {
            flagged = true
            let owner = hogOwner(defaultOutputDevice())
            if owner > 0 && owner != me {
                elog("ppcapture: CAPTURE-BLOCKED exclusive-mode pid=\(owner)")
            } else {
                elog("ppcapture: CAPTURE-STALLED no-frames")
            }
        }
    }
}
dispatchMain()
