import AppKit
import AVFoundation
import WebKit
import ServiceManagement
import CoreGraphics

/// Weak forwarder so WKUserContentController's strong handler reference
/// doesn't retain the window controller (see init below).
private final class WeakScriptHandler: NSObject, WKScriptMessageHandler {
    private weak var target: WKScriptMessageHandler?
    init(_ target: WKScriptMessageHandler) { self.target = target }
    func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.userContentController(ucc, didReceive: message)
    }
}

/// The DJ console as a real, resizable window hosting web/dj.html in a WKWebView.
/// A "pp" JS↔Swift bridge lets the in-app console toggle Start-at-Login and Quit.
final class AdminWindowController: NSWindowController, NSWindowDelegate, WKNavigationDelegate, WKScriptMessageHandler {
    private enum CapturePermissionKind: String {
        case systemAudio
        case microphone
    }

    private enum CapturePermissionState: String {
        case granted
        case denied
        case undetermined
    }

    private let port: Int
    private var webView: WKWebView!
    private var capturePermissionKind: CapturePermissionKind = .systemAudio
    // Consecutive blank-console recovery attempts (reset to 0 on a healthy boot).
    private var bootAttempts = 0
    private var pendingGuestQR = false

    init(port: Int) {
        self.port = port
        let win = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1140, height: 820),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered, defer: false)
        win.title = appName
        win.center()
        win.setFrameAutosaveName("ConsoleWindow")
        win.minSize = NSSize(width: 860, height: 560)
        // The console pages are light-first: match the chrome so the window
        // never flashes/frames dark around them (follows the page, not the OS
        // theme, until the pages grow a dark mode).
        win.backgroundColor = NSColor(srgbRed: 0.961, green: 0.961, blue: 0.969, alpha: 1)
        super.init(window: win)
        win.delegate = self

        let cfg = WKWebViewConfiguration()
        cfg.websiteDataStore = .default() // persist localStorage prefs across launches
        let ucc = WKUserContentController()
        // WKUserContentController retains its handler STRONGLY — adding self
        // directly cycles controller→webView→config→ucc→controller and the
        // window could never deallocate. The weak proxy breaks the cycle.
        ucc.add(WeakScriptHandler(self), name: "pp")
        // ppNativeReset advertises that this build handles the "resetConsole"
        // bridge action (full WKWebView data-store clear), so the console's boot
        // fallback hands off deep recovery to the app instead of a JS-only clear.
        ucc.addUserScript(WKUserScript(source: "window.ppNative = true; window.ppNativeReset = true;",
                                       injectionTime: .atDocumentStart, forMainFrameOnly: true))
        // Instrumentation: capture the raw JS console + uncaught errors natively,
        // before any page script runs, so a broken console is diagnosable even
        // when the page's own error handling never executes.
        ucc.addUserScript(WKUserScript(source: Self.consoleCaptureJS,
                                       injectionTime: .atDocumentStart, forMainFrameOnly: true))
        cfg.userContentController = ucc

        webView = WKWebView(frame: .zero, configuration: cfg)
        webView.navigationDelegate = self
        webView.allowsBackForwardNavigationGestures = false
        win.contentView = webView
        loadConsole()
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) not supported") }

    private func loadConsole() {
        // Numeric loopback, NOT "localhost": on some Macs `localhost` resolves to
        // an address the WebView can't reach (a broken /etc/hosts or a dead IPv6
        // ::1), which loads as a blank page and — because the diagnostics below
        // also posted to localhost — reported nothing. 127.0.0.1 needs no DNS and
        // always hits the server's IPv4 listener. THIS is the field white-screen.
        guard let url = URL(string: "http://127.0.0.1:\(port)/dj") else { return }
        webView.load(URLRequest(url: url))
    }

    /// Clear the console's persisted web state (localStorage + caches) and reload.
    /// The page's boot fallback calls this when init failed — most often a stale
    /// saved value poisoning startup — so a clean-slate reload is the reliable
    /// recovery. Scoped to the loopback origin so unrelated web data is not
    /// touched; party content lives server-side, so nothing real is lost.
    private func resetConsole() {
        let store = WKWebsiteDataStore.default()
        let types = WKWebsiteDataStore.allWebsiteDataTypes()
        store.fetchDataRecords(ofTypes: types) { records in
            let targets = records.filter {
                $0.displayName.contains("localhost") || $0.displayName.contains("127.0.0.1")
            }
            store.removeData(ofTypes: types, for: targets) { [weak self] in
                DispatchQueue.main.async { self?.loadConsole() }
            }
        }
    }

    // MARK: - Instrumentation

    private var appVersionString: String {
        (Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String) ?? "?"
    }

    /// Forward a WebView diagnostic into the session log (which uploads to the
    /// broker) via the local /api/client-events sink — the same black-box
    /// recorder the web client uses. Navigation failures, WebContent crashes,
    /// captured JS console errors, and boot-state probes all land there, so a
    /// blank or stuck console is finally diagnosable remotely instead of guessed
    /// at. kind "error" flags an urgent cloud upload server-side.
    private func diag(_ kind: String, _ fields: [String: Any] = [:]) {
        var ev = fields
        ev["k"] = kind
        let payload: [String: Any] = [
            "cid": "webview", "tab": "dj", "v": appVersionString, "plat": "mac", "page": "dj",
            "events": [ev],
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: payload),
              let url = URL(string: "http://127.0.0.1:\(port)/api/client-events") else { return }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = data
        URLSession.shared.dataTask(with: req).resume()
    }

    /// Injected at documentStart (before any page script): mirror console.error/
    /// warn and uncaught errors/rejections over the pp bridge so we capture the
    /// raw JS console even when the page's own error handling never runs.
    private static let consoleCaptureJS = """
    (function () {
      function send(level, msg) {
        try { window.webkit.messageHandlers.pp.postMessage({ action: 'jslog', level: level, msg: String(msg).slice(0, 500) }); } catch (e) {}
      }
      ['error', 'warn'].forEach(function (m) {
        var orig = console[m];
        console[m] = function () { try { send(m, Array.prototype.join.call(arguments, ' ')); } catch (e) {} return orig.apply(console, arguments); };
      });
      window.addEventListener('error', function (e) {
        if (e && e.target && e.target !== window && e.target.tagName) return;
        window.__ppLastError = ((e && e.message) || 'error') + ' @' + String((e && e.filename) || '').split('/').pop() + ':' + ((e && e.lineno) || 0);
        send('error', 'onerror: ' + window.__ppLastError);
      }, true);
      window.addEventListener('unhandledrejection', function (e) {
        send('error', 'unhandledrejection: ' + ((e && e.reason && (e.reason.message || e.reason)) || '?'));
      }, true);
    })();
    """

    // MARK: - Navigation lifecycle (instrumented)

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        diag("nav-start", ["url": webView.url?.absoluteString ?? "?"])
    }

    // Retry while the Go server is still coming up (also covers a mid-update
    // window where the server is being reaped/rebound).
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        let ns = error as NSError
        diag("error", ["msg": "provisional nav failed: \(ns.domain) \(ns.code) — \(ns.localizedDescription)"])
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in self?.loadConsole() }
    }

    // A load that started then failed — retry the same way.
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        let ns = error as NSError
        diag("error", ["msg": "nav failed: \(ns.domain) \(ns.code) — \(ns.localizedDescription)"])
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in self?.loadConsole() }
    }

    // The WebContent process crashed (rare, but leaves a permanent white view) —
    // reload instead of sitting blank.
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        diag("error", ["msg": "WebContent process terminated (crash) — reloading"])
        loadConsole()
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        pushLoginState()
        pushCapturePermission()
        if pendingGuestQR { revealGuestQR() }
        scheduleBootWatchdog()
    }

    func showGuestQR() {
        pendingGuestQR = true
        showWindow(nil)
        window?.makeKeyAndOrderFront(nil)
        revealGuestQR()
    }

    private func revealGuestQR() {
        let js = """
        (function () {
          try {
            if (window.__ppOpenQRInterval) clearInterval(window.__ppOpenQRInterval);
            var attempts = 0;
            function reveal() {
              var card = document.getElementById('shareCard');
              var qr = document.getElementById('qr');
              if (!card || !qr || card.hidden || !qr.childElementCount) return false;
              card.scrollIntoView({ behavior: 'smooth', block: 'center' });
              return true;
            }
            if (!reveal()) {
              window.__ppOpenQRInterval = setInterval(function () {
                if (reveal() || ++attempts >= 40) {
                  clearInterval(window.__ppOpenQRInterval);
                  window.__ppOpenQRInterval = 0;
                }
              }, 250);
            }
            return true;
          } catch (e) {
            return false;
          }
        })()
        """
        webView.evaluateJavaScript(js) { [weak self] result, error in
            if error == nil, result as? Bool == true {
                self?.pendingGuestQR = false
            }
        }
    }

    // MARK: - Boot watchdog (self-heal + report a console that never comes alive)

    private func scheduleBootWatchdog() {
        DispatchQueue.main.asyncAfter(deadline: .now() + 3.0) { [weak self] in self?.probeBoot() }
    }

    /// A few seconds after a load finishes, ask the page for its real state. This
    /// is the authoritative answer to "is the console actually alive?": did JS
    /// run (booted), does the DOM have content, is the recovery panel showing,
    /// what was the last error. The snapshot is logged either way; a page that
    /// loaded but rendered nothing triggers escalating self-heal.
    private func probeBoot() {
        let js = """
        (function () { try { var b = document.body; return JSON.stringify({
          rs: document.readyState, booted: !!window.__ppBooted,
          kids: b ? b.childElementCount : -1, len: b ? (b.innerText || '').length : -1,
          fb: !!document.getElementById('__ppBootFallback'), url: location.href,
          err: window.__ppLastError || null }); } catch (e) { return '{"probeErr":"' + e + '"}'; } })()
        """
        webView.evaluateJavaScript(js) { [weak self] result, error in
            guard let self else { return }
            if let error = error {
                self.diag("error", ["msg": "boot-probe failed: \((error as NSError).localizedDescription)"])
                return
            }
            let state = (result as? String) ?? "nil"
            let booted = state.contains("\"booted\":true")
            let fallback = state.contains("\"fb\":true")
            let blank = state.contains("\"kids\":0") || state.contains("\"len\":0")
            self.diag(booted ? "boot" : "error", ["state": state])
            if booted || fallback {
                self.bootAttempts = 0        // healthy, or already showing the recovery UI
            } else if blank {
                self.recoverBlank()
            }
        }
    }

    // Escalating self-heal for a console that rendered nothing: reload once, then
    // a full data-store reset, then give up loudly so the log names the failure.
    private func recoverBlank() {
        bootAttempts += 1
        switch bootAttempts {
        case 1:
            diag("error", ["msg": "console blank after load — reloading (1/2)"])
            loadConsole()
            scheduleBootWatchdog()
        case 2:
            diag("error", ["msg": "console still blank — clearing WebView data store + reloading (2/2)"])
            resetConsole()
            DispatchQueue.main.asyncAfter(deadline: .now() + 2.0) { [weak self] in self?.scheduleBootWatchdog() }
        default:
            diag("error", ["msg": "console UNRECOVERABLE after \(bootAttempts) attempts — WebView is not rendering /dj"])
        }
    }

    // Re-check capture permissions when the user returns from System Settings.
    func windowDidBecomeKey(_ notification: Notification) {
        pushCapturePermission()
    }

    // JS -> Swift
    func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any], let action = body["action"] as? String else { return }
        switch action {
        case "quit":
            NSApp.terminate(nil)
        case "setLoginItem":
            setLoginItem(body["on"] as? Bool ?? false)
            pushLoginState()
        case "openURL":
            guard let raw = body["url"] as? String,
                  let url = URL(string: raw),
                  url.scheme == "https",
                  url.host == "partyparty.party",
                  ["/privacy", "/support"].contains(url.path) else { return }
            NSWorkspace.shared.open(url)
        case "captureSourceChanged":
            setCaptureSource(body["device"] as? String)
        case "resetConsole":
            resetConsole()
        case "jslog":
            let level = body["level"] as? String ?? "log"
            diag(level == "error" ? "error" : "console", ["lvl": level, "msg": body["msg"] as? String ?? ""])
        case "ready":
            pushLoginState()
            if let device = body["device"] as? String {
                setCaptureSource(device)
            } else {
                pushCapturePermission()
            }
        default:
            break
        }
    }

    private func setLoginItem(_ on: Bool) {
        do {
            if on {
                if SMAppService.mainApp.status != .enabled { try SMAppService.mainApp.register() }
            } else {
                if SMAppService.mainApp.status == .enabled { try SMAppService.mainApp.unregister() }
            }
        } catch {
            NSLog("partyparty: login-item toggle failed: \(error)")
        }
    }

    private func pushLoginState() {
        let enabled = SMAppService.mainApp.status == .enabled
        webView.evaluateJavaScript("window.ppSetLoginState && window.ppSetLoginState(\(enabled))")
    }

    private func setCaptureSource(_ device: String?) {
        capturePermissionKind = (device == "mac") ? .systemAudio : .microphone
        pushCapturePermission()
    }

    private func capturePermissionState(for kind: CapturePermissionKind) -> CapturePermissionState {
        switch kind {
        case .microphone:
            switch AVCaptureDevice.authorizationStatus(for: .audio) {
            case .authorized:
                return .granted
            case .denied, .restricted:
                return .denied
            case .notDetermined:
                return .undetermined
            @unknown default:
                return .undetermined
            }
        case .systemAudio:
            // Core Audio process taps prompt when the tap is created, but the SDK
            // exposes no status-only authorization API equivalent to AVFoundation's
            // microphone preflight. Do not claim success until capture proves it.
            return .undetermined
        }
    }

    private func pushCapturePermission() {
        let state = capturePermissionState(for: capturePermissionKind)
        let payload = [
            "state": state.rawValue,
            "kind": capturePermissionKind.rawValue,
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: payload),
              let json = String(data: data, encoding: .utf8) else { return }
        webView.evaluateJavaScript("""
        (function () {
          var payload = \(json);
          if (window.ppSetCapturePermission) {
            window.ppSetCapturePermission(payload);
          }
        })();
        """)
    }
}
