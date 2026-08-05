import Foundation
import AVFoundation
import CoreAudio
import ShazamKit

/// Track recognition lives in the APP process because ShazamKit authenticates
/// by code-signing identity: fm.partyparty.app is the one identity with a
/// provisioning profile carrying the ShazamKit service. The capture helper
/// (fm.partyparty.capture) has no provisionable identity, so recognition
/// there died with error 202 ("Missing entitlements", HTTP 401 from Apple's
/// catalog) on every provisioned build - proven on TestFlight 255, 2026-08-05.
///
/// It reads its OWN Core Audio process tap, so the broadcast path in
/// ppcapture is untouched and recognition can never hold up live audio. The
/// System Audio Recording grant already exists by the time this runs: Go Live
/// primes it in the app's name, and this tap is the same TCC identity.
final class AppTrackRecognizer: NSObject, SHSessionDelegate {
    private let api: APIClient
    private let queue = DispatchQueue(label: "fm.partyparty.app.track-recognition", qos: .utility)
    private let state = NSLock()

    private var session: SHSession?
    private var format: AVAudioFormat?
    private var channels = 2
    private var tapID = AudioObjectID(kAudioObjectUnknown)
    private var aggID = AudioObjectID(kAudioObjectUnknown)
    private var procID: AudioDeviceIOProcID?
    private var running = false

    private var pending = 0
    private var lastID = ""
    private var lastErrorAt = Date.distantPast
    private var lastLoudAt = Date()
    private var silenceAnnounced = false

    init(api: APIClient) {
        self.api = api
        super.init()
    }

    // MARK: lifecycle (main thread)

    func start() {
        guard !running else { return }
        let desc = CATapDescription(stereoGlobalTapButExcludeProcesses: [])
        desc.uuid = UUID()
        desc.isPrivate = true
        var tap = AudioObjectID(kAudioObjectUnknown)
        var err = AudioHardwareCreateProcessTap(desc, &tap)
        guard err == noErr, tap != kAudioObjectUnknown else {
            NSLog("PartyParty: recognition tap failed (err \(err))")
            return
        }

        var fmtAddr = AudioObjectPropertyAddress(
            mSelector: kAudioTapPropertyFormat,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain)
        var asbd = AudioStreamBasicDescription()
        var fmtSize = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
        err = AudioObjectGetPropertyData(tap, &fmtAddr, 0, nil, &fmtSize, &asbd)
        guard err == noErr, asbd.mSampleRate > 0 else {
            NSLog("PartyParty: recognition tap format query failed (err \(err))")
            AudioHardwareDestroyProcessTap(tap)
            return
        }
        let rate = Int(asbd.mSampleRate)
        let ch = min(Int(asbd.mChannelsPerFrame), 2)
        guard let fmt = AVAudioFormat(
            commonFormat: .pcmFormatFloat32,
            sampleRate: Double(rate),
            channels: AVAudioChannelCount(ch),
            interleaved: false
        ) else {
            AudioHardwareDestroyProcessTap(tap)
            return
        }

        let aggDict: [String: Any] = [
            kAudioAggregateDeviceNameKey as String: "PartyParty recognition tap",
            kAudioAggregateDeviceUIDKey as String: "party.partyparty.recognize." + desc.uuid.uuidString,
            kAudioAggregateDeviceIsPrivateKey as String: true,
            kAudioAggregateDeviceTapAutoStartKey as String: true,
            kAudioAggregateDeviceTapListKey as String: [
                [kAudioSubTapUIDKey as String: desc.uuid.uuidString,
                 kAudioSubTapDriftCompensationKey as String: true],
            ],
        ]
        var agg = AudioObjectID(kAudioObjectUnknown)
        err = AudioHardwareCreateAggregateDevice(aggDict as CFDictionary, &agg)
        guard err == noErr, agg != kAudioObjectUnknown else {
            NSLog("PartyParty: recognition aggregate failed (err \(err))")
            AudioHardwareDestroyProcessTap(tap)
            return
        }

        let sess = SHSession()
        sess.delegate = self
        var proc: AudioDeviceIOProcID?
        err = AudioDeviceCreateIOProcIDWithBlock(&proc, agg, nil) { [weak self] _, inInputData, _, _, _ in
            guard let self else { return }
            let abl = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: inInputData))
            if abl.count >= 2, abl[0].mNumberChannels == 1 {
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
                    self.enqueue(inter)
                }
            } else if let first = abl.first, let p = first.mData {
                let n = Int(first.mDataByteSize) / MemoryLayout<Float32>.size
                if n > 0 {
                    let samples = Array(UnsafeBufferPointer(start: p.assumingMemoryBound(to: Float32.self), count: n))
                    self.enqueue(samples)
                }
            }
        }
        guard err == noErr, let procID = proc else {
            NSLog("PartyParty: recognition IOProc failed (err \(err))")
            AudioHardwareDestroyAggregateDevice(agg)
            AudioHardwareDestroyProcessTap(tap)
            return
        }
        err = AudioDeviceStart(agg, procID)
        guard err == noErr else {
            NSLog("PartyParty: recognition device start failed (err \(err))")
            AudioDeviceDestroyIOProcID(agg, procID)
            AudioHardwareDestroyAggregateDevice(agg)
            AudioHardwareDestroyProcessTap(tap)
            return
        }

        tapID = tap
        aggID = agg
        self.procID = procID
        session = sess
        format = fmt
        channels = ch
        state.lock()
        pending = 0
        lastID = ""
        lastLoudAt = Date()
        silenceAnnounced = false
        state.unlock()
        running = true
        NSLog("PartyParty: track recognition running in-app (\(rate) Hz, \(ch) ch)")
    }

    func stop() {
        guard running else { return }
        if let procID { AudioDeviceStop(aggID, procID); AudioDeviceDestroyIOProcID(aggID, procID) }
        if aggID != kAudioObjectUnknown { AudioHardwareDestroyAggregateDevice(aggID) }
        if tapID != kAudioObjectUnknown { AudioHardwareDestroyProcessTap(tapID) }
        procID = nil
        aggID = AudioObjectID(kAudioObjectUnknown)
        tapID = AudioObjectID(kAudioObjectUnknown)
        session = nil
        format = nil
        running = false
    }

    // MARK: recognition (mirrors the proven ppcapture logic)

    private func enqueue(_ interleaved: [Float32]) {
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
            guard let session, let format else { return }
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
        var payload: [String: Any] = ["id": matchID, "title": title, "artist": artist]
        if let artworkURL = item.artworkURL?.absoluteString {
            payload["artworkUrl"] = artworkURL
        }
        api.postTrack(payload)
    }

    private func announceSilenceIfNeeded() {
        state.lock()
        let shouldAnnounce = !silenceAnnounced && Date().timeIntervalSince(lastLoudAt) >= 10
        if shouldAnnounce {
            silenceAnnounced = true
            lastID = ""
        }
        state.unlock()
        if shouldAnnounce {
            api.postTrack(["silent": true])
        }
    }

    func session(_ session: SHSession, didNotFindMatchFor signature: SHSignature, error: Error?) {
        guard let error else { return }
        state.lock()
        let shouldLog = Date().timeIntervalSince(lastErrorAt) >= 60
        if shouldLog { lastErrorAt = Date() }
        state.unlock()
        if shouldLog { NSLog("PartyParty: track recognition unavailable (\(error.localizedDescription))") }
    }
}
