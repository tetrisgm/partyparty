import AppKit
import WebKit
import ServiceManagement
import CoreGraphics

/// The DJ console as a real, resizable window hosting web/dj.html in a WKWebView.
/// A "pp" JS↔Swift bridge lets the in-app console toggle Start-at-Login and Quit.
final class AdminWindowController: NSWindowController, NSWindowDelegate, WKNavigationDelegate, WKScriptMessageHandler {
    private let port: Int
    private var webView: WKWebView!
    private let port80 = SMAppService.daemon(plistName: "net.ramine.partyparty.port80.plist")

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
        win.delegate = self

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
        pushScreenPermission()
        pushPortFreeState()
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
        case "setPortFree":
            setPortFree(body["on"] as? Bool ?? false)
        case "ready":
            pushLoginState()
            pushScreenPermission()
            pushPortFreeState()
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

    // Port-free guest URL: register/unregister the pf-redirect LaunchDaemon. macOS
    // shows a one-time background-item approval + admin password (no Touch ID for
    // Developer-ID apps). Toggling off SIGTERMs the daemon, which flushes its anchor.
    private func setPortFree(_ on: Bool) {
        do {
            if on {
                if port80.status != .enabled { try port80.register() }
                NSLog("partyparty: port80 register -> status=\(port80.status.rawValue)")
                if port80.status == .requiresApproval { SMAppService.openSystemSettingsLoginItems() }
            } else {
                if port80.status == .enabled { try port80.unregister() }
                NSLog("partyparty: port80 unregister -> status=\(port80.status.rawValue)")
            }
            pushPortFreeState()
        } catch {
            let ns = error as NSError
            NSLog("partyparty: port80 \(on ? "register" : "unregister") failed: \(ns) status=\(port80.status.rawValue)")
            // Un-notarized dev builds can't install a root daemon — surface that clearly.
            let msg = "\(ns.localizedDescription) [\(ns.domain) \(ns.code)]"
            webView.evaluateJavaScript("window.ppSetPortFreeError && window.ppSetPortFreeError(\(jsString(msg)))")
        }
    }

    private func pushPortFreeState() {
        let on = port80.status == .enabled
        let pending = port80.status == .requiresApproval
        webView.evaluateJavaScript("window.ppSetPortFree && window.ppSetPortFree(\(on), \(pending))")
    }

    private func jsString(_ s: String) -> String {
        let e = s.replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
            .replacingOccurrences(of: "\n", with: " ")
        return "\"\(e)\""
    }
}
