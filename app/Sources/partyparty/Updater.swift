import Foundation
import Sparkle

/// Wraps Sparkle's standard updater (Update Available alert, release notes,
/// install-and-relaunch, EdDSA-verified, background auto-checks). Feed URL +
/// public EdDSA key come from Info.plist (SUFeedURL / SUPublicEDKey), set by the
/// release pipeline.
final class Updater {
    let controller: SPUStandardUpdaterController

    init() {
        controller = SPUStandardUpdaterController(
            startingUpdater: true,
            updaterDelegate: nil,
            userDriverDelegate: nil)
    }

    func checkForUpdates() {
        controller.checkForUpdates(nil)
    }
}
