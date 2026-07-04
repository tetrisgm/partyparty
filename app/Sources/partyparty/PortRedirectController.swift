import Foundation
import ServiceManagement

/// Owns the privileged pf helper lifecycle. The daemon installs both captive
/// redirects (:80 and UDP :53), so keep it enabled only when this Mac is meant
/// to be the guests' network.
final class PortRedirectController {
    private let service = SMAppService.daemon(plistName: "net.ramine.partyparty.port80.plist")

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
