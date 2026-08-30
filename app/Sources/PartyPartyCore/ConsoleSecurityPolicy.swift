import Foundation

/// A normalized web origin used at the WebKit boundary. The console always
/// has an explicit loopback port, so a missing or different port is a different
/// origin even when the scheme and host happen to match.
public struct ConsoleOrigin: Equatable {
    let scheme: String
    let host: String
    let port: Int

    public init?(url: URL) {
        guard let scheme = url.scheme?.lowercased(),
              let host = url.host?.lowercased(),
              let port = url.port,
              url.user == nil,
              url.password == nil else { return nil }
        self.scheme = scheme
        self.host = host
        self.port = port
    }

    public init(scheme: String, host: String, port: Int) {
        self.scheme = scheme.lowercased()
        self.host = host.lowercased()
        self.port = port
    }
}

/// Pure policy shared by navigation and the privileged JavaScript bridge.
/// Keeping it free of WebKit types makes every origin decision unit-testable.
public struct ConsoleSecurityPolicy {
    public enum NavigationTarget: Equatable {
        case mainFrame
        case subframe
        case newWindow
    }

    public enum NavigationDecision: Equatable {
        case allow
        case openInSystemBrowser
        case cancel
    }

    private let consoleOrigin: ConsoleOrigin

    public init?(consoleURL: URL) {
        guard let origin = ConsoleOrigin(url: consoleURL),
              origin.scheme == "http",
              origin.host == "127.0.0.1" else { return nil }
        consoleOrigin = origin
    }

    public func navigationDecision(
        for url: URL?,
        target: NavigationTarget,
        mayOpenKnownExternalLink: Bool = false
    ) -> NavigationDecision {
        guard let url else { return .cancel }
        if origin(of: url) == consoleOrigin {
            // Preserve the console's target=_blank contract for local media:
            // it is still safe to hand off because the exact loopback origin
            // (including its configured port) has already been verified.
            return target == .newWindow ? .openInSystemBrowser : .allow
        }
        if target != .subframe,
           mayOpenKnownExternalLink,
           Self.isKnownExternalLink(url) {
            return .openInSystemBrowser
        }
        return .cancel
    }

    public func allowsBridgeMessage(from origin: ConsoleOrigin, isMainFrame: Bool) -> Bool {
        isMainFrame && origin == consoleOrigin
    }

    public func isConsoleURL(_ url: URL?) -> Bool {
        guard let url else { return false }
        return origin(of: url) == consoleOrigin
    }

    public static func isKnownExternalLink(_ url: URL) -> Bool {
        guard url.scheme?.lowercased() == "https",
              url.host?.lowercased() == "partyparty.party",
              url.port == nil || url.port == 443,
              url.user == nil,
              url.password == nil else { return false }
        return ["/privacy", "/support"].contains(url.path)
    }

    private func origin(of url: URL) -> ConsoleOrigin? {
        ConsoleOrigin(url: url)
    }
}
