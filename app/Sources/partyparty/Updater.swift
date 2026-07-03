import AppKit
import Foundation
import Sparkle

/// Wraps Sparkle's updater (EdDSA-verified). Feed URL + public EdDSA key come
/// from Info.plist (SUFeedURL / SUPublicEDKey), set by the release pipeline.
///
/// Update model: scheduled checks download silently and Sparkle installs the
/// latest on relaunch. We LET SPARKLE MANAGE the update — we do NOT take control
/// via willInstallUpdateOnQuit. Returning YES there (the old code) stalls
/// Sparkle's update session and stops ALL future checks until the app quits, so
/// on this never-quit app a newer build wasn't picked up until relaunch — and
/// "install now" would install a stale build, then prompt again (the double
/// update). By not taking control, checks keep running and Sparkle always stages
/// the latest, so one install lands you fully current.
///
/// The only thing we control is WHEN Sparkle's install prompt appears: never
/// during a live set. The gentle-reminders hook defers it while broadcasting;
/// Sparkle re-offers once the DJ is idle (its own timer plus our foreground /
/// push checkNow()).
final class Updater: NSObject, SPUUpdaterDelegate, SPUStandardUserDriverDelegate {
    private var controller: SPUStandardUpdaterController!
    private let isBusy: () -> Bool
    private var deferredWhileBusy = false // an update was withheld during a set; re-surface it once idle

    init(isBusy: @escaping () -> Bool) {
        self.isBusy = isBusy
        super.init()
        controller = SPUStandardUpdaterController(
            startingUpdater: true,
            updaterDelegate: self,
            userDriverDelegate: self) // we drive gentle-reminder timing (defer mid-set)
        // Forced ON in code, not left to the first-run permission prompt or a
        // stale user default — every install should behave the same way.
        controller.updater.automaticallyChecksForUpdates = true
        // DOWNLOAD-ON-DEMAND, not auto-download. Auto-downloaded updates are
        // presented by Sparkle's automatic driver, which BYPASSES the gentle
        // reminder hook — so the "Install & Relaunch" window could pop mid-set.
        // With auto-download off, updates flow through the scheduled driver, the
        // only path that consults standardUserDriverShouldHandleShowingScheduledUpdate,
        // so our "never during a set" deferral is actually honored.
        controller.updater.automaticallyDownloadsUpdates = false
    }

    func checkForUpdates() {
        // A manual check surfaces any update we were holding (showUpdateInFocus),
        // so it's no longer "deferred". Clear the latch — otherwise, if the DJ
        // manually checks mid-set and dismisses, broadcastDidEnd would later fire
        // a fresh check and pop a spurious "you're up to date" dialog at set-end.
        deferredWhileBusy = false
        controller.checkForUpdates(nil)
    }

    /// A silent background check — reacts to a push signal (the server saw a
    /// newer build) or the app coming to the foreground, instead of waiting for
    /// Sparkle's timer.
    func checkNow() {
        controller.updater.checkForUpdatesInBackground()
    }

    /// Call when a broadcast ends. If we deferred an update during the set,
    /// surface it now. MUST use checkForUpdates (routes to showing the held
    /// update in focus) — checkForUpdatesInBackground can't resurrect the session
    /// once a scheduled update is pending (it early-returns while one is in
    /// progress), so the deferred update would otherwise never re-appear.
    func broadcastDidEnd() {
        guard deferredWhileBusy else { return }
        deferredWhileBusy = false
        controller.checkForUpdates(nil)
    }

    // MARK: Gentle scheduled-update reminders (SPUStandardUserDriverDelegate)

    var supportsGentleScheduledUpdateReminders: Bool { true }

    /// Idle -> let Sparkle show its update prompt now. Mid-set -> take
    /// responsibility (return false), show nothing, and remember to re-surface it
    /// via broadcastDidEnd() once the set ends — never interrupting a live set.
    func standardUserDriverShouldHandleShowingScheduledUpdate(_ update: SUAppcastItem, andInImmediateFocus immediateFocus: Bool) -> Bool {
        if isBusy() {
            deferredWhileBusy = true
            return false
        }
        return true
    }

    /// When we declared we'd handle showing (mid-set, returned false above), we
    /// intentionally show nothing to defer past the live set. Nothing to do.
    func standardUserDriverWillHandleShowingUpdate(_ handleShowingUpdate: Bool, forUpdate update: SUAppcastItem, state: SPUUserUpdateState) {}
}
