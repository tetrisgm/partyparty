import AppKit
import ServiceManagement

/// Menu-bar app delegate: agent-style at rest (no Dock icon), flips to a regular
/// app while the admin window is open. The menu-bar icon opens a standard NSMenu.
/// Supervises the Go server child and wires Sparkle auto-update.
final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    private let server = ServerController()
    private let updater = Updater()
    private var statusItem: NSStatusItem!
    private var statusPoller: StatusPoller!
    private var adminWindow: AdminWindowController?

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory) // menu-bar only, no Dock icon
        server.start()
        statusPoller = StatusPoller(api: APIClient(port: server.port))
        setupStatusItem()
        statusPoller.start()
    }

    private func setupStatusItem() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        if let button = statusItem.button {
            button.title = "🕺"        // emoji icons render via the title, not a template image
            button.toolTip = appName
        }
        let menu = NSMenu()
        menu.delegate = self           // rebuilt on each open so status is current
        statusItem.menu = menu
    }

    // MARK: Menu (rebuilt each time it opens)

    func menuNeedsUpdate(_ menu: NSMenu) {
        menu.removeAllItems()

        let s = statusPoller.status
        let statusText: String
        switch s.state {
        case "live":     statusText = "● Live · \(s.listeners) listening"
        case "starting": statusText = "Starting…"
        case "error":    statusText = "Error"
        default:         statusText = "Idle"
        }
        addInfo(menu, statusText)
        menu.addItem(.separator())

        menu.addItem(action(menu, "Open DJ Console", #selector(openConsole), "o"))
        menu.addItem(.separator())

        let login = action(menu, "Start at Login", #selector(toggleLogin), "")
        login.state = (SMAppService.mainApp.status == .enabled) ? .on : .off
        menu.addItem(login)
        menu.addItem(.separator())

        addInfo(menu, "\(appName) \(appVersion)")
        menu.addItem(action(menu, "Check for Updates…", #selector(checkUpdates), ""))
        menu.addItem(action(menu, "Quit \(appName)", #selector(quit), "q"))
    }

    /// A disabled (grayed) informational row.
    private func addInfo(_ menu: NSMenu, _ title: String) {
        let i = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        i.isEnabled = false
        menu.addItem(i)
    }

    private func action(_ menu: NSMenu, _ title: String, _ sel: Selector, _ key: String) -> NSMenuItem {
        let i = NSMenuItem(title: title, action: sel, keyEquivalent: key)
        i.target = self
        return i
    }

    // MARK: Admin window (activation-policy hybrid)

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

    // MARK: Actions

    @objc private func checkUpdates() { updater.checkForUpdates() }

    @objc private func toggleLogin() {
        do {
            if SMAppService.mainApp.status == .enabled {
                try SMAppService.mainApp.unregister()
            } else {
                try SMAppService.mainApp.register()
            }
        } catch {
            NSLog("partyparty: login-item toggle failed: \(error)")
        }
    }

    @objc private func quit() { NSApp.terminate(nil) }

    // MARK: Lifecycle

    func applicationShouldTerminateAfterLastWindowClosed(_ app: NSApplication) -> Bool {
        false // closing the console keeps the menu-bar app alive
    }

    func applicationWillTerminate(_ notification: Notification) {
        server.stop()
    }
}
