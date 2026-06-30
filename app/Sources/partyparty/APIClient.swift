import Foundation

/// Snapshot of the Go server's /api/status that the menu-bar popover shows.
struct ServerStatus {
    var state = "idle"            // idle | starting | live | error
    var listeners = 0
    var totalListeners = 0
    var bitrate = ""
    var deviceName = ""
    var syncSpreadMs: Double?
    var syncCount = 0
}

/// Thin client for the local Go server.
final class APIClient {
    let port: Int
    init(port: Int) { self.port = port }

    private func url(_ pathAndQuery: String) -> URL? {
        URL(string: "http://localhost:\(port)\(pathAndQuery)")
    }

    func fetchStatus(_ completion: @escaping (ServerStatus?) -> Void) {
        guard let u = url("/api/status") else { completion(nil); return }
        URLSession.shared.dataTask(with: u) { data, _, _ in
            guard let data = data,
                  let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
                DispatchQueue.main.async { completion(nil) }; return
            }
            var s = ServerStatus()
            if let b = obj["broadcast"] as? [String: Any] {
                s.state = b["state"] as? String ?? "idle"
                s.bitrate = b["bitrate"] as? String ?? ""
                s.deviceName = b["deviceName"] as? String ?? ""
            }
            s.listeners = (obj["listeners"] as? NSNumber)?.intValue ?? 0
            s.totalListeners = (obj["listenersTotal"] as? NSNumber)?.intValue ?? 0
            if let lat = obj["latency"] as? [String: Any] {
                s.syncCount = (lat["count"] as? NSNumber)?.intValue ?? 0
                if s.syncCount > 0 { s.syncSpreadMs = (lat["spreadMs"] as? NSNumber)?.doubleValue }
            }
            DispatchQueue.main.async { completion(s) }
        }.resume()
    }

    private func post(_ pathAndQuery: String) {
        guard let u = url(pathAndQuery) else { return }
        var req = URLRequest(url: u)
        req.httpMethod = "POST"
        URLSession.shared.dataTask(with: req).resume()
    }

    /// One-tap Go Live with the Mac's system audio (the recommended default source).
    func goLive() { post("/api/start?device=mac&name=Mac%20output&bitrate=160k&mono=0&latency=low") }
    func stop() { post("/api/stop") }
}
