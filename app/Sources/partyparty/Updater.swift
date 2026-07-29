import Foundation

#if STANDALONE
import AppKit
import Sparkle

final class Updater: NSObject, SPUUpdaterDelegate {
    private var controller: SPUStandardUpdaterController!
    private let isBusy: () -> Bool
    private var pendingInstall: (() -> Void)?

    // Build 0 marks a local development build, never a release. A local build
    // that auto-updates replaces itself with the public release within seconds
    // of launching, which silently substitutes the code under test with the
    // shipped one and makes every local verification a lie. It happened: an
    // installed dev build reported the previous release's behavior minutes
    // after being "verified", because it literally was the previous release.
    // Manual "Check for Updates" still works on a dev build, so leaving one
    // installed by accident has an exit.
    private static var isDevBuild: Bool {
        (Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String) == "0"
    }

    init(isBusy: @escaping () -> Bool) {
        self.isBusy = isBusy
        super.init()
        controller = SPUStandardUpdaterController(
            startingUpdater: true,
            updaterDelegate: self,
            userDriverDelegate: nil
        )
        controller.updater.automaticallyChecksForUpdates = !Self.isDevBuild
        controller.updater.automaticallyDownloadsUpdates = !Self.isDevBuild
    }

    func checkForUpdates() {
        controller.checkForUpdates(nil)
    }

    func checkInBackground() {
        if Self.isDevBuild { return }
        controller.updater.checkForUpdatesInBackground()
    }

    func broadcastDidEnd() {
        guard let install = pendingInstall else { return }
        pendingInstall = nil
        DispatchQueue.main.async(execute: install)
    }

    func updater(
        _ updater: SPUUpdater,
        willInstallUpdateOnQuit item: SUAppcastItem,
        immediateInstallationBlock immediateInstallHandler: @escaping () -> Void
    ) -> Bool {
        if isBusy() {
            pendingInstall = immediateInstallHandler
        } else {
            DispatchQueue.main.async(execute: immediateInstallHandler)
        }
        return true
    }
}
#else
final class Updater {
    init(isBusy: @escaping () -> Bool) {}
    func checkForUpdates() {}
    func checkInBackground() {}
    func broadcastDidEnd() {}
}
#endif
