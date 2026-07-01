// ppcapture — captures macOS system audio via ScreenCaptureKit and writes raw
// interleaved Float32 PCM (48 kHz, 2 ch) to stdout. partyparty pipes this into
// FFmpeg (`-f f32le -ar 48000 -ac 2 -i -`). Needs Screen Recording permission.

import Foundation
import AVFoundation
import CoreMedia
import ScreenCaptureKit

let errOut = FileHandle.standardError
func elog(_ s: String) { errOut.write((s + "\n").data(using: .utf8)!) }

let outHandle = FileHandle.standardOutput
func writeOut(_ data: Data) {
    do { try outHandle.write(contentsOf: data) } catch { exit(0) } // pipe closed -> done
}

@available(macOS 13.0, *)
final class SysAudioCapture: NSObject, SCStreamOutput, SCStreamDelegate {
    var stream: SCStream?
    var loggedFormat = false
    let audioQueue = DispatchQueue(label: "ppcapture.audio")
    let screenQueue = DispatchQueue(label: "ppcapture.screen")

    // Timeline continuity: SCK can drop buffers (queue overflow, guard-return
    // paths). A dropped buffer silently shortens the PCM timeline, which both
    // clicks and permanently shifts wall-clock vs media-time. Track the expected
    // next PTS and conceal any gap with silence so downstream timing stays true.
    var nextPTS: CMTime = .invalid
    var concealedMs: Double = 0
    var gapCount = 0

    func concealGapIfNeeded(_ pts: CMTime) {
        guard nextPTS.isValid, pts.isValid else { return }
        let gap = CMTimeGetSeconds(CMTimeSubtract(pts, nextPTS))
        guard gap > 0.002 else { return } // < 2ms: normal jitter
        let sec = min(gap, 2.0) // cap pathological gaps
        let frames = Int(sec * 48000)
        if frames > 0 {
            writeOut(Data(count: frames * 2 * MemoryLayout<Float32>.size)) // zero-filled silence
            gapCount += 1
            concealedMs += sec * 1000
            elog(String(format: "ppcapture: concealed %.0fms capture gap with silence (gap #%d, %.0fms total)", sec * 1000, gapCount, concealedMs))
        }
    }

    func start() async {
        do {
            let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
            guard let display = content.displays.first else {
                elog("ppcapture: no display available"); exit(2)
            }
            let filter = SCContentFilter(display: display, excludingApplications: [], exceptingWindows: [])
            let cfg = SCStreamConfiguration()
            cfg.capturesAudio = true
            cfg.sampleRate = 48000
            cfg.channelCount = 2
            cfg.excludesCurrentProcessAudio = true
            // A stream needs a video output too; keep it trivially small and ignore it.
            cfg.width = 2
            cfg.height = 2
            cfg.minimumFrameInterval = CMTime(value: 1, timescale: 1)
            cfg.queueDepth = 6

            let s = SCStream(filter: filter, configuration: cfg, delegate: self)
            try s.addStreamOutput(self, type: .audio, sampleHandlerQueue: audioQueue)
            try s.addStreamOutput(self, type: .screen, sampleHandlerQueue: screenQueue)
            try await s.startCapture()
            stream = s
            elog("ppcapture: capturing system audio (48000 Hz, 2 ch, f32le)")
        } catch {
            elog("ppcapture: failed to start: \(error.localizedDescription)")
            elog("ppcapture: grant Screen Recording permission in System Settings > Privacy & Security > Screen Recording, then start again.")
            exit(3)
        }
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        elog("ppcapture: stopped: \(error.localizedDescription)")
        exit(4)
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of outputType: SCStreamOutputType) {
        guard outputType == .audio, CMSampleBufferDataIsReady(sampleBuffer) else { return }

        let pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
        let frameCount = CMSampleBufferGetNumSamples(sampleBuffer)

        if !loggedFormat {
            if let fd = CMSampleBufferGetFormatDescription(sampleBuffer),
               let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(fd)?.pointee {
                let nonInterleaved = (asbd.mFormatFlags & kAudioFormatFlagIsNonInterleaved) != 0
                elog("ppcapture: source format \(Int(asbd.mSampleRate)) Hz, \(asbd.mChannelsPerFrame) ch, \(asbd.mBitsPerChannel)-bit, \(nonInterleaved ? "planar" : "interleaved"), \(frameCount) frames/callback (~\(frameCount * 1000 / 48000)ms)")
                // The pipe consumer declares f32le/48k/2ch with no header — any
                // other delivery format would be silent corruption. Fail loudly.
                let isFloat = (asbd.mFormatFlags & kAudioFormatFlagIsFloat) != 0
                if asbd.mFormatID != kAudioFormatLinearPCM || !isFloat || asbd.mBitsPerChannel != 32 || Int(asbd.mSampleRate) != 48000 {
                    elog("ppcapture: FATAL unexpected capture format — expected 48000 Hz Float32 PCM")
                    exit(5)
                }
            }
            loggedFormat = true
        }

        // Fill any hole left by dropped/skipped buffers before writing this one.
        concealGapIfNeeded(pts)

        var sizeNeeded = 0
        guard CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
            sampleBuffer, bufferListSizeNeededOut: &sizeNeeded, bufferListOut: nil,
            bufferListSize: 0, blockBufferAllocator: kCFAllocatorDefault,
            blockBufferMemoryAllocator: kCFAllocatorDefault, flags: 0, blockBufferOut: nil) == noErr,
            sizeNeeded > 0 else { return }

