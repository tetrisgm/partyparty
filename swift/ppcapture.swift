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

        if !loggedFormat {
            if let fd = CMSampleBufferGetFormatDescription(sampleBuffer),
               let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(fd)?.pointee {
                let nonInterleaved = (asbd.mFormatFlags & kAudioFormatFlagIsNonInterleaved) != 0
                elog("ppcapture: source format \(Int(asbd.mSampleRate)) Hz, \(asbd.mChannelsPerFrame) ch, \(asbd.mBitsPerChannel)-bit, \(nonInterleaved ? "planar" : "interleaved")")
            }
            loggedFormat = true
        }

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
