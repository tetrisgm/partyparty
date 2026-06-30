import AppKit

/// Menu-bar app delegate: agent-style at rest (no Dock icon), flips to a regular
/// app while the admin window is open. Supervises the Go server child.
final class AppDelegate: NSObject, NSApplicationDelegate {
    private let server = ServerController()
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
            let img = NSImage(systemSymbolName: "dot.radiowaves.left.and.right",
                              accessibilityDescription: "partyparty")
            img?.isTemplate = true
            button.image = img
        }
        let menu = NSMenu()
        menu.addItem(withTitle: "Open DJ Console", action: #selector(openConsole), keyEquivalent: "o")
        menu.addItem(.separator())
        menu.addItem(withTitle: "Quit partyparty", action: #selector(quit), keyEquivalent: "q")
        for item in menu.items where item.action != nil { item.target = self }
        statusItem.menu = menu
    }

    @objc private func openConsole() {
        if adminWindow == nil {
            adminWindow = AdminWindowController(port: server.port) { [weak self] in
                self?.adminClosed()
            }
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
