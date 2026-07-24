import Foundation
import ServiceManagement

/// Unregisters the privileged root helpers partyparty used to install. Both are
/// gone from the product:
///
///  - `pp-port443` ("clean links", TCP 443 -> 8443) was removed once guests moved
///    to the direct `:8443` link.
///  - `pp-port80` (captive pf redirects + macOS Internet Sharing) was removed
///    after it was found to permanently damage Macs. To turn on Internet Sharing
///    it created a macOS *network service on lo0* and gave it a manual address;
///    on some Macs that displaced 127.0.0.1, so the console — which loads from
///    http://127.0.0.1 — could never load and the window stayed blank. Because a
///    network service lives in SystemConfiguration, it survived reboots AND
///    uninstalling the app.
///
/// partyparty no longer creates networks; it uses the Wi-Fi that is already
/// there. This runs on every launch and is a harmless no-op once clean, so a Mac
/// repairs itself no matter which versions it skipped. Only plist stubs ship, so
/// `SMAppService.daemon` can still resolve the services in order to unregister.
enum LegacyHelperCleanup {
    private static let legacyDaemons = [
        "net.ramine.partyparty.port80.plist",
        "net.ramine.partyparty.port443.plist",
    ]

    static func run() {
        for plist in legacyDaemons {
            let service = SMAppService.daemon(plistName: plist)
            guard service.status == .enabled || service.status == .requiresApproval else { continue }
            do {
                try service.unregister()
                NSLog("partyparty: unregistered legacy privileged helper \(plist)")
            } catch {
                NSLog("partyparty: could not unregister \(plist): \(error)")
            }
        }
    }
}
