// Real macOS WKWebView/native-HLS comparison. This runs the actual guest page,
// unlike a bare AVPlayer soak. Silent output, independent website stores.
// It measures media clocks, NOT physical output or iPhone lock-screen behavior.
import Cocoa
import WebKit

setvbuf(stdout, nil, _IONBF, 0)
guard CommandLine.arguments.count == 5,
      let url = URL(string: CommandLine.arguments[1]),
      let seconds = Double(CommandLine.arguments[4]) else {
    print("usage: soak-listener <loopback-page-url> <setup.js> <candidate.js> <seconds>")
    exit(64)
}
let setup = try String(contentsOfFile: CommandLine.arguments[2], encoding: .utf8)
let candidate = try String(contentsOfFile: CommandLine.arguments[3], encoding: .utf8)
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 800, height: 600), styleMask: [.titled, .closable], backing: .buffered, defer: false)
window.title = "PartyParty native sync lab — silent"
let start = Date()
var views: [WKWebView] = []
var completed = false

final class Reporter: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
    func webView(_ webView: WKWebView, didReceive challenge: URLAuthenticationChallenge,
                 completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        if challenge.protectionSpace.host == "127.0.0.1",
           challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
           let trust = challenge.protectionSpace.serverTrust {
            completionHandler(.useCredential, URLCredential(trust: trust))
        } else { completionHandler(.performDefaultHandling, nil) }
    }
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        if let body = message.body as? [String: Any],
           let data = try? JSONSerialization.data(withJSONObject: body, options: [.sortedKeys]),
           let line = String(data: data, encoding: .utf8) { print(line) }
    }
}
let reporter = Reporter()
let comparing = !candidate.isEmpty
let injectDrift = ProcessInfo.processInfo.environment["PP_SYNC_DRIFT"] == "1"
for index in 0..<(comparing ? 4 : 2) {
    let config = WKWebViewConfiguration()
    config.websiteDataStore = .nonPersistent()
    config.mediaTypesRequiringUserActionForPlayback = []
    let scripts = config.userContentController
    scripts.add(reporter, name: "sample")
    scripts.addUserScript(WKUserScript(source: setup, injectionTime: .atDocumentStart, forMainFrameOnly: true))
    let name = comparing ? (index < 2 ? "baseline-\(index)" : "candidate-\(index - 2)") : "current-\(index)"
    let driver = """
    \(index >= 2 ? candidate : "")
    const labAt = performance.now();
    let labJoined = false, labBefore = null, labMetadataLogged = false, labDrifted = false;
    setInterval(() => {
      const p = document.getElementById('player');
      if (!p || typeof streamReady === 'undefined') return;
      p.volume = 0;
      for (const track of p.textTracks) {
        if (track.kind !== 'metadata') continue;
        track.mode = 'hidden';
        if (!labMetadataLogged && track.cues?.length) {
          labMetadataLogged = true;
          window.webkit.messageHandlers.sample.postMessage({arm:'\(name)', metadata: Array.from(track.cues).slice(-5).map(c=>({start:c.startTime,end:c.endTime,value:c.value,type:c.type}))});
        }
      }
      if (!labJoined && live && streamReady && performance.now() - labAt > \(index % 2 == 1 ? 5000 : 500)) {
        labJoined = true;
        if (!attached) attachSafe();
        beginAudible('native-lab');
        play();
      }
      if (\(injectDrift && index == 1 ? "true" : "false") && !labDrifted && performance.now()-labAt >= 30000 && !p.muted && p.readyState >= 3) {
        labDrifted = true;
        window.webkit.messageHandlers.sample.postMessage({arm:'\(name)',injectedStallAt:(performance.now()-labAt)/1000,duration:1.2});
        p.playbackRate = 0;
        setTimeout(() => { p.playbackRate = 1; }, 1200);
      }
      const roundedOrigin = currentTimelineOrigin();
      const preciseOrigin = window.readNativeTimeline(p, roundedOrigin);
      const origin = preciseOrigin ?? roundedOrigin;
      const latency = clockReliable() && origin != null ? (serverNow() - origin - p.currentTime*1000)/1000 : null;
      const sample = { arm: '\(name)', elapsed: (performance.now()-labAt)/1000,
        platform, latency, position: p.currentTime, rate: p.playbackRate,
        audibleSeeks, generation: attachGeneration,
        muted: p.muted, paused: p.paused, ready: p.readyState, seeking: p.seeking,
        phase: window.playbackSyncCandidate?.phase || (nativeJoin.active ? 'aligning' : 'playing'),
        backward: labBefore != null && p.currentTime < labBefore - .05,
        clock: clockReliable(), uncertainty: clockUncertainty, origin, precise: preciseOrigin != null, roundedOrigin,
        seekableEnd: p.seekable.length ? p.seekable.end(p.seekable.length-1) : null,
        bufferEnd: p.buffered.length ? p.buffered.end(p.buffered.length-1) : null };
      labBefore = p.currentTime;
      window.webkit.messageHandlers.sample.postMessage(sample);
    }, 250);
    """
    scripts.addUserScript(WKUserScript(source: driver, injectionTime: .atDocumentEnd, forMainFrameOnly: true))
    let view = WKWebView(frame: NSRect(x: (index % 2) * 400, y: (index / 2) * 300, width: 400, height: 300), configuration: config)
    view.customUserAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15"
    view.navigationDelegate = reporter
    window.contentView!.addSubview(view)
    views.append(view)
    view.load(URLRequest(url: url))
}
window.orderFrontRegardless()
print("native listener soak begin url=\(url.absoluteString) seconds=\(seconds) os=\(ProcessInfo.processInfo.operatingSystemVersionString)")
let timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { _ in
    if Date().timeIntervalSince(start) >= seconds && !completed {
        completed = true
        print("native listener soak end")
        exit(0)
    }
}
RunLoop.main.add(timer, forMode: .common)
app.run()
