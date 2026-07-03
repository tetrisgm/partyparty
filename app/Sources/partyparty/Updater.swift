import AppKit
import Foundation
import Sparkle

/// Wraps Sparkle's updater (EdDSA-verified, hourly background checks). Feed
/// URL + public EdDSA key come from Info.plist (SUFeedURL / SUPublicEDKey),
/// set by the release pipeline.
///
/// Update UX (user decree): NEVER ask "do you want to download?" and never
/// offer "Skip This Version". Scheduled checks download silently; once the
/// update is staged we ask exactly one question — "Install now, or on next
/// start?" — and never while a broadcast is live (it installs on quit then).
final class Updater: NSObject, SPUUpdaterDelegate {
    private var controller: SPUStandardUpdaterController!
    private let isBusy: () -> Bool
    private var prompted = false // one prompt per staged update, not per check

    init(isBusy: @escaping () -> Bool) {
        self.isBusy = isBusy
        super.init()
        controller = SPUStandardUpdaterController(
            startingUpdater: true,
            updaterDelegate: self,
            userDriverDelegate: nil)
        // Forced ON in code, not left to the first-run permission prompt or a
        // stale user default — every install should behave the same way.
        controller.updater.automaticallyChecksForUpdates = true
        controller.updater.automaticallyDownloadsUpdates = true
    }

    func checkForUpdates() {
        controller.checkForUpdates(nil)
    }

    /// A silent, on-demand background check — used to react immediately to a
    /// push signal (the server's subscribe loop saw a newer build) or to the app
    /// coming to the foreground, instead of waiting for Sparkle's own timer.
    /// Honors our automatic-download setting: it stages any update and routes
    /// through willInstallUpdateOnQuit, so there's no UI unless one is ready and
    /// a set isn't live.
    func checkNow() {
        controller.updater.checkForUpdatesInBackground()
    }

    // Sparkle staged a silently-downloaded update and will install it on quit.
    // Offer the "now" shortcut — unless the DJ is mid-set, where any dialog is
    // wrong and quit-install already covers it.
    func updater(_ updater: SPUUpdater, willInstallUpdateOnQuit item: SUAppcastItem,
                 immediateInstallationBlock immediateInstallHandler: @escaping () -> Void) -> Bool {
        if prompted || isBusy() { return true } // silent install-on-quit
        prompted = true
        DispatchQueue.main.async {
            NSApp.activate(ignoringOtherApps: true)
            let a = NSAlert()
            a.messageText = "partyparty \(item.displayVersionString) is ready"
            a.informativeText = "It's already downloaded. Install now, or it installs itself the next time partyparty starts."
            a.addButton(withTitle: "Install and Relaunch")
            a.addButton(withTitle: "On Next Start")
            if a.runModal() == .alertFirstButtonReturn {
                immediateInstallHandler()
            }
        }
        return true
    }
}
