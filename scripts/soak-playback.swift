// The pre-upload playback soak: a muted, headless, REAL AVPlayer attached to a
// live stream, watched against the live edge.
//
// A soak that can pass without playing is worse than no soak: the first
// version of this file reported "SOAK PASS" for a run where the player never
// connected at all (status FAILED, position 0.00 for every sample). PASS is
// therefore an ASSERTION, not the absence of a complaint - the run must prove
// it attached, advanced, sat at the declared target, and never went backward.
//
// WHAT THE NUMBERS MEAN (this is the whole point of the instrument).
//
// The original harness printed one number, `latency`, computed as wall clock
// minus the PROGRAM-DATE-TIME under the playhead. That is a SUM of two
// independent quantities, and reading it as one number is what left the
// 2026-08-11 direct-versus-relay finding unresolvable:
//
//   edge   = now - (wall clock of the newest media the playlist advertises)
//            How STALE the playlist is. Zero on the Mac's own path; on a relay
//            it is the push-plus-fan-out delay. Nothing to do with the schedule.
//
//   attach = latency - edge
//            How far back from the live edge the player chose to sit. THIS is
//            the quantity the room schedule controls, via EXT-X-START in the
//            multivariant playlist and PART-HOLD-BACK in the media playlist.
//
//   latency = edge + attach
//            End-to-end delay: DJ's speaker to listener's ear.
//
// The target assertion is on `attach`, because that is what a playlist change
// can move. A run that fails on `attach` is a schedule problem; a run whose
// `attach` is on target but whose `latency` is long is a transport problem, and
// they need opposite fixes. Both are printed on every line, and every receipt
// now carries a header naming the URL it measured - the five receipts committed
// before 2026-09-11 do not, which is why they cannot be compared to each other.
import AVFoundation
import Foundation

setvbuf(stdout, nil, _IONBF, 0) // report live, not at exit

guard CommandLine.arguments.count > 1, let url = URL(string: CommandLine.arguments[1]) else {
    print("usage: soak-playback <stream-url>   (PP_SOAK_MINUTES, PP_SOAK_TARGET, PP_SOAK_LABEL, PP_SOAK_BUILD)")
    exit(64)
}
let env = ProcessInfo.processInfo.environment
let minutes = Int(env["PP_SOAK_MINUTES"] ?? "") ?? 10
let target = Double(env["PP_SOAK_TARGET"] ?? "") ?? 2.0
let label = env["PP_SOAK_LABEL"] ?? "unlabelled"
let build = env["PP_SOAK_BUILD"] ?? "unrecorded"
let sampleLimit = max(1, minutes * 12) // one printed sample every 5s

// Position is read far more often than it is printed. A backward seek that
// recovers inside one five-second window is invisible to a five-second sampler,
// and a backward seek is exactly what this harness exists to catch.
let positionTick = 0.25
let printEvery = 5.0

// MARK: - playlist probe
//
// An independent reader of the same playlists the player is reading, used only
// to learn where the live edge is in wall-clock terms. It primes a cookie off
// the multivariant the way a player does, because MediaMTX answers 401 to a
// media playlist request that carries no session cookie.

final class InsecureLoopback: NSObject, URLSessionDelegate {
    func urlSession(_ session: URLSession,
                    didReceive challenge: URLAuthenticationChallenge,
                    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        // Loopback only. A soak of a throwaway lab stack presents a throwaway
        // certificate; anything off this machine must still validate normally.
        let host = challenge.protectionSpace.host
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              host == "127.0.0.1" || host == "localhost" || host == "::1",
              let trust = challenge.protectionSpace.serverTrust else {
            completionHandler(.performDefaultHandling, nil)
            return
        }
        completionHandler(.useCredential, URLCredential(trust: trust))
    }
}

let probeDelegate = InsecureLoopback()
let probeSession: URLSession = {
    let cfg = URLSessionConfiguration.ephemeral
    cfg.httpShouldSetCookies = true
    cfg.httpCookieAcceptPolicy = .always
    cfg.timeoutIntervalForRequest = 3
    cfg.requestCachePolicy = .reloadIgnoringLocalAndRemoteCacheData
    return URLSession(configuration: cfg, delegate: probeDelegate, delegateQueue: nil)
}()

func fetchText(_ u: URL) -> String? {
    var body: String?
    let done = DispatchSemaphore(value: 0)
    var req = URLRequest(url: u)
    req.cachePolicy = .reloadIgnoringLocalAndRemoteCacheData
    probeSession.dataTask(with: req) { data, response, _ in
        defer { done.signal() }
        guard let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode),
              let data, let text = String(data: data, encoding: .utf8) else { return }
        body = text
    }.resume()
    _ = done.wait(timeout: .now() + 4)
    return body
}

let isoWithFraction: ISO8601DateFormatter = {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return f
}()
let isoPlain: ISO8601DateFormatter = {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime]
    return f
}()

func parseISO(_ s: String) -> Date? {
    isoWithFraction.date(from: s) ?? isoPlain.date(from: s)
}

