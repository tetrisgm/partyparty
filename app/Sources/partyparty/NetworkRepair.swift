import AppKit
import Foundation

/// Detects and guides the user to undo damage an OLD version of partyparty could
/// do to macOS networking. To turn on Internet Sharing, the removed `pp-port80`
/// root helper created a macOS *network service on lo0* ("partyparty-adhoc") and
/// gave it a manual IP. On some Macs that displaced 127.0.0.1, so the console —
/// which loads from http://127.0.0.1 — could never load and the window stayed
/// blank. Because a network service lives in SystemConfiguration, it survived
/// reboots AND uninstalling the app.
///
/// partyparty no longer creates networks, so this can never happen again. But an
/// already-damaged Mac needs the leftover service removed, and that requires
/// admin rights the app deliberately no longer has. Detection is free (listing
/// services is unprivileged); the fix is one Terminal command the user runs once.
enum NetworkRepair {
    static let serviceName = "partyparty-adhoc"

    /// The one-time repair. `-removenetworkservice` FAILS here ("cannot remove …
    /// because there aren't any other network services on Loopback") because the
    /// leftover is the only service on the lo0 port — so instead DISABLE it
    /// (durable: it stops clobbering loopback on boot) and re-add 127.0.0.1
    /// (immediate: the console can load again without a reboot).
    static var fixCommand: String {
        "sudo networksetup -setnetworkserviceenabled \"\(serviceName)\" off\nsudo ifconfig lo0 alias 127.0.0.1 up"
    }

    /// True if the leftover `partyparty-adhoc` network service still exists.
    /// Unprivileged: `-listallnetworkservices` needs no admin rights.
    static func staleServicePresent() -> Bool {
        guard let out = run("/usr/sbin/networksetup", ["-listallnetworkservices"]) else { return false }
        return out
            .split(separator: "\n")
            .contains { $0.trimmingCharacters(in: .whitespaces) == serviceName }
    }

    /// Show the fix once per app version if the damage is present. Called on
    /// launch (proactive) and when the console proves unrenderable (reactive).
    /// De-duped so a Mac isn't nagged every launch or twice in one run.
    private static var promptedThisRun = false
    static func promptIfDamaged(force: Bool = false) {
        guard promptedThisRun == false || force else { return }
        guard staleServicePresent() else { return }
        promptedThisRun = true
        DispatchQueue.main.async { presentAlert() }
    }

    private static func presentAlert() {
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = "Finish removing an old partyparty network setting"
        alert.informativeText = """
        An earlier version of partyparty added a macOS network service to share \
        the party over Wi-Fi. It's no longer used and can interfere with this \
        Mac's local networking (it's what makes the partyparty window show up \
        blank). It stays behind even after uninstalling, and fixing it needs your \
        admin password, so partyparty can't do it for you.

        Paste these two lines into Terminal (it takes effect immediately — no \
        restart needed):

        \(fixCommand)
        """
        alert.addButton(withTitle: "Copy Command")
        alert.addButton(withTitle: "Open Terminal")
        alert.addButton(withTitle: "Later")
        switch alert.runModal() {
        case .alertFirstButtonReturn:
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(fixCommand, forType: .string)
        case .alertSecondButtonReturn:
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(fixCommand, forType: .string)
            NSWorkspace.shared.open(URL(fileURLWithPath: "/System/Applications/Utilities/Terminal.app"))
        default:
            break
        }
    }

    @discardableResult
    private static func run(_ path: String, _ args: [String]) -> String? {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: path)
        p.arguments = args
        let pipe = Pipe()
        p.standardOutput = pipe
        p.standardError = Pipe()
        do { try p.run() } catch { return nil }
        p.waitUntilExit()
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        return String(data: data, encoding: .utf8)
    }
}
