import Foundation

/// The DJ's own Shazam library, read back into the parties it belongs to.
///
/// A DJ Shazams all night - in the booth, at the bar, at somebody else's set -
/// and every one of those matches is already stored, dated, on their account.
/// The track list on an event page was filled by the in-app recognizer alone,
/// which only ever hears what THIS Mac broadcast, so everything caught on a
/// phone was lost to the party it happened at.
///
/// macOS keeps that library on this Mac, dated, already synced from the phone.
/// The date is the entire reason this is possible: without one a library is a
/// pile of songs with no night attached. `ShazamStore` is where it is read
/// from, and why it is not read through ShazamKit.
///
/// This reads and hands over. It never writes to the library, never removes
/// anything from it, and nothing here can reach the audio path.
enum ShazamLibrary {
    /// One match, in the shape the server forwards to the platform.
    ///
    /// `night` is computed HERE rather than on the server, because only this
    /// machine knows the DJ's timezone. A Shazam at 01:30 belongs to the party
    /// that started the evening before, so the night rolls over at 06:00 local
    /// instead of at midnight - the way a person describes it.
    struct Item {
        var title: String
        var artist: String
        var shazamID: String
        var artworkURL: String
        var atMs: Int64
        var night: String   // YYYY-MM-DD, the night it belongs to

        var json: [String: Any] {
            var out: [String: Any] = [
                "title": title, "artist": artist, "at": atMs, "night": night,
            ]
            if !shazamID.isEmpty { out["shazamId"] = shazamID }
            if !artworkURL.isEmpty { out["artworkUrl"] = artworkURL }
            return out
        }
    }

    /// Read the library and hand it to the local server.
    ///
    /// `prompt` is the difference between the console coming up (which must
    /// never throw a file panel at somebody who just opened their app) and the
    /// DJ pressing the button (where being asked once is the whole point).
    ///
    /// The read itself is `ShazamStore`, not `SHLibrary`: the framework returns
    /// an empty library on a Mac that has 898 matches, and the reasons are
    /// written down there.
    static func push(port: Int, prompt: Bool = false) {
        Task { @MainActor in
            if prompt, !ShazamStore.requestAccess() {
                // Declining is an answer, and a different one from "you have
                // never Shazamed anything". Reporting it as an empty library
                // would be a lie told to somebody who just said no on purpose.
                Task.detached(priority: .utility) {
                    APIClient(port: port).postShazamLibrary([], denied: true)
                }
                return
            }
            guard ShazamStore.readable() else { return }
            Task.detached(priority: .utility) {
                let items = ShazamStore.read()
                NSLog("PartyParty: Shazam library read (\(items.count) matches)")
                APIClient(port: port).postShazamLibrary(items)
            }
        }
    }

    /// The night a moment belongs to: the local date, with everything before
    /// 06:00 credited to the evening before.
    static func night(of when: Date, calendar: Calendar) -> String {
        let parts = calendar.dateComponents(
            [.year, .month, .day], from: when.addingTimeInterval(-6 * 3600))
        return String(format: "%04d-%02d-%02d", parts.year ?? 0, parts.month ?? 0, parts.day ?? 0)
    }
}
