import Foundation

/// Minimal snapshot of /api/status for the menu-bar monitor.
struct ServerStatus {
    var state = "idle"      // idle | starting | live | error
    var listeners = 0
    var health = "idle"     // good | strain | congested | idle
    var struggling = 0
}

/// Thin client for the local Go server (menu-bar status monitor).
final class APIClient {
    let port: Int
    init(port: Int) { self.port = port }

    func fetchStatus(_ done: @escaping (ServerStatus?) -> Void) {
        guard let u = URL(string: "http://localhost:\(port)/api/status") else { done(nil); return }
        URLSession.shared.dataTask(with: u) { data, _, _ in
            guard let data = data,
                  let o = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
                DispatchQueue.main.async { done(nil) }; return
            }
            var s = ServerStatus()
            if let b = o["broadcast"] as? [String: Any] { s.state = b["state"] as? String ?? "idle" }
            s.listeners = (o["listeners"] as? NSNumber)?.intValue ?? 0
            if let h = o["health"] as? [String: Any] {
                s.health = h["status"] as? String ?? "idle"
                s.struggling = (h["struggling"] as? NSNumber)?.intValue ?? 0
            }
            DispatchQueue.main.async { done(s) }
        }.resume()
    }

}
