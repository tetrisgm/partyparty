import Foundation

#if STANDALONE
import AppKit
import Sparkle

final class Updater: NSObject, SPUUpdaterDelegate {
    private var controller: SPUStandardUpdaterController!
    private let isBusy: () -> Bool
    private var pendingInstall: (() -> Void)?

    init(isBusy: @escaping () -> Bool) {
        self.isBusy = isBusy
        super.init()
        controller = SPUStandardUpdaterController(
            startingUpdater: true,
            updaterDelegate: self,
            userDriverDelegate: nil
        )
        controller.updater.automaticallyChecksForUpdates = true
        controller.updater.automaticallyDownloadsUpdates = true
    }

    func checkForUpdates() {
        controller.checkForUpdates(nil)
    }

    func checkInBackground() {
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
