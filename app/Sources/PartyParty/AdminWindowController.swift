import AppKit
import AVFoundation
import CoreAudio
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
final class AdminWindowController: NSWindowController, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
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
        // No standard title bar: the bar keeps its height (so the traffic
        // lights sit in a real, draggable strip) but goes transparent over the
        // console's own dark - one surface from the top edge down.
        win.titlebarAppearsTransparent = true
        win.titleVisibility = .hidden
        win.backgroundColor = NSColor(srgbRed: 0.055, green: 0.055, blue: 0.063, alpha: 1) // --bg #0e0e10
        super.init(window: win)
        win.delegate = self

        let cfg = WKWebViewConfiguration()
        cfg.websiteDataStore = .default() // persist localStorage prefs across launches
        let ucc = WKUserContentController()
        // WKUserContentController retains its handler STRONGLY - adding self
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
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = false
        win.contentView = webView
        loadConsole()
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) not supported") }

    private func loadConsole() {
        // Numeric loopback, NOT "localhost": on some Macs `localhost` resolves to
        // an address the WebView can't reach (a broken /etc/hosts or a dead IPv6
        // ::1), which loads as a blank page and - because the diagnostics below
        // also posted to localhost - reported nothing. 127.0.0.1 needs no DNS and
        // always hits the server's IPv4 listener. THIS is the field white-screen.
        guard let url = URL(string: "http://127.0.0.1:\(port)/dj") else { return }
        webView.load(URLRequest(url: url))
    }

    /// Clear the console's persisted web state (localStorage + caches) and reload.
    /// The page's boot fallback calls this when init failed - most often a stale
    /// saved value poisoning startup - so a clean-slate reload is the reliable
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
    /// broker) via the local /api/client-events sink - the same black-box
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
        diag("error", ["msg": "provisional nav failed: \(ns.domain) \(ns.code) - \(ns.localizedDescription)"])
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in self?.loadConsole() }
    }

    // A load that started then failed - retry the same way.
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        let ns = error as NSError
        diag("error", ["msg": "nav failed: \(ns.domain) \(ns.code) - \(ns.localizedDescription)"])
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in self?.loadConsole() }
    }

    // The WebContent process crashed (rare, but leaves a permanent white view) -
    // reload instead of sitting blank.
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        diag("error", ["msg": "WebContent process terminated (crash) - reloading"])
        loadConsole()
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        pushLoginState()
        pushCapturePermission()
        if pendingGuestQR { revealGuestQR() }
        scheduleBootWatchdog()
    }

    func webView(
        _ webView: WKWebView,
        runOpenPanelWith parameters: WKOpenPanelParameters,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping ([URL]?) -> Void
    ) {
        guard let window else {
            completionHandler(nil)
            return
        }

        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canCreateDirectories = false
        panel.beginSheetModal(for: window) { response in
            completionHandler(response == .OK ? panel.urls : nil)
        }
    }

    func showGuestQR() {
        pendingGuestQR = true
        showWindow(nil)
        window?.makeKeyAndOrderFront(nil)
        revealGuestQR()
    }

    /// The menu-bar Go live hits the same nameless-party gate as the console
    /// button: open the title editor so the DJ names it first.
    func openTitleEditor() {
        webView.evaluateJavaScript("window.ppOpenTitleEditor && window.ppOpenTitleEditor()")
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
          data: !!window.__ppDataSeen,
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
            let sawData = state.contains("\"data\":true")
            let fallback = state.contains("\"fb\":true")
            let blank = state.contains("\"kids\":0") || state.contains("\"len\":0")
            self.diag(booted ? "boot" : "error", ["state": state])
            if fallback {
                self.bootAttempts = 0        // already showing the recovery UI
            } else if booted && sawData {
                self.bootAttempts = 0        // rendered a real answer from the server
            } else if blank || (booted && !sawData) {
                // Booted-but-dataless is the failure this missed for months: the
                // shell renders, __ppBooted is true, and every fetch quietly
                // failed - typically the WebView beating the local server up on
                // a relaunch. It looks like a first-run console with the party
                // name, QR and profile all gone, and nothing ever fixed it.
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
            diag("error", ["msg": "console blank after load - reloading (1/2)"])
            loadConsole()
            scheduleBootWatchdog()
        case 2:
            diag("error", ["msg": "console still blank - clearing WebView data store + reloading (2/2)"])
            resetConsole()
            DispatchQueue.main.asyncAfter(deadline: .now() + 2.0) { [weak self] in self?.scheduleBootWatchdog() }
        default:
            diag("error", ["msg": "console UNRECOVERABLE after \(bootAttempts) attempts - WebView is not rendering /dj"])
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
                  Self.opensInTheBrowser(url.path) else { return }
            NSWorkspace.shared.open(url)
        case "captureSourceChanged":
            setCaptureSource(body["device"] as? String)
        case "primeSystemAudio":
            primeSystemAudio()
        case "permissions":
            pushPermissions()
        case "resetConsole":
            resetConsole()
        case "jslog":
            let level = body["level"] as? String ?? "log"
            diag(level == "error" ? "error" : "console", ["lvl": level, "msg": body["msg"] as? String ?? ""])
        case "ready":
            pushLoginState()
            pushPermissions()
            if let device = body["device"] as? String {
                setCaptureSource(device)
            } else {
                pushCapturePermission()
            }
        default:
            break
        }
    }

    /// Which of our own pages the console may hand to the real browser.
    ///
    /// Signing in is the reason this exists at all: the console opens
    /// /link/<code> in Safari, the DJ presses one button there, and this Mac
    /// belongs to their account. That path was not on the list, so the request
    /// was dropped in silence while the console said "finish in the browser" -
    /// a browser that never opened. Still an allowlist, and still our host
    /// only: this is a web page asking the app to launch a URL.
    static func opensInTheBrowser(_ path: String) -> Bool {
        if ["/privacy", "/support", "/home", "/people"].contains(path) { return true }
        // /link/<code>: the one-time pairing link. Six upper-case alphanumerics,
        // the same shape the platform's own route matches.
        if path.hasPrefix("/link/") {
            let code = path.dropFirst("/link/".count)
            return code.count == 6 && code.allSatisfy { $0.isUppercase || $0.isNumber }
        }
        // /@handle/... - where a Mac that is already linked is sent instead.
        if path.hasPrefix("/@") {
            let rest = path.dropFirst(2)
            return !rest.isEmpty && !rest.contains("..") &&
                rest.allSatisfy { $0.isLowercase || $0.isNumber || $0 == "/" || $0 == "-" }
        }
        return false
    }

    /// window.open from the console goes nowhere unless this exists.
    ///
    /// WKWebView routes it here, and a WKUIDelegate that does not implement the
    /// method simply returns nil - no window, no error, no console message. The
    /// sign-in button called window.open and looked, from the page's side, like
    /// it had worked. Anything targeted out of the console now goes to the real
    /// browser, which is the only place it could have meant.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction,
                 windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url,
           url.scheme == "https" || url.scheme == "http" {
            NSWorkspace.shared.open(url)
        }
        return nil
    }

    private func setLoginItem(_ on: Bool) {
        do {
            if on {
                if SMAppService.mainApp.status != .enabled { try SMAppService.mainApp.register() }
            } else {
                if SMAppService.mainApp.status == .enabled { try SMAppService.mainApp.unregister() }
            }
        } catch {
            NSLog("PartyParty: login-item toggle failed: \(error)")
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
            // The SDK exposes no status-only authorization API for system audio,
            // and a SANDBOXED process's tap never raises the prompt on its own -
            // it silently delivers nothing (proven 2026-08-05: fresh TCC state,
            // helper tap ran with zero device cycles, no AUTHREQ ever reached
            // tccd). The only signal we own is the outcome of our explicit
            // priming request at Go Live.
            return systemAudioPrimeState
        }
    }

    // primeSystemAudio: the app itself creates a momentary process tap so the
    // System Audio Recording prompt appears attributed to "PartyParty" BEFORE
    // the capture helper starts. The helper's own tap cannot prompt (sandboxed,
    // silent no-op without a grant), so without this a fresh Mac goes live and
    // streams silence with no dialog ever shown.
    private var systemAudioPrimeState: CapturePermissionState = .undetermined
    private func primeSystemAudio() {
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            var tapID = AudioObjectID(kAudioObjectUnknown)
            let desc = CATapDescription(stereoGlobalTapButExcludeProcesses: [])
            let err = AudioHardwareCreateProcessTap(desc, &tapID)
            if tapID != AudioObjectID(kAudioObjectUnknown) {
                AudioHardwareDestroyProcessTap(tapID)
            }
            DispatchQueue.main.async {
                self?.systemAudioPrimeState = (err == noErr) ? .granted : .denied
                self?.pushCapturePermission()
                self?.pushPermissions()
                self?.webView.evaluateJavaScript(
                    "window.ppSystemAudioPrimed && window.ppSystemAudioPrimed(\(err == noErr))")
            }
        }
    }

    /// The Settings permissions block. Each row must be honest about what macOS
    /// actually lets an app know:
    ///  - microphone: a real status API.
    ///  - system audio: NO status API. Truth comes from observation (capture has
    ///    worked here) or from an explicit tap attempt, which is why the row
    ///    offers a Check that prompts rather than a status that guesses.
    ///  - local network: no API and no probe. The pane is all we can offer.
    private func pushPermissions() {
        let mic: String
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized: mic = "granted"
        case .denied, .restricted: mic = "denied"
        default: mic = "undetermined"
        }
        let payload: [String: Any] = [
            "microphone": mic,
            "systemAudio": systemAudioPrimeState.rawValue,
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: payload),
              let json = String(data: data, encoding: .utf8) else { return }
        webView.evaluateJavaScript("window.ppSetPermissions && window.ppSetPermissions(\(json))")
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
