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
    private var webView: WKWebView!

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
        case "ready":
            pushLoginState()
            pushScreenPermission()
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

    private func pushScreenPermission() {
        // Core Audio taps prompt inline on first Go Live (one-click Allow, like
        // microphone) — there's no preflight to check and no Settings dance, so
        // the console never needs to warn ahead of time.
        webView.evaluateJavaScript("window.ppSetScreenPermission && window.ppSetScreenPermission(true)")
    }
}
