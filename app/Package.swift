// swift-tools-version: 5.10
import PackageDescription
import Foundation

// The native macOS shell: a menu-bar app that supervises the Go server (shipped
// in the .app's Contents/Helpers/) and presents the DJ admin in a native window.
// SwiftPM remains useful for local builds. Store packages use the Xcode
// application target so App Store Connect receives complete platform metadata.
let standalone = ProcessInfo.processInfo.environment["PARTYPARTY_STANDALONE"] == "1"

let package = Package(
    name: "PartyParty",
    // Matches LSMinimumSystemVersion in app/Info.plist. It said .v14 while the
    // app shipped declaring macOS 26, so the compiler was checking availability
    // against a floor twelve versions below the one this app will actually
    // launch on - and rejected a 14.2 audio symbol as "too new" in a build that
    // can only ever run on 26.
    platforms: [.macOS("26.0")],
    dependencies: standalone
        ? [.package(url: "https://github.com/sparkle-project/Sparkle", from: "2.6.0")]
        : [],
    targets: [
        .executableTarget(
            name: "PartyParty",
            dependencies: standalone
                ? [.product(name: "Sparkle", package: "Sparkle")]
                : [],
            path: "Sources/PartyParty"
        )
    ]
)
