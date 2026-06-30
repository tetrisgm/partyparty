import SwiftUI

/// Observable status for the menu-bar popover, polled from the Go server.
final class StatusModel: ObservableObject {
    @Published var status = ServerStatus()
    private let api: APIClient
    private var timer: Timer?
    var onOpenConsole: () -> Void = {}
    var onCheckUpdates: () -> Void = {}
    var onQuit: () -> Void = {}

    init(api: APIClient) { self.api = api }

    func startPolling() {
        refresh()
        timer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in self?.refresh() }
    }

    func refresh() {
        api.fetchStatus { [weak self] s in if let s = s { self?.status = s } }
    }

    func toggleLive() {
        if status.state == "live" || status.state == "starting" { api.stop() } else { api.goLive() }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { [weak self] in self?.refresh() }
    }
}

/// The at-a-glance show cockpit shown in the menu-bar popover.
struct StatusView: View {
    @ObservedObject var model: StatusModel

    var body: some View {
        let s = model.status
        let live = s.state == "live"
        let busy = live || s.state == "starting"
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Circle().fill(live ? Color.green : Color.secondary).frame(width: 9, height: 9)
                Text(live ? "LIVE" : (s.state == "starting" ? "Starting…" : (s.state == "error" ? "Error" : "Idle")))
                    .font(.headline)
                Spacer()
                if busy && !s.deviceName.isEmpty {
                    Text(s.deviceName).font(.caption).foregroundColor(.secondary).lineLimit(1)
                }
            }
            if busy {
                Text("\(s.listeners) listening · \(s.totalListeners) total").font(.callout)
                Text(s.syncSpreadMs != nil
                     ? "Sync spread: \(Int(s.syncSpreadMs!)) ms across \(s.syncCount)"
                     : "Sync spread: —")
                    .font(.callout).foregroundColor(.secondary)
            }
            Button(action: model.toggleLive) {
                Text(busy ? "Stop Broadcast" : "Go Live").frame(maxWidth: .infinity)
            }
            .controlSize(.large)
            .keyboardShortcut(.defaultAction)
            Button("Open DJ Console…", action: model.onOpenConsole).frame(maxWidth: .infinity)
            Divider()
            HStack {
                Button("Check for Updates…", action: model.onCheckUpdates)
                Spacer()
                Button("Quit", action: model.onQuit)
            }
        }
        .padding(14)
        .frame(width: 280)
    }
}
