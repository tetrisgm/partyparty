/// Tracks a callback-based refresh so callers can keep at most one request in
/// flight while remembering that another refresh was requested in the meantime.
///
/// This type is intentionally not synchronized. Its owner must use it from one
/// executor or serial queue; the native app owns it on the main thread.
public struct CoalescingRefreshState {
    public private(set) var isRefreshing = false
    private var refreshPending = false

    public init() {}

    /// Returns true when the caller should start a request now. Requests made
    /// while one is active collapse into one follow-up request.
    public mutating func requestRefresh() -> Bool {
        guard !isRefreshing else {
            refreshPending = true
            return false
        }
        isRefreshing = true
        return true
    }

    /// Returns true when the caller should immediately start the coalesced
    /// follow-up. In that case the state remains refreshing until it finishes.
    public mutating func finishRefresh() -> Bool {
        precondition(isRefreshing, "cannot finish a refresh that was not started")
        guard refreshPending else {
            isRefreshing = false
            return false
        }
        refreshPending = false
        return true
    }
}
