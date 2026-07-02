import AppKit

/// Regular app (Dock icon + full window/menu bar). The menu-bar 🕺 is a glanceable
/// broadcast monitor + panic button — it does NOT duplicate the console: just live
/// status, Go Live/Stop, Open Console, Quit. Supervises the Go server child.
final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    private let server = ServerController()
    private let updater = Updater()          // background auto-update (when configured)
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
        poller.onChange = { [weak self] s in self?.updateIcon(s) }
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

    /// Glanceable state in the menu bar: 🕺 idle · 🕺 ● N live · 🕺 ⚠ N strained · 🕺 ⚠ error.
    private func updateIcon(_ s: ServerStatus) {
        guard let button = statusItem.button else { return }
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
            var t = "Live · \(s.listeners) listening"
            if s.struggling > 0 { t += " · \(s.struggling) buffering" }
            header = t
        case "starting": header = "Starting…"
        case "error":    header = "Broadcast error — open console"
        default:         header = "Not broadcasting"
        }
        let h = NSMenuItem(title: header, action: nil, keyEquivalent: "")
        h.isEnabled = false
        menu.addItem(h)
        menu.addItem(.separator())

        // No Stop here: a stray click in a menu would kill the whole party.
        // Stopping is a deliberate act — it lives in the console only.
        let live = (s.state == "live" || s.state == "starting")
        if !live {
            menu.addItem(item("Go Live (Mac audio)", #selector(goLive)))
        }
        menu.addItem(item("Open Console", #selector(showConsole)))
        menu.addItem(.separator())
        menu.addItem(item("Quit \(appName)", #selector(quit)))
    }

    private func item(_ title: String, _ sel: Selector) -> NSMenuItem {
        let i = NSMenuItem(title: title, action: sel, keyEquivalent: "")
        i.target = self
        return i
    }

    @objc private func goLive() {
        api.goLiveMac()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { [weak self] in self?.poller.refresh() }
    }

    // MARK: Console window

    @objc private func showConsole() {
        if console == nil { console = AdminWindowController(port: server.port) }
        NSApp.activate(ignoringOtherApps: true)
        console?.showWindow(nil)
        console?.window?.makeKeyAndOrderFront(nil)
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag { showConsole() }
        return true
    }

    @objc private func quit() { NSApp.terminate(nil) }

    func applicationShouldTerminateAfterLastWindowClosed(_ app: NSApplication) -> Bool { false }
    func applicationWillTerminate(_ notification: Notification) { server.stop() }

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
        _ = edit.addItem(withTitle: "Cut", action: Selector(("cut:")), keyEquivalent: "x")
        _ = edit.addItem(withTitle: "Copy", action: Selector(("copy:")), keyEquivalent: "c")
        _ = edit.addItem(withTitle: "Paste", action: Selector(("paste:")), keyEquivalent: "v")
        _ = edit.addItem(withTitle: "Select All", action: Selector(("selectAll:")), keyEquivalent: "a")

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
