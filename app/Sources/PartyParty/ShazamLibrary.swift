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
        // Where it was heard. Shazam records this for every match, and it is
        // what lets a night name its own venue. (0, 0) means it did not.
        var lat: Double = 0
        var lon: Double = 0

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
                // Send what is known immediately - a venue lookup is a network
                // call at one a second and the library must not wait behind it.
                let first = ShazamPlaces.known(for: items)
                NSLog("PartyParty: Shazam library read (\(items.count) matches, "
                    + "\(first.places.count) nights placed, \(first.missing) to look up)")
                APIClient(port: port).postShazamLibrary(
                    items, places: first.places, placesPending: first.missing)
                guard first.missing > 0 else { return }

                // Then find the rest, a handful at a time, saying so after each
                // handful. Geocoding is one request a second, so a first library
                // takes a couple of minutes - and the console shows venues
                // filling in rather than nothing until it is all done.
                var left = first.missing
                while left > 0 {
                    await ShazamPlaces.fill(for: items, limit: 8)
                    let now = ShazamPlaces.known(for: items)
                    APIClient(port: port).postShazamLibrary(
                        items, places: now.places, placesPending: now.missing)
                    // No progress means no point going round again: a geocoder
                    // that answers nothing will answer nothing forever, and a
                    // loop that cannot finish is worse than an unknown venue.
                    if now.missing >= left { break }
                    left = now.missing
                }
                NSLog("PartyParty: venues resolved (\(ShazamPlaces.known(for: items).places.count) "
                    + "nights placed)")
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
