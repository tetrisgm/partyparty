import Foundation
import ServiceManagement

/// Owns the privileged pf helper lifecycle. The daemon installs both captive
/// redirects (:80 and UDP :53), so keep it enabled only when this Mac is meant
/// to be the guests' network.
final class PortRedirectController {
    private let service = SMAppService.daemon(plistName: "net.ramine.partyparty.port80.plist")

    /// One-time cleanup: the :443 "clean-links" redirect (TCP 443 -> 8443) was
    /// removed. Guests always use the direct :8443 link now, so a half-broken
    /// redirect can no longer advertise a dead port-less link in the QR. This
    /// deregisters the old privileged daemon on any install that still has it, so
    /// no orphaned root LaunchDaemon lingers; it is a harmless no-op when the
    /// daemon was never registered. The port443 plist stays in the bundle for
    /// this release so unregister() can resolve the service — a follow-up release
    /// deletes the plist, the pp-port443 helper, and this method.
    func removeLegacyCleanLinks() {
        let cleanLinks = SMAppService.daemon(plistName: "net.ramine.partyparty.port443.plist")
        guard cleanLinks.status == .enabled || cleanLinks.status == .requiresApproval else { return }
        do {
            try cleanLinks.unregister()
            NSLog("partyparty: removed legacy clean-links :443 redirect")
        } catch {
            NSLog("partyparty: clean-links :443 removal failed: \(error)")
        }
    }

    private var envCaptiveRequested: Bool {
        ProcessInfo.processInfo.environment["PARTYPARTY_CAPTIVE"] == "1"
    }

    func syncForCurrentMode(captive: Bool? = nil) {
        let captiveRequested = captive ?? envCaptiveRequested
        if captiveRequested {
            register()
        } else {
            unregister()
        }
    }

    func stop() {
        unregister()
    }

    private func register() {
        guard service.status != .enabled else { return }
        do {
            try service.register()
            NSLog("partyparty: captive pf redirects enabled")
        } catch {
            NSLog("partyparty: captive pf redirect enable failed: \(error)")
        }
    }

    private func unregister() {
        guard service.status == .enabled else { return }
        do {
            try service.unregister()
            NSLog("partyparty: captive pf redirects disabled")
        } catch {
            NSLog("partyparty: captive pf redirect disable failed: \(error)")
        }
    }
}
