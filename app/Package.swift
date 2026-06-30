// swift-tools-version: 5.10
import PackageDescription

// The native macOS shell: a menu-bar app that supervises the Go server (shipped
// in the .app's Contents/Helpers/) and presents the DJ admin in a native window.
// Built with SwiftPM (no .xcodeproj) so CI can `swift build` it; the .app bundle
// is assembled by a separate packaging step. Sparkle (auto-update) is added in a
// later chunk as a package dependency.
let package = Package(
    name: "partyparty",
    platforms: [.macOS(.v14)],
    dependencies: [
        .package(url: "https://github.com/sparkle-project/Sparkle", from: "2.6.0")
    ],
    targets: [
        .executableTarget(
            name: "partyparty",
            dependencies: [.product(name: "Sparkle", package: "Sparkle")],
            path: "Sources/partyparty"
        )
    ]
)
