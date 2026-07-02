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
        // Before ANYTHING (especially the server child): offer to relocate to
        // /Applications. Running from ~/Downloads breaks Sparkle updates and
        // triggers Gatekeeper app-translocation; one click here fixes both
        // forever (the LetsMove pattern).
        if moveToApplicationsIfNeeded() { return } // relaunching from the new home

        server.start()
        NSApp.mainMenu = buildMainMenu()      // Cmd+W / Cmd+Q / copy-paste for the window
        api = APIClient(port: server.port)
        setupStatusItem()
        poller = StatusPoller(api: api)
        poller.onChange = { [weak self] s in self?.updateIcon(s) }
        poller.start()
        showConsole()                         // open the window on launch (regular-app behavior)
    }

    // MARK: Self-install (move to /Applications)

    /// Returns true when a move+relaunch is underway and this instance should
    /// do nothing further.
    private func moveToApplicationsIfNeeded() -> Bool {
        let src = Bundle.main.bundleURL
        if src.path.contains("/Applications/") { return false } // /Applications or ~/Applications
        if UserDefaults.standard.bool(forKey: "PPSkipMove") { return false } // dev escape hatch

        let fm = FileManager.default
        var destDir = URL(fileURLWithPath: "/Applications", isDirectory: true)
        if !fm.isWritableFile(atPath: destDir.path) {
            // Non-admin account: fall back to the per-user Applications folder.
            destDir = fm.homeDirectoryForCurrentUser.appendingPathComponent("Applications", isDirectory: true)
            try? fm.createDirectory(at: destDir, withIntermediateDirectories: true)
        }
        let dest = destDir.appendingPathComponent(src.lastPathComponent)

        NSApp.activate(ignoringOtherApps: true)
        let alert = NSAlert()
        alert.messageText = "Move \(appName) to the Applications folder?"
        alert.informativeText = "It'll relaunch from there — updates and permissions work best that way. Takes a second, nothing to drag."
        alert.addButton(withTitle: "Move to Applications")
        alert.addButton(withTitle: "Not Now")
        guard alert.runModal() == .alertFirstButtonReturn else { return false }

        do {
            if fm.fileExists(atPath: dest.path) { try fm.removeItem(at: dest) }
            try fm.copyItem(at: src, to: dest) // works even from a translocated (read-only) mount
            // Strip quarantine on the new copy: the user already approved the
            // Gatekeeper first-open, and without this a programmatic move (as
            // opposed to a Finder drag) would still be app-translocated.
            let xattr = Process()
            xattr.executableURL = URL(fileURLWithPath: "/usr/bin/xattr")
            xattr.arguments = ["-dr", "com.apple.quarantine", dest.path]
            try? xattr.run(); xattr.waitUntilExit()

            let cfg = NSWorkspace.OpenConfiguration()
            cfg.createsNewApplicationInstance = true
            NSWorkspace.shared.openApplication(at: dest, configuration: cfg) { _, _ in
                DispatchQueue.main.async { NSApp.terminate(nil) }
            }
            return true
        } catch {
            let e = NSAlert()
            e.messageText = "Couldn't move \(appName)"
            e.informativeText = "\(error.localizedDescription)\n\nYou can drag it to Applications yourself — it'll keep working from here meanwhile."
            e.runModal()
            return false
        }
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
        let ver = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "?"
        let h = NSMenuItem(title: header + "  ·  v" + ver, action: nil, keyEquivalent: "")
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
        menu.addItem(item("Check for Updates…", #selector(checkUpdates)))
        menu.addItem(item("Quit \(appName)", #selector(quit)))
    }

    @objc private func checkUpdates() {
        NSApp.activate(ignoringOtherApps: true)   // Sparkle's alert needs a frontmost app
        updater.checkForUpdates()
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
