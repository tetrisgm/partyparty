import XCTest
@testable import PartyPartyCore

final class CoalescingRefreshStateTests: XCTestCase {
    func testFirstRequestStartsAndCompletionReturnsToIdle() {
        var state = CoalescingRefreshState()

        XCTAssertTrue(state.requestRefresh())
        XCTAssertTrue(state.isRefreshing)
        XCTAssertFalse(state.finishRefresh())
        XCTAssertFalse(state.isRefreshing)
    }

    func testOverlappingRequestsCollapseIntoOneFollowUp() {
        var state = CoalescingRefreshState()

        XCTAssertTrue(state.requestRefresh())
        XCTAssertFalse(state.requestRefresh())
        XCTAssertFalse(state.requestRefresh())

        XCTAssertTrue(state.finishRefresh())
        XCTAssertTrue(state.isRefreshing)
        XCTAssertFalse(state.finishRefresh())
        XCTAssertFalse(state.isRefreshing)
    }

    func testRequestDuringFollowUpQueuesOneMoreRefresh() {
        var state = CoalescingRefreshState()

        XCTAssertTrue(state.requestRefresh())
        XCTAssertFalse(state.requestRefresh())
        XCTAssertTrue(state.finishRefresh())

        XCTAssertFalse(state.requestRefresh())
        XCTAssertTrue(state.finishRefresh())
        XCTAssertFalse(state.finishRefresh())
        XCTAssertFalse(state.isRefreshing)
    }
}
