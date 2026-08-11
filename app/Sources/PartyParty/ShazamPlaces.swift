import CoreLocation
import Foundation

/// Where each night happened, worked out from where its Shazams were heard.
///
/// Every match Shazam stores carries coordinates, and a night out is a very
/// tight cluster of them: across this owner's eighteen imported nights the
/// spread within a night was 8 to 35 metres. That is one room. So a night can
/// name its own venue, and the DJ does not have to remember which Saturday in
/// March was which.
///
/// Two things this is careful about, both learned by doing it by hand first:
///
///   - `-180, -180` is Shazam's "no location". Fourteen of one night's
///     eighty-four rows carried it, and averaging the night put the party in
///     the middle of the Pacific. The dominant CLUSTER is used, never the mean.
///   - Reverse geocoding is a network call to Apple, rate-limited to roughly one
///     a second. Answers are cached on disk by rounded coordinate, so a venue
///     somebody visits six times is looked up once, ever.
enum ShazamPlaces {
    private static let cacheKey = "shazamPlaceCache"

    /// Coordinates rounded to about a hundred metres. Fine enough to tell one
    /// venue from the next one down the street, coarse enough that the same
    /// room on two nights is the same key.
    static func key(lat: Double, lon: Double) -> String {
        String(format: "%.3f,%.3f", lat, lon)
    }

    /// The busiest coordinate of each night, which is the room the set was in.
    static func clusters(_ items: [ShazamLibrary.Item]) -> [String: String] {
        var perNight: [String: [String: Int]] = [:]
        for item in items where item.lat != 0 || item.lon != 0 {
            perNight[item.night, default: [:]][key(lat: item.lat, lon: item.lon), default: 0] += 1
        }
        var out: [String: String] = [:]
        for (night, seen) in perNight {
            if let best = seen.max(by: { $0.value < $1.value })?.key { out[night] = best }
        }
        return out
    }

    private static func cached() -> [String: String] {
        UserDefaults.standard.dictionary(forKey: cacheKey) as? [String: String] ?? [:]
    }

    /// What is already known, with no network and no waiting.
    static func known(for items: [ShazamLibrary.Item]) -> (places: [String: String], missing: Int) {
        let spots = clusters(items)
        let have = cached()
        var places: [String: String] = [:]
        var missing = Set<String>()
        for (night, spot) in spots {
            if let name = have[spot] {
                if !name.isEmpty { places[night] = name }
            } else {
                missing.insert(spot)
            }
        }
        return (places, missing.count)
    }

    /// Look up the venues nobody has looked up yet, slowly and once.
    ///
    /// Bounded per call so a first run cannot sit on the network for minutes:
    /// what it does not reach this time, it reaches next time, and the cache
    /// means the total work only ever shrinks. A cluster that geocodes to
    /// nothing is cached as an empty string - a failed lookup asked again every
    /// launch is a lookup that never stops costing.
    static func fill(for items: [ShazamLibrary.Item], limit: Int = 24) async {
        let spots = Set(clusters(items).values)
        var have = cached()
        let coder = CLGeocoder()
        var done = 0
        for spot in spots.sorted() where have[spot] == nil {
            if done >= limit { break }
            done += 1
            let parts = spot.split(separator: ",")
            guard parts.count == 2, let lat = Double(parts[0]), let lon = Double(parts[1]) else {
                have[spot] = ""
                continue
            }
            let marks = try? await coder.reverseGeocodeLocation(
                CLLocation(latitude: lat, longitude: lon))
            have[spot] = describe(marks?.first)
            UserDefaults.standard.set(have, forKey: cacheKey)
            try? await Task.sleep(nanoseconds: 1_200_000_000)
        }
    }

    /// A placemark as a person would write the place down.
    ///
    /// A point of interest wins when there is one - "Pier 80" is what somebody
    /// calls that night, and "800-898 Marin St" is not. Otherwise the street
    /// address, which is a thing a DJ recognises instantly even when Apple has
    /// no name for the room.
    static func describe(_ mark: CLPlacemark?) -> String {
        guard let mark else { return "" }
        if let poi = mark.areasOfInterest?.first, !poi.isEmpty {
            return [poi, mark.locality].compactMap { $0 }.joined(separator: ", ")
        }
        let street = [mark.subThoroughfare, mark.thoroughfare]
            .compactMap { $0 }.joined(separator: " ")
        let parts = street.isEmpty ? [mark.name, mark.locality] : [street, mark.locality]
        return parts.compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: ", ")
    }
}
