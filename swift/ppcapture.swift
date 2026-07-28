// ppcapture - captures macOS system audio via a Core Audio process tap and
// writes raw interleaved Float32 PCM to stdout; partyparty pipes it into
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
import ShazamKit

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

/// ShazamKit receives a copy after PCM has already been written downstream.
/// Its serial queue is strictly bounded, so recognition can never hold up or
/// accumulate latency in the live audio path.
final class TrackRecognizer: NSObject, SHSessionDelegate {
    private let session = SHSession()
    private let format: AVAudioFormat
    private let channels: Int
    private let queue = DispatchQueue(label: "fm.partyparty.track-recognition", qos: .utility)
    private let state = NSLock()
    private var pending = 0
    private var lastID = ""
    private var lastErrorAt = Date.distantPast
    private var lastLoudAt = Date()
    private var silenceAnnounced = false

    init?(sampleRate: Int, channels: Int) {
        guard let format = AVAudioFormat(
            commonFormat: .pcmFormatFloat32,
            sampleRate: Double(sampleRate),
            channels: AVAudioChannelCount(channels),
            interleaved: false
        ) else { return nil }
        self.format = format
        self.channels = channels
        super.init()
        session.delegate = self
    }

    func enqueue(_ interleaved: [Float32]) {
        var energy: Float = 0
        for sample in interleaved {
            energy += sample * sample
        }
        let rms = interleaved.isEmpty ? 0 : sqrt(energy / Float(interleaved.count))
        state.lock()
        if rms >= 0.002 {
            lastLoudAt = Date()
            silenceAnnounced = false
        } else {
            state.unlock()
            announceSilenceIfNeeded()
            return
        }
        guard pending < 3 else {
            state.unlock()
            return
        }
        pending += 1
        state.unlock()
        queue.async { [self] in
            defer {
                state.lock()
                pending -= 1
                state.unlock()
            }
            let frames = interleaved.count / channels
            guard frames > 0,
                  let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(frames)),
                  let dst = buffer.floatChannelData else { return }
            buffer.frameLength = AVAudioFrameCount(frames)
            for frame in 0..<frames {
                for channel in 0..<channels {
                    dst[channel][frame] = interleaved[frame * channels + channel]
                }
            }
            session.matchStreamingBuffer(buffer, at: nil)
        }
    }

    func session(_ session: SHSession, didFind match: SHMatch) {
        guard let item = match.mediaItems.first,
              let title = item.title?.trimmingCharacters(in: .whitespacesAndNewlines),
              !title.isEmpty else { return }
        let artist = item.artist?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let matchID = item.shazamID ?? "\(artist)\u{0}\(title)"
        state.lock()
        guard Date().timeIntervalSince(lastLoudAt) < 6, matchID != lastID else {
            state.unlock()
            return
        }
        lastID = matchID
        state.unlock()
        var payload: [String: String] = ["id": matchID, "title": title, "artist": artist]
        if let artworkURL = item.artworkURL?.absoluteString {
            payload["artworkUrl"] = artworkURL
        }
        guard let data = try? JSONSerialization.data(withJSONObject: payload),
              !data.isEmpty else { return }
        elog("ppcapture: TRACK " + data.base64EncodedString())
    }

    func announceSilenceIfNeeded() {
        state.lock()
        let shouldAnnounce = !silenceAnnounced && Date().timeIntervalSince(lastLoudAt) >= 10
        if shouldAnnounce {
            silenceAnnounced = true
            lastID = ""
        }
        state.unlock()
        if shouldAnnounce {
            elog("ppcapture: TRACK-SILENT \(Int(Date().timeIntervalSince1970 * 1000))")
        }
    }

    func session(_ session: SHSession, didNotFindMatchFor signature: SHSignature, error: Error?) {
        guard let error else { return }
        state.lock()
        let shouldLog = Date().timeIntervalSince(lastErrorAt) >= 60
        if shouldLog { lastErrorAt = Date() }
        state.unlock()
        if shouldLog { elog("ppcapture: track recognition unavailable (\(error.localizedDescription))") }
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

// ~0.5s ring. It only needs to absorb producer/consumer scheduling jitter (HAL
// IOProc -> blocking writer), which is tens of ms - the tee legs now
// drop-on-overflow so a downstream stall no longer back-pressures the writer. A
// deep (was 8s) ring turned a transient stall into seconds of ACCUMULATING
// latency before it finally dropped (the ratchet); a shallow ring makes a stall
// cost a short bounded gap + instant resync instead. Drop path already exists in
// PCMRing.push().
let ring = PCMRing(capacitySamples: rate * ch / 2)
let trackRecognizer = TrackRecognizer(sampleRate: rate, channels: ch)
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
Thread.detachNewThread {
    ring.writerLoop { samples in trackRecognizer?.enqueue(samples) }
}

// Capture-health monitor. A Core Audio tap may produce no callbacks while the
// Mac output is silent, so absence of frames alone is not a failure signal.
// Exclusive/HOG ownership is authoritative: surface it, then rebuild once the
// owner releases the device. Default-device changes are handled separately.
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
    var quietFor = 0
    var flagged = false
    var wasHogged = false
    while true {
        Thread.sleep(forTimeInterval: 2)
        trackRecognizer?.announceSilenceIfNeeded()
        let now = ring.pushedCount()
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
