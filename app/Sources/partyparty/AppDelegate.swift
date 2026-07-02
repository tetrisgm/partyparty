import AppKit
import ServiceManagement

/// Regular app (Dock icon + full window/menu bar). The menu-bar 🕺 is a glanceable
/// broadcast monitor — it does NOT duplicate the console: just live status,
/// Open Console, Quit. Supervises the Go server child.
final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    private let server = ServerController()
    private var updater: Updater!            // created AFTER the move check — Sparkle must
                                             // never download into a translocated/Downloads copy
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

        updater = Updater()                   // background auto-update
        server.start()
        registerLoginItemByDefault()
        NSApp.mainMenu = buildMainMenu()      // Cmd+W / Cmd+Q / copy-paste for the window
        api = APIClient(port: server.port)
        setupStatusItem()
        poller = StatusPoller(api: api)
        poller.onChange = { [weak self] s in self?.updateIcon(s) }
        poller.start()
        showConsole()                         // open the window on launch (regular-app behavior)
    }

    // MARK: Self-install (move to /Applications)

    /// True when running from /Applications or ~/Applications — an INSTALLED
    /// copy, as opposed to ~/Downloads (or a ~/Downloads/Applications decoy).
    private var isInstalled: Bool {
        let path = Bundle.main.bundleURL.path
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        return path.hasPrefix("/Applications/") || path.hasPrefix(home + "/Applications/")
    }

    /// Returns true when a move+relaunch is underway and this instance should
    /// do nothing further. `interactive` = invoked from a menu action (always
    /// prompt); otherwise it's the launch check (skippable only in dev).
    @discardableResult
    private func moveToApplicationsIfNeeded(interactive: Bool = false) -> Bool {
        let src = Bundle.main.bundleURL
        if isInstalled { return false }
        // Dev escape hatch is an ENV var only — never a persisted default, which
        // would stick on a real install and silently defeat the move (it did).
        if !interactive && ProcessInfo.processInfo.environment["PP_DEV_NO_MOVE"] == "1" { return false }

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
            NSWorkspace.shared.openApplication(at: dest, configuration: cfg) { app, err in
                DispatchQueue.main.async {
                    // Only hand over if the new copy actually launched —
                    // terminating blindly could leave the user with NOTHING.
                    if app != nil { NSApp.terminate(nil); return }
                    let e = NSAlert()
                    e.messageText = "Couldn't relaunch from Applications"
                    e.informativeText = (err?.localizedDescription ?? "Unknown error")
                        + "\n\nThe copy IS in Applications — open it from there when you're ready."
                    e.runModal()
                    NSApp.terminate(nil) // this instance did no setup; don't linger half-alive
                }
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

        // No Go Live / Stop here: starting or killing the party is a deliberate
        // act — both live in the console only. The menu bar just monitors.
        menu.addItem(item("Open Console", #selector(showConsole)))
        menu.addItem(.separator())
        menu.addItem(item("Check for Updates…", #selector(checkUpdates)))
        menu.addItem(item("Quit \(appName)", #selector(quit)))
    }

    @objc private func checkUpdates() {
        NSApp.activate(ignoringOtherApps: true)   // Sparkle's alert needs a frontmost app
        // Sparkle can't update an app running from Downloads/a translocated
        // mount. Rather than dead-end with that error, offer the move first —
        // it relaunches from /Applications, where the update just works.
        if !isInstalled {
            if moveToApplicationsIfNeeded(interactive: true) { return } // relaunching
        }
        updater.checkForUpdates()
    }

    private func item(_ title: String, _ sel: Selector) -> NSMenuItem {
        let i = NSMenuItem(title: title, action: sel, keyEquivalent: "")
        i.target = self
        return i
    }

    // MARK: Login item

    /// A party app should just BE there next time the Mac starts — enable
    /// start-at-login once, by default (no password, no dialog; SMAppService
    /// shows it under System Settings → General → Login Items). The console's
    /// "Start partyparty at login" toggle is the opt-OUT, and because this
    /// runs only once, a user who turns it off STAYS off.
    private func registerLoginItemByDefault() {
        let applied = "PPLoginItemDefaultApplied"
        let d = UserDefaults.standard
        guard !d.bool(forKey: applied) else { return }
        // Only from an installed home — a dev build in ~/dev shouldn't enroll.
        guard isInstalled else { return }
        if SMAppService.mainApp.status == .enabled {
            d.set(true, forKey: applied) // already on (pkg postinstall era, or manual)
            return
        }
        do {
            try SMAppService.mainApp.register()
            d.set(true, forKey: applied) // flag only after SUCCESS — a transient
            // SMAppService failure retries next launch instead of losing the default
        } catch {
            NSLog("partyparty: login-item default enroll failed (will retry next launch): \(error)")
        }
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
