import Foundation
import ShazamKit

/// The DJ's own Shazam library, read back into the parties it belongs to.
///
/// A DJ Shazams all night - in the booth, at the bar, at somebody else's set -
/// and every one of those matches is already stored, dated, on their account.
/// The track list on an event page was filled by the in-app recognizer alone,
/// which only ever hears what THIS Mac broadcast, so everything caught on a
/// phone was lost to the party it happened at.
///
/// `SHLibrary` is the read side of the same account. Each item carries
/// `creationDate`, which is the entire reason this is possible: without a date
/// a library is a pile of songs with no night attached. (The older
/// `SHMediaLibrary` is write-only and deprecated - it can add a match to the
/// library and nothing else.)
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
    /// `SHLibrary.default.items` is a main-actor property, so the read happens
    /// on main and the mapping does not: a library with a few thousand matches
    /// should not be turned into JSON while the console is trying to draw.
    static func push(port: Int) {
        Task { @MainActor in
            let raw = SHLibrary.default.items
            Task.detached(priority: .utility) {
                APIClient(port: port).postShazamLibrary(mapped(raw))
            }
        }
    }

    /// Turn library items into ours, dropping the ones that cannot be placed.
    ///
    /// An item with no `creationDate` is not an error: it is a match from
    /// before the system stored one. It cannot be attributed to a night, and
    /// inventing a date for it would drop somebody's song onto the wrong
    /// party's page. Those are left behind rather than guessed at.
    static func mapped(_ raw: [SHMediaItem]) -> [Item] {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone.current
        var out: [Item] = []
        out.reserveCapacity(raw.count)
        for item in raw {
            guard let when = item.creationDate else { continue }
            let title = (item.title ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            guard !title.isEmpty else { continue }
            out.append(Item(
                title: title,
                artist: (item.artist ?? "").trimmingCharacters(in: .whitespacesAndNewlines),
                shazamID: item.shazamID ?? "",
                artworkURL: item.artworkURL?.absoluteString ?? "",
                atMs: Int64(when.timeIntervalSince1970 * 1000),
                night: night(of: when, calendar: calendar)))
        }
        // Oldest first, so a night's tracks arrive in the order they were heard
        // and land in the list in that order.
        out.sort { $0.atMs < $1.atMs }
        return out
    }

    /// The night a moment belongs to: the local date, with everything before
    /// 06:00 credited to the evening before.
    static func night(of when: Date, calendar: Calendar) -> String {
        let parts = calendar.dateComponents(
            [.year, .month, .day], from: when.addingTimeInterval(-6 * 3600))
        return String(format: "%04d-%02d-%02d", parts.year ?? 0, parts.month ?? 0, parts.day ?? 0)
    }
}
