import AppKit

/// Menu-bar app delegate. Pure agent (no Dock icon). Clicking the menu-bar icon
/// toggles the DJ console as an anchored popover; right-click gives a safety-net
/// Quit. Supervises the Go server child.
final class AppDelegate: NSObject, NSApplicationDelegate {
    private let server = ServerController()
    private let updater = Updater()          // background auto-update (when configured)
    private var statusItem: NSStatusItem!
    private var popover: NSPopover?

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
            toggleConsole(sender)
        }
    }

    private func toggleConsole(_ button: NSStatusBarButton) {
        if popover == nil {
            let pop = NSPopover()
            pop.behavior = .transient            // closes on Escape / click-away
            pop.contentViewController = ConsoleViewController(port: server.port)
            popover = pop
        }
        guard let pop = popover, !pop.isShown else { return }
        NSApp.activate(ignoringOtherApps: true)  // so web controls get clicks/keys (stays dockless)
        pop.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
    }

    @objc private func quit() { NSApp.terminate(nil) }

    // A closing popover must not quit the app.
    func applicationShouldTerminateAfterLastWindowClosed(_ app: NSApplication) -> Bool { false }

    func applicationWillTerminate(_ notification: Notification) {
        server.stop()
    }
}
