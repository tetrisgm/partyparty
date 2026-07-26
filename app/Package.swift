// swift-tools-version: 5.10
import PackageDescription
import Foundation

// The native macOS shell: a menu-bar app that supervises the Go server (shipped
// in the .app's Contents/Helpers/) and presents the DJ admin in a native window.
// Built with SwiftPM (no .xcodeproj); scripts/build-app.sh assembles the bundle.
// Direct migration builds include Sparkle. Mac App Store builds receive updates
// from the App Store and compile without Sparkle or old-install repair code.
let appStoreBuild = ProcessInfo.processInfo.environment["PARTYPARTY_APP_STORE"] == "1"
let packageDependencies: [Package.Dependency] = appStoreBuild
    ? []
    : [.package(url: "https://github.com/sparkle-project/Sparkle", from: "2.6.0")]
let targetDependencies: [Target.Dependency] = appStoreBuild
    ? []
    : [.product(name: "Sparkle", package: "Sparkle")]
let targetExcludes = appStoreBuild
    ? ["LegacyHelperCleanup.swift", "NetworkRepair.swift"]
    : []

let package = Package(
    name: "partyparty",
    platforms: [.macOS(.v14)],
    dependencies: packageDependencies,
    targets: [
        .executableTarget(
            name: "partyparty",
            dependencies: targetDependencies,
            path: "Sources/partyparty",
            exclude: targetExcludes
        )
    ]
)
