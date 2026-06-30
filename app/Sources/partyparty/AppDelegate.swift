import AppKit

/// Menu-bar app delegate. Agent-style at rest (no Dock icon); clicking the
/// menu-bar icon opens the DJ console window (Start-at-Login + Quit live inside
/// the console). Right-click gives a safety-net Quit. Supervises the Go server.
final class AppDelegate: NSObject, NSApplicationDelegate {
    private let server = ServerController()
    private let updater = Updater()          // background auto-update (when configured)
    private var statusItem: NSStatusItem!
    private var adminWindow: AdminWindowController?

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory) // menu-bar only, no Dock icon
        server.start()
        setupStatusItem()
    }

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
            // Safety-net Quit on right-click.
            let m = NSMenu()
            let q = NSMenuItem(title: "Quit \(appName)", action: #selector(quit), keyEquivalent: "q")
            q.target = self
            m.addItem(q)
            statusItem.menu = m
            sender.performClick(nil)
            statusItem.menu = nil
        } else {
            openConsole()
        }
    }

    @objc private func openConsole() {
        if adminWindow == nil {
            adminWindow = AdminWindowController(port: server.port) { [weak self] in self?.adminClosed() }
        }
        NSApp.setActivationPolicy(.regular) // Dock icon + key-window-able while open
        NSApp.activate(ignoringOtherApps: true)
        adminWindow?.showWindow(nil)
        adminWindow?.window?.makeKeyAndOrderFront(nil)
    }

    private func adminClosed() {
        adminWindow = nil
        NSApp.setActivationPolicy(.accessory) // back to menu-bar only
    }

    @objc private func quit() { NSApp.terminate(nil) }

    func applicationShouldTerminateAfterLastWindowClosed(_ app: NSApplication) -> Bool {
        false // closing the console keeps the menu-bar app alive
    }

    func applicationWillTerminate(_ notification: Notification) {
        server.stop()
    }
}
