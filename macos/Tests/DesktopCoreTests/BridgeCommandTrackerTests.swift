// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import DesktopCore
import XCTest

final class BridgeCommandTrackerTests: XCTestCase {
    func testPromptReplyCannotMarkAnOngoingEnrollmentIdle() {
        var tracker = BridgeCommandTracker()
        tracker.submitted(id: "connect-1", command: "connect")
        XCTAssertTrue(tracker.busy)
        XCTAssertFalse(tracker.canPoll)
        XCTAssertTrue(tracker.canSubmit("respond"))
        tracker.submitted(id: "reply-1", command: "respond")
        tracker.completed(id: "reply-1")
        XCTAssertTrue(tracker.busy)
        XCTAssertFalse(tracker.canSubmit("prepare"))
        XCTAssertFalse(tracker.canSubmit("status"))
        tracker.completed(id: "connect-1")
        XCTAssertFalse(tracker.busy)
        XCTAssertTrue(tracker.canPoll)
    }

    func testOnlyOneStatusPollIsOutstandingWithoutBlockingUserAction() {
        var tracker = BridgeCommandTracker()
        tracker.submitted(id: "status-1", command: "status")
        XCTAssertFalse(tracker.busy)
        XCTAssertFalse(tracker.canPoll)
        XCTAssertTrue(tracker.canSubmit("connect"))
        tracker.submitted(id: "connect-1", command: "connect")
        tracker.completed(id: "status-1")
        XCTAssertTrue(tracker.busy)
        XCTAssertFalse(tracker.canPoll)
    }

    func testCancelAcknowledgementDoesNotFinishTheCancelledOperationEarly() {
        var tracker = BridgeCommandTracker()
        tracker.submitted(id: "prepare-1", command: "prepare")
        tracker.submitted(id: "cancel-1", command: "cancel")
        tracker.completed(id: "cancel-1")
        XCTAssertTrue(tracker.busy)
        tracker.completed(id: "prepare-1")
        XCTAssertTrue(tracker.canPoll)
    }
}
