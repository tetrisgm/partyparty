import AppKit
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
    private let port: Int
    private let offlinePartyRequest: () -> Void
    private var webView: WKWebView!
    // Held strongly while the in-app cloud sign-in window is open.
    private var signInWC: SignInWindowController?

    init(port: Int, offlinePartyRequest: @escaping () -> Void = {}) {
        self.port = port
        self.offlinePartyRequest = offlinePartyRequest
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
        ucc.addUserScript(WKUserScript(source: "window.ppNative = true;",
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
        guard let url = URL(string: "http://localhost:\(port)/dj") else { return }
        webView.load(URLRequest(url: url))
    }

    // Retry while the Go server is still coming up.
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in self?.loadConsole() }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        pushLoginState()
        pushScreenPermission()
    }

    // Re-check Screen Recording when the user returns from System Settings.
    func windowDidBecomeKey(_ notification: Notification) {
        pushScreenPermission()
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
        case "enableOfflineParty":
            offlinePartyRequest()
        case "openSignIn":
            openSignIn(body["url"] as? String)
        case "ready":
            pushLoginState()
            pushScreenPermission()
        default:
            break
        }
    }

    /// Host the cloud sign-in / Mac-link flow in an in-app window (no browser
    /// bounce). `url` is the one-time install-link URL the Go server minted; when
    /// the bind lands, the sign-in window reports back and we drop the console's
    /// activation gate via a single fresh status re-check (no polling).
    private func openSignIn(_ urlString: String?) {
        guard let s = urlString, let url = URL(string: s), url.scheme == "https" else { return }
        signInWC?.close()
        let wc = SignInWindowController(
            url: url,
            onComplete: { [weak self] in
                self?.webView.evaluateJavaScript("window.ppAccountLinked && window.ppAccountLinked()")
            },
            onClose: { [weak self] closed in
                guard let self else { return }
                // Tell the console the sign-in window went away so it recovers if
                // the DJ closed it WITHOUT finishing. Skip after a real link — the
                // completion path already re-checked, and signalling again would
                // briefly re-flash the gate.
                if !closed.completed {
                    self.webView.evaluateJavaScript("window.ppSignInClosed && window.ppSignInClosed()")
                }
                // Drop our reference only if it's still THIS window — a reentrant
                // openSignIn may have already replaced it. Deferred so we never
                // release the controller from inside its own windowWillClose.
                DispatchQueue.main.async {
                    if self.signInWC === closed { self.signInWC = nil }
                }
            })
        signInWC = wc
        wc.present()
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

    private func pushScreenPermission() {
        // Core Audio taps prompt inline on first Go Live (one-click Allow, like
        // microphone) — there's no preflight to check and no Settings dance, so
        // the console never needs to warn ahead of time.
        webView.evaluateJavaScript("window.ppSetScreenPermission && window.ppSetScreenPermission(true)")
    }
}

/// Hosts the cloud sign-in / Mac-link flow at party.ramine.net IN-APP, replacing
/// the old bounce out to Safari. The Go server mints the same one-time,
/// install-scoped link token it always did (possession-proven — the secret never
/// enters this web view); the DJ signs in here and confirms the link, and when
/// the success page renders we report completion over the "pp" bridge so the
/// console drops its activation gate. No polling, no external browser.
final class SignInWindowController: NSWindowController, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
    private var webView: WKWebView!
    private let startURL: URL
    private let onComplete: () -> Void
    private let onClose: (SignInWindowController) -> Void
    private(set) var completed = false

    // A real desktop-Safari UA so Google/Apple OAuth run embedded instead of
    // refusing a WKWebView (same approach as the Write app's in-app sign-in).
    private static let safariUA =
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        + "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15"

    // documentEnd watcher: when the "Mac linked" success page renders (marked
    // with [data-pp-linked]), signal native. Native-injected so the page's CSP
    // can't block it, and a no-op on every other page / in a plain browser.
    private static let watchScript = """
    (function () {
      try {
        if (document.querySelector("[data-pp-linked]")) {
          window.webkit.messageHandlers.pp.postMessage({ action: "signInComplete" });
        }
      } catch (e) {}
    })();
    """

    init(url: URL, onComplete: @escaping () -> Void, onClose: @escaping (SignInWindowController) -> Void) {
        self.startURL = url
        self.onComplete = onComplete
        self.onClose = onClose
        let win = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 480, height: 720),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered, defer: false)
        win.title = "Sign in — \(appName)"
        win.center()
        win.minSize = NSSize(width: 420, height: 560)
        win.backgroundColor = NSColor(srgbRed: 0.961, green: 0.961, blue: 0.969, alpha: 1)
        super.init(window: win)
        win.delegate = self

        let cfg = WKWebViewConfiguration()
        cfg.websiteDataStore = .default() // persist the party.ramine.net session across launches
        let ucc = WKUserContentController()
        ucc.add(WeakScriptHandler(self), name: "pp")
        ucc.addUserScript(WKUserScript(source: Self.watchScript,
                                       injectionTime: .atDocumentEnd, forMainFrameOnly: true))
        cfg.userContentController = ucc

        webView = WKWebView(frame: .zero, configuration: cfg)
        webView.customUserAgent = Self.safariUA
        webView.navigationDelegate = self
        webView.uiDelegate = self
        win.contentView = webView
        webView.load(URLRequest(url: startURL))
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) not supported") }

    func present() {
        NSApp.activate(ignoringOtherApps: true)
        showWindow(nil)
        window?.makeKeyAndOrderFront(nil)
    }

    // Keep OAuth popups (target=_blank / window.open) in this same web view
    // rather than silently dropping them.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if navigationAction.targetFrame == nil, let url = navigationAction.request.url {
            webView.load(URLRequest(url: url))
        }
        return nil
    }

    // JS -> Swift: the success marker was seen.
    func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any],
              body["action"] as? String == "signInComplete" else { return }
        if completed { return }
        completed = true
        onComplete()
        DispatchQueue.main.async { [weak self] in self?.close() }
    }

    func windowWillClose(_ notification: Notification) {
        onClose(self)
    }
}
