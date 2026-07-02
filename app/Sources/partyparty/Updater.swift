import Foundation
import Sparkle

/// Wraps Sparkle's standard updater (EdDSA-verified, background auto-checks).
/// Feed URL + public EdDSA key come from Info.plist (SUFeedURL / SUPublicEDKey),
/// set by the release pipeline.
///
/// Update UX: scheduled checks download the update SILENTLY in the background;
/// Sparkle only surfaces "Install and Relaunch / Install on Quit" once it's
/// staged — never a "do you want to download?" question. (A manual "Check for
/// Updates…" still shows its result immediately — the user asked for it.)
final class Updater {
    let controller: SPUStandardUpdaterController

    init() {
        controller = SPUStandardUpdaterController(
            startingUpdater: true,
            updaterDelegate: nil,
            userDriverDelegate: nil)
        // Forced ON in code, not left to the first-run permission prompt or a
        // stale user default — every install should behave the same way.
        controller.updater.automaticallyChecksForUpdates = true
        controller.updater.automaticallyDownloadsUpdates = true
    }

    func checkForUpdates() {
        controller.checkForUpdates(nil)
    }
}
