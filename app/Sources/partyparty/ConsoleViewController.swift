import AppKit
import WebKit
import ServiceManagement

/// The DJ console hosted in a WKWebView, shown as an anchored menu-bar popover
/// (the SoundSource/Synology pattern). A "pp" JS↔Swift bridge lets the in-app
/// console toggle Start-at-Login and Quit the app.
final class ConsoleViewController: NSViewController, WKNavigationDelegate, WKScriptMessageHandler {
    private let port: Int
    private var webView: WKWebView!

    init(port: Int) { self.port = port; super.init(nibName: nil, bundle: nil) }
    required init?(coder: NSCoder) { fatalError("init(coder:) not supported") }

    override func loadView() {
        let cfg = WKWebViewConfiguration()
        cfg.websiteDataStore = .default() // persist localStorage prefs across launches
        let ucc = WKUserContentController()
        ucc.add(self, name: "pp")
        // Mark the page as in-app before its scripts run (reveals Start-at-Login + Quit).
        ucc.addUserScript(WKUserScript(source: "window.ppNative = true;",
                                       injectionTime: .atDocumentStart, forMainFrameOnly: true))
        cfg.userContentController = ucc

        webView = WKWebView(frame: NSRect(x: 0, y: 0, width: 520, height: 700), configuration: cfg)
        webView.navigationDelegate = self
        webView.allowsBackForwardNavigationGestures = false
        view = webView
        preferredContentSize = NSSize(width: 520, height: 700)
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        loadConsole()
    }

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
