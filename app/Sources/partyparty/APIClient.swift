import Foundation

/// Minimal snapshot of /api/status for the menu-bar monitor.
struct ServerStatus {
    var state = "idle"      // idle | starting | live | error
    var listeners = 0
    var health = "idle"     // good | strain | congested | idle
    var struggling = 0
    var captureBad = false  // real capture failure (hogged/stalled output)
    var note = ""           // the human explanation, for the menu-bar tooltip
    var appVersion = ""     // effective visible version: app + adopted OTA payload
    var appUpdate = false   // cloud advertises a newer app build — pull it via Sparkle now
}

struct UpdateCheckResult {
    var appVersion = ""
    var payloadChanged = false
    var appUpdate = false
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
            if let b = o["broadcast"] as? [String: Any] {
                s.state = b["state"] as? String ?? "idle"
                s.captureBad = (b["captureBad"] as? Bool) ?? false
                s.note = b["note"] as? String ?? ""
            }
            s.listeners = (o["listeners"] as? NSNumber)?.intValue ?? 0
            if let h = o["health"] as? [String: Any] {
                s.health = h["status"] as? String ?? "idle"
                s.struggling = (h["struggling"] as? NSNumber)?.intValue ?? 0
            }
            s.appVersion = o["appVersion"] as? String ?? ""
            s.appUpdate = (o["appUpdate"] as? Bool) ?? false // drives the push-triggered Sparkle check
            DispatchQueue.main.async { done(s) }
        }.resume()
    }

    func checkUpdates(_ done: @escaping (UpdateCheckResult?) -> Void) {
        guard let u = URL(string: "http://localhost:\(port)/api/update/check") else {
            done(nil)
            return
        }
        var req = URLRequest(url: u)
        req.httpMethod = "POST"
        URLSession.shared.dataTask(with: req) { data, response, _ in
            guard let http = response as? HTTPURLResponse,
                  (200..<300).contains(http.statusCode),
                  let data = data,
                  let o = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
                DispatchQueue.main.async { done(nil) }
                return
            }
            var r = UpdateCheckResult()
            r.appVersion = o["appVersion"] as? String ?? ""
            r.payloadChanged = (o["payloadChanged"] as? Bool) ?? false
            r.appUpdate = (o["appUpdate"] as? Bool) ?? false
            DispatchQueue.main.async { done(r) }
        }.resume()
    }

}
