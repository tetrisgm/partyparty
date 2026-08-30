import Foundation
#if SWIFT_PACKAGE
import PartyPartyCore
#endif

/// Polls /api/status so the menu-bar icon shows live state + listener count and
/// the menu can show a fresh status header.
final class StatusPoller {
    private(set) var status = ServerStatus()
    private let api: APIClient
    private var timer: Timer?
    private var refreshState = CoalescingRefreshState()
    var onChange: (ServerStatus) -> Void = { _ in }

    init(api: APIClient) { self.api = api }

    func start() {
        guard timer == nil else { return }
        refresh()
        timer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in self?.refresh() }
    }

    func refresh() {
        guard refreshState.requestRefresh() else { return }
        fetchStatus()
    }

    private func fetchStatus() {
        api.fetchStatus { [weak self] s in
            guard let self else { return }
            let refreshAgain = self.refreshState.finishRefresh()
            if let s {
                self.status = s
                self.onChange(s)
            }
            if refreshAgain {
                self.fetchStatus()
            }
        }
    }

    deinit {
        timer?.invalidate()
    }
}