func attrDouble(_ line: String, _ key: String) -> Double? {
    guard let r = line.range(of: key + "=") else { return nil }
    let rest = line[r.upperBound...]
    let value = rest.prefix { "0123456789.".contains($0) }
    return Double(value)
}

/// The wall-clock time of the newest media the playlist advertises.
///
/// Walks the playlist in order rather than summing everything after the last
/// PROGRAM-DATE-TIME, because a low-latency playlist lists a segment's parts
/// AND, once the segment closes, its EXTINF. Adding both double-counts that
/// segment - the same miscount that inflates RealHistory in
/// internal/mediamtx. Parts accumulated since the last EXTINF are discarded
/// when that EXTINF arrives, and only the trailing open parts are added.
func playlistEdge(_ text: String) -> Date? {
    var wall: Date?
    var openParts = 0.0
    for rawLine in text.split(whereSeparator: { $0 == "\n" || $0 == "\r" }) {
        let line = String(rawLine)
        if line.hasPrefix("#EXT-X-PROGRAM-DATE-TIME:") {
            if let d = parseISO(String(line.dropFirst("#EXT-X-PROGRAM-DATE-TIME:".count))) {
                wall = d
                openParts = 0
            }
        } else if line.hasPrefix("#EXT-X-PART:") {
            if let d = attrDouble(line, "DURATION") { openParts += d }
        } else if line.hasPrefix("#EXTINF:") {
            let value = line.dropFirst("#EXTINF:".count).prefix { "0123456789.".contains($0) }
            if let d = Double(value), let base = wall {
                wall = base.addingTimeInterval(d)
            }
            openParts = 0
        }
    }
    guard let base = wall else { return nil }
    return base.addingTimeInterval(openParts)
}

/// Resolves the media playlist for whatever tier the soak URL points at, and
/// remembers it so the per-sample probe is one request rather than two.
var mediaURL: URL?
func resolveMediaURL() -> URL? {
    if let cached = mediaURL { return cached }
    guard let body = fetchText(url) else { return nil }
    if !body.contains("#EXT-X-STREAM-INF") {
        mediaURL = url // already a media playlist (this is the shape a relay guest gets)
        return mediaURL
    }
    // Multivariant: the first bare URI line is the only audio rendition. The
    // fetch above also primed the session cookie the media playlist needs.
    for rawLine in body.split(whereSeparator: { $0 == "\n" || $0 == "\r" }) {
        let line = String(rawLine).trimmingCharacters(in: .whitespaces)
        if line.isEmpty || line.hasPrefix("#") { continue }
        mediaURL = URL(string: line, relativeTo: url)?.absoluteURL
        return mediaURL
    }
    return nil
}

func measureEdge() -> Double? {
    guard let media = resolveMediaURL(), let body = fetchText(media) else { return nil }
    guard let edgeWall = playlistEdge(body) else { return nil }
    return Date().timeIntervalSince(edgeWall)
}

// The probe runs on its own queue and publishes its most recent reading. It
// must never run on the run loop the position sampler lives on: a probe that
// blocks for a second is a second in which a backward seek is invisible, and
// hiding a backward seek is the one thing this harness may not do.
//
// Staleness is the delta itself, not the absolute edge time, because the delta
// is the steady-state quantity - re-deriving it from an older absolute time
// would make it grow with the age of the reading rather than report the stream.
let edgeLock = NSLock()
var latestEdge: (value: Double, at: Date)?
let probeQueue = DispatchQueue(label: "soak.probe")

func startEdgeProbe() {
    probeQueue.async {
        while true {
            let measured = measureEdge()
            edgeLock.lock()
            if let m = measured { latestEdge = (m, Date()) }
            edgeLock.unlock()
            Thread.sleep(forTimeInterval: printEvery / 2)
        }
    }
}

/// The most recent edge reading, or nil when the probe has not produced a
/// usable one recently enough to pair with this sample.
func freshEdge() -> Double? {
    edgeLock.lock()
    defer { edgeLock.unlock() }
    guard let latest = latestEdge, Date().timeIntervalSince(latest.at) <= printEvery else { return nil }
    return latest.value
}

// MARK: - player

let item = AVPlayerItem(url: url)
let player = AVPlayer(playerItem: item)
player.volume = 0 // headless: audio must never reach the Mac's output - it would be captured
player.play()

/// Whether AVFoundation decided this stream is LOW LATENCY, and what offset it
/// therefore recommends.
///
/// This is the difference between two regimes that produce completely
/// different numbers from the same playlist, and confusing them is what made
/// the 2026-08-11 direct and relay receipts irreconcilable:
///
///   low-latency mode   the player targets recommendedTimeOffsetFromLive,
///                      which AVFoundation derives from PART-HOLD-BACK. With a
///                      0.9 hold-back that lands near 1.2s from the edge.
///   ordinary live      the player falls back to the HLS rule of starting three
///                      target durations from the end. gohlslib rounds
///                      TARGETDURATION to an integer second, so 500ms segments
///                      give 3 x 1s = about 3.0s.
///
/// A receipt that does not say which regime it was in cannot be compared to one
/// taken in the other, so every line says.
func liveOffsets() -> (recommended: Double, configured: Double, lowLatency: Bool) {
    let rec = item.recommendedTimeOffsetFromLive.seconds
    let cfg = item.configuredTimeOffsetFromLive.seconds
    let recOK = rec.isFinite && rec > 0
    return (recOK ? rec : -1, cfg.isFinite ? cfg : -1, recOK)
}

