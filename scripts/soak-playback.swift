// The pre-upload playback soak: a muted, headless, REAL AVPlayer attached to a
// live stream, watched against the live edge.
//
// A soak that can pass without playing is worse than no soak: the first
// version of this file reported "SOAK PASS" for a run where the player never
// connected at all (status FAILED, position 0.00 for every sample). PASS is
// therefore an ASSERTION, not the absence of a complaint - the run must prove
// it attached, advanced, sat at the declared target, and never went backward.
import AVFoundation
import Foundation

setvbuf(stdout, nil, _IONBF, 0) // report live, not at exit

guard CommandLine.arguments.count > 1, let url = URL(string: CommandLine.arguments[1]) else {
    print("usage: soak-playback <stream-url>   (PP_SOAK_MINUTES, PP_SOAK_TARGET)")
    exit(64)
}
let env = ProcessInfo.processInfo.environment
let minutes = Int(env["PP_SOAK_MINUTES"] ?? "") ?? 10
let target = Double(env["PP_SOAK_TARGET"] ?? "") ?? 3.0
let sampleLimit = max(1, minutes * 12) // one sample every 5s

let item = AVPlayerItem(url: url)
let player = AVPlayer(playerItem: item)
player.volume = 0 // headless: audio must never reach the Mac's output - it would be captured
player.play()

var lastTime = -1.0
var samples = 0
var backwardEvents = 0
var failedSamples = 0
var readySamples = 0
var latencies: [Double] = []
var firstPosition = -1.0
var lastPosition = -1.0

func verdict() -> (ok: Bool, lines: [String]) {
    var problems: [String] = []
    if failedSamples > 0 {
        problems.append("player reported failure on \(failedSamples) sample(s)")
    }
    if readySamples < samples * 4 / 5 {
        problems.append("only \(readySamples)/\(samples) samples were ready to play")
    }
    if firstPosition < 0 || lastPosition <= firstPosition {
        problems.append("playback position never advanced (attached but silent?)")
    }
    if latencies.isEmpty {
        problems.append("no live-edge measurement was ever available")
    } else {
        let low = latencies.min() ?? 0
        let high = latencies.max() ?? 0
        if high - low > 1.5 {
            problems.append(String(format: "position drifted %.2fs (%.2f..%.2f)", high - low, low, high))
        }
        let median = latencies.sorted()[latencies.count / 2]
        if abs(median - target) > 0.75 {
            problems.append(String(format: "median position %.2fs is not the declared target %.2fs", median, target))
        }
    }
    if backwardEvents > 0 {
        problems.append("\(backwardEvents) BACKWARD jump(s)")
    }
    return (problems.isEmpty, problems)
}

let timer = Timer.scheduledTimer(withTimeInterval: 5.0, repeats: true) { _ in
    let t = item.currentTime().seconds
    var latency = -1.0
    if let d = item.currentDate() {
        latency = Date().timeIntervalSince(d)
        latencies.append(latency)
    }
    let status: String
    switch item.status {
    case .readyToPlay:
        status = "ready"
        readySamples += 1
    case .failed:
        status = "FAILED(\(item.error?.localizedDescription ?? "?"))"
        failedSamples += 1
    default:
        status = "loading"
    }
    var note = "ok"
    if lastTime >= 0, t < lastTime - 0.05 {
        backwardEvents += 1
        note = String(format: "BACKWARD by %.2fs", lastTime - t)
    }
    if t.isFinite, t > 0 {
        if firstPosition < 0 { firstPosition = t }
        lastPosition = t
    }
    lastTime = max(lastTime, t)
    samples += 1
    print(String(format: "soak t=%03ds pos=%.2fs latency=%.2fs status=%@ %@",
                 samples * 5, t, latency, status, note))
    if samples >= sampleLimit {
        let result = verdict()
        if result.ok {
            let median = latencies.sorted()[latencies.count / 2]
            print(String(format: "SOAK PASS: %dmin, %d samples, median %.2fs at target %.2fs, zero backward movement",
                         minutes, samples, median, target))
            exit(0)
        }
        print("SOAK FAIL: " + result.lines.joined(separator: "; "))
        exit(1)
    }
}
RunLoop.main.add(timer, forMode: .common)
RunLoop.main.run()
