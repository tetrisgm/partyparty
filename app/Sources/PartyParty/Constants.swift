import Foundation

/// The app's display name, read from the bundle (Info.plist CFBundleDisplayName /
/// CFBundleName). Rename there and every label below follows. Falls back to
/// "PartyParty" for `swift run` dev builds with no bundle.
let appName = (Bundle.main.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String)
    ?? (Bundle.main.object(forInfoDictionaryKey: "CFBundleName") as? String)
    ?? "PartyParty"

let appVersion = (Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String) ?? "dev"
