import AppKit
import Network
import ServiceManagement

/// Regular app (Dock icon + full window/menu bar). The menu-bar monitor exposes
/// the live controls a DJ needs without keeping the console window visible.
/// Supervises the Go server child.
final class AppDelegate: NSObject, NSApplicationDelegate {
    private let server = ServerController()
    private var api: APIClient!
    private var poller: StatusPoller!
    private var statusItem: NSStatusItem!
    private var console: AdminWindowController?
    private var updater: Updater!
    private var localNetworkBrowser: NWBrowser?
    private var wasBroadcasting = false
    private var lastUpdateCheck = Date.distantPast
    private let popover = NSPopover()
    private let popoverContent = StatusPopoverController()

    func applicationDidFinishLaunching(_ notification: Notification) {
        requestLocalNetworkAccess()
        server.start()
        NSApp.mainMenu = buildMainMenu()      // Cmd+W / Cmd+Q / copy-paste for the window
        api = APIClient(port: server.port)
        updater = Updater { [weak self] in
            guard let self else { return false }
            let state = self.poller?.status.state ?? ""
            return state == "live" || state == "starting"
        }
        setupStatusItem()
        poller = StatusPoller(api: api)
        poller.onChange = { [weak self] s in
            guard let self else { return }
            self.updateIcon(s)
            if self.popover.isShown { self.popoverContent.render(s) }
            let broadcasting = s.state == "live" || s.state == "starting"
            if self.wasBroadcasting && !broadcasting {
                self.updater.broadcastDidEnd()
            }
            self.wasBroadcasting = broadcasting
        }
        poller.start()
        showConsole()                         // open the window on launch (regular-app behavior)
    }

    private func requestLocalNetworkAccess() {
        let browser = NWBrowser(
            for: .bonjour(type: "_partyparty._tcp", domain: "local."),
            using: .tcp
        )
        browser.stateUpdateHandler = { state in
            if case .failed = state {
                browser.cancel()
            }
        }
        browser.browseResultsChangedHandler = { _, _ in }
        browser.start(queue: .main)
        localNetworkBrowser = browser
    }

    // MARK: Menu-bar monitor

    private func setupStatusItem() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        if let button = statusItem.button {
            button.title = "🕺"
            button.toolTip = appName
            button.target = self
            button.action = #selector(statusItemClicked)
            button.sendAction(on: [.leftMouseUp, .rightMouseUp])
        }
        popover.behavior = .transient
        popover.contentViewController = popoverContent
        popoverContent.onToggleBroadcast = { [weak self] in self?.toggleBroadcast() }
        popoverContent.onOpenApp = { [weak self] in
            self?.popover.performClose(nil)
            self?.showConsole()
        }
        popoverContent.onQuit = { NSApp.terminate(nil) }
    }

    /// Left click: the little QR window. Right click: the safety menu (Open,
    /// Quit) so the app is never uncloseable if the popover misbehaves.
    @objc private func statusItemClicked() {
        guard let button = statusItem.button else { return }
        if NSApp.currentEvent?.type == .rightMouseUp {
            let menu = NSMenu()
            menu.addItem(item("Open \(appName)", #selector(showConsoleFromMenu)))
#if STANDALONE
            menu.addItem(item("Check for Updates…", #selector(checkForUpdates)))
#endif
            menu.addItem(.separator())
            menu.addItem(item("Quit \(appName)", #selector(quit)))
            statusItem.menu = menu            // let the system run the menu loop
            button.performClick(nil)
            statusItem.menu = nil             // back to popover on plain clicks
            return
        }
        if popover.isShown {
            popover.performClose(nil)
        } else {
            popoverContent.render(poller.status)
            popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
            popover.contentViewController?.view.window?.makeKey()
        }
    }

    /// The same behavior as the console's Go live button: stop immediately when
    /// broadcasting; refuse to start a nameless party and open the title editor
    /// instead; otherwise start and surface any server error in the console.
    private func toggleBroadcast() {
        let s = poller.status
        if s.state == "live" || s.state == "starting" {
            stopSet()
            return
        }
        if s.eventTitle.trimmingCharacters(in: .whitespaces).isEmpty {
            popover.performClose(nil)
            showConsole()
            console?.openTitleEditor()
            return
        }
        api.startBroadcast { [weak self] ok, message in
            guard let self else { return }
            self.poller.refresh()
            if !ok {
                self.popover.performClose(nil)
                self.showConsole()
                let alert = NSAlert()
                alert.messageText = "Couldn’t go live"
                alert.informativeText = message.isEmpty ? "Open the console and try Go live there." : message
                alert.addButton(withTitle: "OK")
                alert.runModal()
            }
        }
    }

    @objc private func showConsoleFromMenu() { showConsole() }

    /// Glanceable state in the menu bar: 🕺 idle · 🕺 ●N live (pink dot) ·
    /// 🕺 ⚠ N strained · 🕺 ⚠ error · 🕺 🔴 capture broken (red = guests hear
    /// nothing right now).
    private func updateIcon(_ s: ServerStatus) {
        guard let button = statusItem.button else { return }
        // A dead capture (hogged/stalled output) is the loudest alarm: guests
        // are getting silence while the DJ thinks it's fine.
        if s.captureBad && (s.state == "live" || s.state == "starting") {
            button.attributedTitle = NSAttributedString(string: "🕺 🔴")
            button.toolTip = s.note.isEmpty
                ? "PartyParty - audio capture problem; open the app for details"
                : "PartyParty - \(s.note)"
            return
        }
        button.toolTip = appName
        switch s.state {
        case "live":
            if s.health == "strain" || s.health == "congested" {
                button.attributedTitle = NSAttributedString(string: "🕺 ⚠ \(s.listeners)")
            } else {
                button.attributedTitle = Self.liveTitle(listeners: s.listeners)
            }
        case "starting": button.attributedTitle = NSAttributedString(string: "🕺 …")
        case "error":    button.attributedTitle = NSAttributedString(string: "🕺 ⚠")
        default:         button.attributedTitle = NSAttributedString(string: "🕺")
        }
    }

    /// "🕺 ●3" with the dot in brand pink: the streaming indicator beside the
    /// dancer, so live vs idle reads at a glance.
    private static func liveTitle(listeners: Int) -> NSAttributedString {
        let t = NSMutableAttributedString(string: "🕺 ")
        t.append(NSAttributedString(string: "●", attributes: [
            .foregroundColor: NSColor(srgbRed: 1.0, green: 0.176, blue: 0.435, alpha: 1),
        ]))
        t.append(NSAttributedString(string: " \(listeners)"))
        return t
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

    @objc private func checkForUpdates() {
        updater.checkForUpdates()
    }

    func applicationDidBecomeActive(_ notification: Notification) {
        guard Date().timeIntervalSince(lastUpdateCheck) >= 300 else { return }
        lastUpdateCheck = Date()
        updater?.checkInBackground()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ app: NSApplication) -> Bool { false }
    func applicationWillTerminate(_ notification: Notification) {
        localNetworkBrowser?.cancel()
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
                            action: #selector(showAbout), keyEquivalent: "")
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

    @objc private func showAbout() {
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? ""
        NSApp.orderFrontStandardAboutPanel(options: [
            .applicationVersion: version,
            .version: "",
        ])
    }
}
