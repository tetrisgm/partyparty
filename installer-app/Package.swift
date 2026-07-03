// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "InstallPartyparty",
    platforms: [
        .macOS(.v13)
    ],
    products: [
        .executable(name: "InstallPartyparty", targets: ["InstallPartyparty"])
    ],
    targets: [
        .executableTarget(
            name: "InstallPartyparty",
            dependencies: [],
            path: "Sources/InstallPartyparty"
        )
    ]
)
