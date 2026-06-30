import AppKit
import SwiftUI
import ServiceManagement

/// Menu-bar app delegate: agent-style at rest (no Dock icon), flips to a regular
/// app while the admin window is open. Left-click = status popover; right-click =
/// menu. Supervises the Go server child and wires Sparkle auto-update.
final class AppDelegate: NSObject, NSApplicationDelegate {
    private let server = ServerController()
    private let updater = Updater()
    private var statusItem: NSStatusItem!
    private var popover: NSPopover!
    private var statusModel: StatusModel!
    private var adminWindow: AdminWindowController?

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory) // menu-bar only, no Dock icon
        server.start()

        let api = APIClient(port: server.port)
        statusModel = StatusModel(api: api)
        statusModel.onOpenConsole = { [weak self] in self?.openConsole() }
        statusModel.onCheckUpdates = { [weak self] in self?.updater.checkForUpdates() }

        setupStatusItem()
        statusModel.startPolling()
    }

    // MARK: Status item (left-click popover / right-click menu)

    private func setupStatusItem() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        if let button = statusItem.button {
            button.title = "🕺"            // emoji icons render via the title, not a template image
            button.toolTip = "partyparty"
            button.action = #selector(statusClicked(_:))
            button.target = self
            button.sendAction(on: [.leftMouseUp, .rightMouseUp])
        }
        popover = NSPopover()
        popover.behavior = .transient
        popover.contentViewController = NSHostingController(rootView: StatusView(model: statusModel))
    }

    @objc private func statusClicked(_ sender: NSStatusBarButton) {
        if NSApp.currentEvent?.type == .rightMouseUp {
            showMenu(sender)
        } else {
            togglePopover(sender)
        }
    }

    private func togglePopover(_ sender: NSStatusBarButton) {
        if popover.isShown {
            popover.performClose(nil)
            return
        }
        statusModel.refresh()
        // Accessory apps need to be active for SwiftUI controls in the popover to
        // receive clicks; activating doesn't show a Dock icon.
        NSApp.activate(ignoringOtherApps: true)
        popover.show(relativeTo: sender.bounds, of: sender, preferredEdge: .minY)
    }

    private func showMenu(_ sender: NSStatusBarButton) {
        let menu = NSMenu()
        menu.addItem(withTitle: "Open DJ Console", action: #selector(openConsole), keyEquivalent: "o")
        menu.addItem(withTitle: "Check for Updates…", action: #selector(checkUpdates), keyEquivalent: "")
        let login = NSMenuItem(title: "Start at Login", action: #selector(toggleLogin), keyEquivalent: "")
        login.state = (SMAppService.mainApp.status == .enabled) ? .on : .off
        menu.addItem(login)
        menu.addItem(.separator())
        menu.addItem(withTitle: "Quit partyparty", action: #selector(quit), keyEquivalent: "q")
        for item in menu.items where item.action != nil { item.target = self }
        // Show the menu once, then detach so the next left-click uses the popover.
        statusItem.menu = menu
        sender.performClick(nil)
        statusItem.menu = nil
    }

    // MARK: Admin window (activation-policy hybrid)

    @objc private func openConsole() {
        if popover.isShown { popover.performClose(nil) }
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

    // MARK: Menu actions

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
