import AppKit
import WebKit
import ServiceManagement

/// The DJ console as a real, resizable window hosting web/dj.html in a WKWebView.
/// A "pp" JS↔Swift bridge lets the in-app console toggle Start-at-Login and Quit.
final class AdminWindowController: NSWindowController, WKNavigationDelegate, WKScriptMessageHandler {
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
        super.init(window: win)

        let cfg = WKWebViewConfiguration()
        cfg.websiteDataStore = .default() // persist localStorage prefs across launches
        let ucc = WKUserContentController()
        ucc.add(self, name: "pp")
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
}
