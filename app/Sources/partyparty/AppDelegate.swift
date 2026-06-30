import AppKit

/// Regular app (Dock icon) + a menu-bar icon. The console is a real resizable
/// window with a standard menu bar (Cmd+W / Cmd+Q / copy-paste). Supervises the
/// Go server child.
final class AppDelegate: NSObject, NSApplicationDelegate {
    private let server = ServerController()
    private let updater = Updater()          // background auto-update (when configured)
    private var statusItem: NSStatusItem!
    private var console: AdminWindowController?

    func applicationDidFinishLaunching(_ notification: Notification) {
        server.start()
        NSApp.mainMenu = buildMainMenu()      // gives Cmd+W, Cmd+Q, copy/paste, etc.
        setupStatusItem()
        showConsole()                         // open the window on launch (regular-app behavior)
    }

    // MARK: Menu-bar icon

    private func setupStatusItem() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        if let button = statusItem.button {
            button.title = "🕺"
            button.toolTip = appName
            button.action = #selector(iconClicked(_:))
            button.target = self
            button.sendAction(on: [.leftMouseUp, .rightMouseUp])
        }
    }

    @objc private func iconClicked(_ sender: NSStatusBarButton) {
        if NSApp.currentEvent?.type == .rightMouseUp {
            let m = NSMenu()
            let q = NSMenuItem(title: "Quit \(appName)", action: #selector(quit), keyEquivalent: "q")
            q.target = self
            m.addItem(q)
            statusItem.menu = m
            sender.performClick(nil)
            statusItem.menu = nil
        } else {
            showConsole()
        }
    }

    // MARK: Console window

    @objc private func showConsole() {
        if console == nil { console = AdminWindowController(port: server.port) }
        NSApp.activate(ignoringOtherApps: true)
        console?.showWindow(nil)
        console?.window?.makeKeyAndOrderFront(nil)
    }

    // Reopen the window when the Dock icon is clicked with no window open.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag { showConsole() }
        return true
    }

    @objc private func quit() { NSApp.terminate(nil) }

    // Closing the console window keeps the app alive (menu-bar + Dock); Cmd+Q quits.
    func applicationShouldTerminateAfterLastWindowClosed(_ app: NSApplication) -> Bool { false }

    func applicationWillTerminate(_ notification: Notification) {
        server.stop()
    }

    // MARK: Main menu (standard shortcuts incl. Cmd+W close, Cmd+C/V in the web view)

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
