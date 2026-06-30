import AppKit
import WebKit

/// The DJ admin presented as a native window hosting web/dj.html in a WKWebView
/// pointed at the local Go server. The DJ never sees a browser or a port.
final class AdminWindowController: NSWindowController, NSWindowDelegate, WKNavigationDelegate {
    private let port: Int
    private let onClose: () -> Void
    private var webView: WKWebView!

    init(port: Int, onClose: @escaping () -> Void) {
        self.port = port
        self.onClose = onClose
        let win = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1120, height: 780),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered, defer: false)
        win.title = "partyparty"
        win.center()
        win.setFrameAutosaveName("AdminWindow")
        win.minSize = NSSize(width: 720, height: 560)
        super.init(window: win)
        win.delegate = self

        let cfg = WKWebViewConfiguration()
        cfg.websiteDataStore = .default() // persist localStorage prefs across launches
        webView = WKWebView(frame: .zero, configuration: cfg)
        webView.navigationDelegate = self
        webView.allowsBackForwardNavigationGestures = false
        win.contentView = webView
        load()
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) not supported") }

    private func load() {
        // Use the hostname `localhost` (not 127.0.0.1) — ATS allows the exception
        // for localhost but blocks the literal IP.
        guard let url = URL(string: "http://localhost:\(port)/dj") else { return }
        webView.load(URLRequest(url: url))
    }

    // The Go server may still be coming up on first open — retry briefly.
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in self?.load() }
    }

    func windowWillClose(_ notification: Notification) { onClose() }
}
