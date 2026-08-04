import Foundation

/// Minimal snapshot of /api/status for the menu-bar monitor.
struct ServerStatus {
    var state = "idle"      // idle | starting | live | error
    var listeners = 0
    var health = "idle"     // good | strain | congested | idle
    var struggling = 0
    var captureBad = false  // real capture failure (hogged/stalled output)
    var note = ""           // the human explanation, for the menu-bar tooltip
    var appVersion = ""
    var guestURL = ""       // secure LAN room URL; empty until the QR is usable
    var connectionMode = "checking"
    var connectionMessage = ""
    var relayConnected = false
    var eventTitle = ""     // the party name; Go live is gated on it, like the console button
}

/// Thin client for the local Go server (menu-bar status monitor).
final class APIClient {
    let port: Int
    init(port: Int) { self.port = port }

    func fetchStatus(_ done: @escaping (ServerStatus?) -> Void) {
        guard let u = URL(string: "http://127.0.0.1:\(port)/api/status") else { done(nil); return }
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
            if let event = o["event"] as? [String: Any] {
                s.eventTitle = event["title"] as? String ?? ""
            }
            if let connection = o["connection"] as? [String: Any] {
                s.connectionMode = connection["mode"] as? String ?? "checking"
                s.connectionMessage = connection["message"] as? String ?? ""
                s.relayConnected = connection["relayConnected"] as? Bool ?? false
            }
            if (o["llhlsRealCert"] as? Bool) == true,
               let urls = o["urls"] as? [String: Any] {
                let guest: String?
                if o["connection"] is [String: Any] {
                    guest = urls["join"] as? String
                } else {
                    guest = (urls["join"] as? String) ?? (urls["primary"] as? String)
                }
                if let guest, guest.hasPrefix("https://") {
                    s.guestURL = guest
                }
            }
            DispatchQueue.main.async { done(s) }
        }.resume()
    }

    /// Start with the default capture (Mac output) - the same /api/start the
    /// console button posts. A DJ using an audio interface starts from the
    /// console, where the picker is; the server rejects if the cert isn't ready.
    func startBroadcast(_ done: @escaping (Bool, String) -> Void) {
        var comps = URLComponents(string: "http://127.0.0.1:\(port)/api/start")!
        comps.queryItems = [
            URLQueryItem(name: "device", value: "mac"),
            URLQueryItem(name: "name", value: "Mac output (everything)"),
        ]
        guard let u = comps.url else { done(false, ""); return }
        var req = URLRequest(url: u)
        req.httpMethod = "POST"
        URLSession.shared.dataTask(with: req) { data, response, _ in
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            var message = ""
            if let data,
               let o = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] {
                message = o["error"] as? String ?? ""
            }
            DispatchQueue.main.async { done((200..<300).contains(status), message) }
        }.resume()
    }

    func stopBroadcast(_ done: @escaping (Bool) -> Void) {
        guard let u = URL(string: "http://127.0.0.1:\(port)/api/stop") else {
            done(false)
            return
        }
        var req = URLRequest(url: u)
        req.httpMethod = "POST"
        URLSession.shared.dataTask(with: req) { _, response, _ in
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            DispatchQueue.main.async { done((200..<300).contains(status)) }
        }.resume()
    }

}
