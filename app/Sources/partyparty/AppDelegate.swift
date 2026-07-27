import AppKit
import ServiceManagement

/// Regular app (Dock icon + full window/menu bar). The menu-bar monitor exposes
/// the live controls a DJ needs without keeping the console window visible.
/// Supervises the Go server child.
final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    private let server = ServerController()
    private var api: APIClient!
    private var poller: StatusPoller!
    private var statusItem: NSStatusItem!
    private var console: AdminWindowController?

    func applicationDidFinishLaunching(_ notification: Notification) {
        server.start()
        NSApp.mainMenu = buildMainMenu()      // Cmd+W / Cmd+Q / copy-paste for the window
        api = APIClient(port: server.port)
        setupStatusItem()
        poller = StatusPoller(api: api)
        poller.onChange = { [weak self] s in
            self?.updateIcon(s)
        }
        poller.start()
        showConsole()                         // open the window on launch (regular-app behavior)
    }

    // MARK: Menu-bar monitor

    private func setupStatusItem() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        if let button = statusItem.button {
            button.title = "🕺"
            button.toolTip = appName
        }
        let menu = NSMenu()
        menu.delegate = self                  // rebuilt on open so status is fresh
        statusItem.menu = menu
    }

    /// Glanceable state in the menu bar: 🕺 idle · 🕺 ● N live · 🕺 ⚠ N strained ·
    /// 🕺 ⚠ error · 🕺 🔴 capture broken (red = guests hear nothing right now).
    private func updateIcon(_ s: ServerStatus) {
        guard let button = statusItem.button else { return }
        // A dead capture (hogged/stalled output) is the loudest alarm: guests
        // are getting silence while the DJ thinks it's fine.
        if s.captureBad && (s.state == "live" || s.state == "starting") {
            button.title = "🕺 🔴"
            button.toolTip = s.note.isEmpty
                ? "partyparty — audio capture problem; open the app for details"
                : "partyparty — \(s.note)"
            return
        }
        button.toolTip = appName
        switch s.state {
        case "live":
            let strained = (s.health == "strain" || s.health == "congested")
            button.title = strained ? "🕺 ⚠ \(s.listeners)" : "🕺 ● \(s.listeners)"
        case "starting": button.title = "🕺 …"
        case "error":    button.title = "🕺 ⚠"
        default:         button.title = "🕺"
        }
    }

    func menuNeedsUpdate(_ menu: NSMenu) {
        menu.removeAllItems()
        let s = poller.status

        let header: String
        switch s.state {
        case "live":
            var t = "Live"
            if s.struggling > 0 { t += " · \(s.struggling) buffering" }
            header = t
        case "starting": header = "Starting…"
        case "error":    header = "Broadcast error — open console"
        default:         header = "Not broadcasting"
        }
        let bundleVer = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "?"
        let ver = s.appVersion.isEmpty ? bundleVer : s.appVersion
        let h = NSMenuItem(title: header + "  ·  v" + ver, action: nil, keyEquivalent: "")
        h.isEnabled = false
        menu.addItem(h)

        let listenerLabel = s.listeners == 1 ? "1 listener" : "\(s.listeners) listeners"
        let listeners = NSMenuItem(title: listenerLabel, action: nil, keyEquivalent: "")
        listeners.isEnabled = false
        menu.addItem(listeners)

        let broadcasting = s.state == "live" || s.state == "starting"
        if broadcasting && s.captureBad {
            let capture = item("Audio capture: Problem — open console", #selector(showConsole))
            menu.addItem(capture)
        } else {
            let condition = broadcasting ? "Audio capture: Healthy" : "Audio capture: Not active"
            let capture = NSMenuItem(title: condition, action: nil, keyEquivalent: "")
            capture.isEnabled = false
            menu.addItem(capture)
        }
        if broadcasting && s.captureBad && !s.note.isEmpty {
            let detail = NSMenuItem(title: firstSentence(s.note), action: nil, keyEquivalent: "")
            detail.isEnabled = false
            menu.addItem(detail)
        }
        menu.addItem(.separator())

        let qr = item("Open Guest QR", #selector(showGuestQR))
        qr.isEnabled = !s.guestURL.isEmpty
        menu.addItem(qr)
        menu.addItem(item("Open Console", #selector(showConsole)))
        let stop = item("Stop Set", #selector(stopSet))
        stop.isEnabled = broadcasting
        menu.addItem(stop)
        menu.addItem(.separator())
        menu.addItem(item("Quit \(appName)", #selector(quit)))
    }

    /// First sentence of a note, capped, for the compact menu detail line.
    private func firstSentence(_ s: String) -> String {
        let cut = s.split(separator: "—", maxSplits: 1).first.map(String.init) ?? s
        let t = cut.trimmingCharacters(in: .whitespaces)
        return t.count > 90 ? String(t.prefix(88)) + "…" : t
    }

    private func item(_ title: String, _ sel: Selector) -> NSMenuItem {
        let i = NSMenuItem(title: title, action: sel, keyEquivalent: "")
        i.target = self
        return i
    }

    // MARK: Login item

    // MARK: Console window

    @objc private func showConsole() {
        if console == nil {
            console = AdminWindowController(port: server.port)
        }
        NSApp.activate(ignoringOtherApps: true)
        console?.showWindow(nil)
        console?.window?.makeKeyAndOrderFront(nil)
    }

    @objc private func showGuestQR() {
        if console == nil {
            console = AdminWindowController(port: server.port)
        }
        NSApp.activate(ignoringOtherApps: true)
        console?.showGuestQR()
    }

    @objc private func stopSet() {
        let s = poller.status
        guard s.state == "live" || s.state == "starting" else { return }
        api.stopBroadcast { [weak self] stopped in
            guard let self else { return }
            if stopped {
                self.poller.refresh()
                return
            }
            self.showConsole()
            let alert = NSAlert()
            alert.messageText = "Couldn’t stop the set"
            alert.informativeText = "Open the console and try End set again."
            alert.addButton(withTitle: "OK")
            alert.runModal()
        }
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag { showConsole() }
        return true
    }

    @objc private func quit() { NSApp.terminate(nil) }

    func applicationShouldTerminateAfterLastWindowClosed(_ app: NSApplication) -> Bool { false }
    func applicationWillTerminate(_ notification: Notification) {
        server.stop()
    }

    // MARK: Main menu (window shortcuts incl. Cmd+W, plus copy/paste in the web view)

    private func buildMainMenu() -> NSMenu {
        let main = NSMenu()

        let appItem = NSMenuItem()
        main.addItem(appItem)
        let appMenu = NSMenu()
        appItem.submenu = appMenu
        _ = appMenu.addItem(withTitle: "About \(appName)",
                            action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        _ = appMenu.addItem(withTitle: "Hide \(appName)", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(.separator())
        _ = appMenu.addItem(withTitle: "Quit \(appName)", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")

        let editItem = NSMenuItem(title: "Edit", action: nil, keyEquivalent: "")
        main.addItem(editItem)
        let edit = NSMenu(title: "Edit")
        editItem.submenu = edit
        _ = edit.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        _ = edit.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "Z")
        edit.addItem(.separator())
        _ = edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        _ = edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        _ = edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        _ = edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")

        let windowItem = NSMenuItem(title: "Window", action: nil, keyEquivalent: "")
        main.addItem(windowItem)
        let window = NSMenu(title: "Window")
        windowItem.submenu = window
        _ = window.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        _ = window.addItem(withTitle: "Close", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        NSApp.windowsMenu = window

        return main
    }
}