        let raw = UnsafeMutableRawPointer.allocate(byteCount: sizeNeeded, alignment: 16)
        defer { raw.deallocate() }
        let ablPtr = raw.assumingMemoryBound(to: AudioBufferList.self)
        var blockBuffer: CMBlockBuffer?
        guard CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
            sampleBuffer, bufferListSizeNeededOut: nil, bufferListOut: ablPtr,
            bufferListSize: sizeNeeded, blockBufferAllocator: kCFAllocatorDefault,
            blockBufferMemoryAllocator: kCFAllocatorDefault,
            flags: kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment, blockBufferOut: &blockBuffer) == noErr
            else { return }

        let list = UnsafeMutableAudioBufferListPointer(ablPtr)
        guard list.count > 0 else { return }

        if list.count >= 2, list[0].mNumberChannels == 1 {
            // Planar (separate L / R buffers) -> interleave to L,R,L,R
            let lBuf = list[0], rBuf = list[1]
            let frames = Int(lBuf.mDataByteSize) / MemoryLayout<Float32>.size
            guard frames > 0, let lp = lBuf.mData, let rp = rBuf.mData else { return }
            let l = lp.assumingMemoryBound(to: Float32.self)
            let r = rp.assumingMemoryBound(to: Float32.self)
            var inter = [Float32](repeating: 0, count: frames * 2)
            for i in 0..<frames { inter[2 * i] = l[i]; inter[2 * i + 1] = r[i] }
            inter.withUnsafeBytes { writeOut(Data(bytes: $0.baseAddress!, count: $0.count)) }
        } else {
            // Single buffer (already interleaved, or mono)
            let buf = list[0]
            guard let p = buf.mData else { return }
            let bytes = Int(buf.mDataByteSize)
            if buf.mNumberChannels >= 2 {
                writeOut(Data(bytes: p, count: bytes))
            } else {
                let frames = bytes / MemoryLayout<Float32>.size
                let m = p.assumingMemoryBound(to: Float32.self)
                var inter = [Float32](repeating: 0, count: frames * 2)
                for i in 0..<frames { inter[2 * i] = m[i]; inter[2 * i + 1] = m[i] }
                inter.withUnsafeBytes { writeOut(Data(bytes: $0.baseAddress!, count: $0.count)) }
            }
        }

        // Written (or concealed up to here) — expect the next buffer to start
        // exactly where this one ended. Guard-return paths above skip this, so
        // their loss is detected and concealed on the next callback.
        if pts.isValid, frameCount > 0 {
            nextPTS = CMTimeAdd(pts, CMTime(value: CMTimeValue(frameCount), timescale: 48000))
        }
    }
}

signal(SIGPIPE, SIG_IGN)
if #available(macOS 13.0, *) {
    let cap = SysAudioCapture()
    signal(SIGINT) { _ in exit(0) }
    signal(SIGTERM) { _ in exit(0) }
    Task { await cap.start() }
    dispatchMain()
} else {
    elog("ppcapture: requires macOS 13+")
    exit(1)
}
