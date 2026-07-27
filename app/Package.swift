// swift-tools-version: 5.10
import PackageDescription

// The native macOS shell: a menu-bar app that supervises the Go server (shipped
// in the .app's Contents/Helpers/) and presents the DJ admin in a native window.
// SwiftPM remains useful for local builds. Store packages use the Xcode
// application target so App Store Connect receives complete platform metadata.
let package = Package(
    name: "partyparty",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(
            name: "partyparty",
            path: "Sources/partyparty"
        )
    ]
)
