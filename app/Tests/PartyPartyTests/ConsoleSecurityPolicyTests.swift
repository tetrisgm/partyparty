import Foundation
import XCTest
@testable import PartyPartyCore

final class ConsoleSecurityPolicyTests: XCTestCase {
    private let policy = ConsoleSecurityPolicy(
        consoleURL: URL(string: "http://127.0.0.1:49152/dj")!
    )!

    func testSameOriginNavigationAllowsAnyPathButNotOriginLookalikes() {
        XCTAssertEqual(decision("http://127.0.0.1:49152/dj"), .allow)
        XCTAssertEqual(decision("http://127.0.0.1:49152/settings?tab=audio#capture"), .allow)

        XCTAssertEqual(decision("http://localhost:49152/dj"), .cancel)
        XCTAssertEqual(decision("http://127.0.0.1:49153/dj"), .cancel)
        XCTAssertEqual(decision("https://127.0.0.1:49152/dj"), .cancel)
        XCTAssertEqual(decision("http://127.0.0.2:49152/dj"), .cancel)
    }

    func testOnlyKnownPublicLinksOpenInSystemBrowser() {
        XCTAssertEqual(decision("https://partyparty.party/privacy", mayOpenExternal: true), .openInSystemBrowser)
        XCTAssertEqual(
            decision("https://partyparty.party/support?from=app", mayOpenExternal: true),
            .openInSystemBrowser
        )

        XCTAssertEqual(decision("https://partyparty.party/"), .cancel)
        XCTAssertEqual(decision("https://partyparty.party:444/support"), .cancel)
        XCTAssertEqual(decision("https://example.com/support"), .cancel)
        XCTAssertEqual(decision("http://partyparty.party/support"), .cancel)
    }

    func testNewWindowsOpenOnlyExactOriginOrAllowlistedBrowserDestination() {
        XCTAssertEqual(
            decision("http://127.0.0.1:49152/dj?panel=settings", target: .newWindow),
            .openInSystemBrowser
        )
        XCTAssertEqual(
            decision("https://partyparty.party/privacy", target: .newWindow, mayOpenExternal: true),
            .openInSystemBrowser
        )
        XCTAssertEqual(decision("https://example.com", target: .newWindow), .cancel)
    }

    func testRemoteSubframesAreCancelled() {
        XCTAssertEqual(decision("http://127.0.0.1:49152/frame", target: .subframe), .allow)
        XCTAssertEqual(decision("https://example.com/frame", target: .subframe), .cancel)
        XCTAssertEqual(
            decision("https://partyparty.party/support", target: .subframe, mayOpenExternal: true),
            .cancel
        )
    }

    func testRemoteMainFrameRedirectDoesNotOpenAllowlistedDestination() {
        XCTAssertEqual(decision("https://partyparty.party/support"), .cancel)
    }

    func testBridgeRequiresExactOriginAndMainFrame() {
        let console = ConsoleOrigin(scheme: "http", host: "127.0.0.1", port: 49152)
        XCTAssertTrue(policy.allowsBridgeMessage(from: console, isMainFrame: true))
        XCTAssertFalse(policy.allowsBridgeMessage(from: console, isMainFrame: false))
        XCTAssertFalse(policy.allowsBridgeMessage(
            from: ConsoleOrigin(scheme: "http", host: "localhost", port: 49152),
            isMainFrame: true
        ))
        XCTAssertFalse(policy.allowsBridgeMessage(
            from: ConsoleOrigin(scheme: "http", host: "127.0.0.1", port: 49153),
            isMainFrame: true
        ))
        XCTAssertFalse(policy.allowsBridgeMessage(
            from: ConsoleOrigin(scheme: "https", host: "127.0.0.1", port: 49152),
            isMainFrame: true
        ))
    }

    private func decision(
        _ rawURL: String,
        target: ConsoleSecurityPolicy.NavigationTarget = .mainFrame,
        mayOpenExternal: Bool = false
    ) -> ConsoleSecurityPolicy.NavigationDecision {
        policy.navigationDecision(
            for: URL(string: rawURL),
            target: target,
            mayOpenKnownExternalLink: mayOpenExternal
        )
    }
}
