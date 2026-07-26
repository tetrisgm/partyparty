import AppKit
import Foundation
#if APP_STORE
final class Updater {
    init(isBusy: @escaping () -> Bool) {}
    func checkForUpdates() {}
    func checkNow() {}
    func broadcastDidEnd() {}
}
#else
import Sparkle

/// Wraps Sparkle's updater (EdDSA-verified). Feed URL + public EdDSA key come
/// from Info.plist (SUFeedURL / SUPublicEDKey), set by the release pipeline.
///
/// Update model: scheduled checks download the signed update silently. Once it
/// is prepared, install and relaunch immediately while idle; if a set is live,
/// retain Sparkle's one-shot install handler and invoke it as soon as the set
/// ends. This app normally runs forever, so "install on quit" is not enough.
final class Updater: NSObject, SPUUpdaterDelegate, SPUStandardUserDriverDelegate {
    private var controller: SPUStandardUpdaterController!
    private let isBusy: () -> Bool
    private var deferredWhileBusy = false // an update was withheld during a set; re-surface it once idle
    private var pendingAutomaticInstall: (() -> Void)?

    init(isBusy: @escaping () -> Bool) {
        self.isBusy = isBusy
        super.init()
        controller = SPUStandardUpdaterController(
            startingUpdater: true,
            updaterDelegate: self,
            userDriverDelegate: self) // we drive gentle-reminder timing (defer mid-set)
        // Product policy is always-current: every Mac checks and downloads
        // signed updates automatically, regardless of a stale Sparkle default.
        controller.updater.automaticallyChecksForUpdates = true
        controller.updater.automaticallyDownloadsUpdates = true
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
        if pendingAutomaticInstall != nil {
            installPreparedUpdate()
            return
        }
        guard deferredWhileBusy else { return }
        deferredWhileBusy = false
        controller.checkForUpdates(nil)
    }

    // MARK: Automatic installation (SPUUpdaterDelegate)

    /// Sparkle has verified, downloaded, and prepared an automatic update. Take
    /// responsibility only because we always invoke the handler: now while idle,
    /// or on the live -> idle edge. Returning true without retaining/invoking the
    /// handler would stall Sparkle's update session indefinitely.
    func updater(_ updater: SPUUpdater, willInstallUpdateOnQuit item: SUAppcastItem,
                 immediateInstallationBlock immediateInstallHandler: @escaping () -> Void) -> Bool {
        pendingAutomaticInstall = immediateInstallHandler
        if isBusy() {
            NSLog("partyparty: update %@ prepared; deferring install until the set ends", item.displayVersionString)
        } else {
            installPreparedUpdate()
        }
        return true
    }

    private func installPreparedUpdate() {
        guard let install = pendingAutomaticInstall else { return }
        pendingAutomaticInstall = nil
        DispatchQueue.main.async {
            NSLog("partyparty: installing prepared update and relaunching")
            install()
        }
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
#endif
