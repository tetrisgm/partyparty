import Foundation

/// Polls the Go server's /api/status so the menu can show live status at a glance.
final class StatusPoller {
    private(set) var status = ServerStatus()
    private let api: APIClient
    private var timer: Timer?

    init(api: APIClient) { self.api = api }

    func start() {
        refresh()
        timer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in self?.refresh() }
    }

    func refresh() {
        api.fetchStatus { [weak self] s in if let s = s { self?.status = s } }
    }
}
