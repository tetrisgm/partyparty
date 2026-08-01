import Foundation

/// Polls /api/status so the menu-bar icon shows live state + listener count and
/// the menu can show a fresh status header.
final class StatusPoller {
    private(set) var status = ServerStatus()
    private let api: APIClient
    private var timer: Timer?
    var onChange: (ServerStatus) -> Void = { _ in }

    init(api: APIClient) { self.api = api }

    func start() {
        refresh()
        timer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in self?.refresh() }
    }

    func refresh() {
        api.fetchStatus { [weak self] s in
            guard let self = self, let s = s else { return }
            self.status = s
            self.onChange(s)
        }
    }
}