var lastTime = -1.0
var samples = 0
var backwardEvents = 0
var worstBackward = 0.0
var failedSamples = 0
var readySamples = 0
var latencies: [Double] = []
var attaches: [Double] = []
var edges: [Double] = []
var firstPosition = -1.0
var lastPosition = -1.0
var edgeUnavailable = 0
var lowLatencySamples = 0

func median(_ xs: [Double]) -> Double { xs.sorted()[xs.count / 2] }

let started = Date()
print("soak begin url=\(url.absoluteString) label=\(label) target=\(String(format: "%.3f", target))s "
    + "minutes=\(minutes) print=\(String(format: "%.1f", printEvery))s position=\(String(format: "%.2f", positionTick))s "
    + "build=\(build) started=\(isoWithFraction.string(from: started))")
print("soak legend latency=edge+attach edge=playlist staleness attach=distance the player chose from the live edge")

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
            problems.append(String(format: "end-to-end delay drifted %.2fs (%.2f..%.2f)", high - low, low, high))
        }
    }
    // The schedule controls distance from the live edge, not delivery lag, so
    // the target assertion belongs on attach. A run that cannot measure attach
    // has not proven anything about the schedule and must not pass.
    if attaches.isEmpty {
        problems.append("attachment position was never measurable (\(edgeUnavailable) failed edge probes): this run says nothing about the schedule")
    } else {
        let m = median(attaches)
        if abs(m - target) > 0.75 {
            problems.append(String(format: "median attachment %.2fs is not the declared target %.2fs", m, target))
        }
    }
    if backwardEvents > 0 {
        problems.append(String(format: "%d BACKWARD jump(s), worst %.2fs", backwardEvents, worstBackward))
    }
    return (problems.isEmpty, problems)
}

func finish() -> Never {
    let result = verdict()
    let latencyText = latencies.isEmpty ? "n/a" : String(format: "%.2fs", median(latencies))
    let edgeText = edges.isEmpty ? "n/a" : String(format: "%.2fs", median(edges))
    let attachText = attaches.isEmpty ? "n/a" : String(format: "%.2fs", median(attaches))
    let mode = lowLatencySamples >= samples / 2 ? "low-latency" : "ordinary-live"
    let summary = "\(minutes)min, \(samples) samples, mode \(mode) (\(lowLatencySamples)/\(samples) low-latency), median latency \(latencyText) = edge \(edgeText) + attach \(attachText), target \(String(format: "%.2f", target))s on attach"
    if result.ok {
        print("SOAK PASS: \(summary), zero backward movement")
        print("soak end url=\(url.absoluteString) label=\(label) verdict=PASS")
        exit(0)
    }
    print("SOAK FAIL: " + result.lines.joined(separator: "; "))
    print("soak end url=\(url.absoluteString) label=\(label) verdict=FAIL summary=\(summary)")
    exit(1)
}

// Position is polled fast so a brief backward seek cannot hide between prints.
var sincePrint = 0.0
let timer = Timer.scheduledTimer(withTimeInterval: positionTick, repeats: true) { _ in
    let t = item.currentTime().seconds
    var note = "ok"
    if lastTime >= 0, t.isFinite, t < lastTime - 0.05 {
        backwardEvents += 1
        worstBackward = max(worstBackward, lastTime - t)
        note = String(format: "BACKWARD by %.2fs", lastTime - t)
        print(String(format: "soak t=%03ds pos=%.2fs %@", Int(Date().timeIntervalSince(started)), t, note))
    }
    if t.isFinite, t > 0 {
        if firstPosition < 0 { firstPosition = t }
        lastPosition = t
        lastTime = max(lastTime, t)
    }

    sincePrint += positionTick
    guard sincePrint >= printEvery - 1e-9 else { return }
    sincePrint = 0

    var latency = -1.0
    if let d = item.currentDate() {
        latency = Date().timeIntervalSince(d)
        latencies.append(latency)
    }
    var edge = -1.0
    var attach = -1.0
    if let e = freshEdge() {
        edge = e
        edges.append(e)
        if latency >= 0 {
            attach = latency - e
            attaches.append(attach)
        }
    } else {
        edgeUnavailable += 1
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
    let off = liveOffsets()
    if off.lowLatency { lowLatencySamples += 1 }
    samples += 1
    print(String(format: "soak t=%03ds pos=%.2fs latency=%.2fs edge=%.2fs attach=%.2fs mode=%@ recommended=%.2fs status=%@ %@",
                 samples * Int(printEvery), t, latency, edge, attach,
                 off.lowLatency ? "low-latency" : "ordinary-live", off.recommended, status, note))
    if samples >= sampleLimit { finish() }
}
RunLoop.main.add(timer, forMode: .common)
startEdgeProbe()
RunLoop.main.run()
