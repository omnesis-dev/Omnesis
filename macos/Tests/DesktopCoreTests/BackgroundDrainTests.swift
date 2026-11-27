// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import DesktopCore
import Foundation
import XCTest

@MainActor
final class BackgroundDrainTests: XCTestCase {
    private final class Gate {
        var continuation: CheckedContinuation<Void, Never>?
        var opened = false
        var starts = 0
        func wait() async {
            starts += 1
            if opened { return }
            await withCheckedContinuation { continuation = $0 }
        }

        func open() {
            opened = true
            continuation?.resume()
            continuation = nil
        }
    }

    func testBlockedWaitRetainsOnePhysicalOperationAndLaterRetryConfirmsIt() async {
        let gate = Gate()
        let drain = DesktopBackgroundDrain { await gate.wait()
            return true
        }
        let first = await drain.join(until: ContinuousClock.now.advanced(by: .milliseconds(5)))
        XCTAssertEqual(first, .blocked)
        let second = await drain.join(until: ContinuousClock.now.advanced(by: .milliseconds(5)))
        XCTAssertEqual(second, .blocked)
        gate.open()
        let final = await drain.join(until: ContinuousClock.now.advanced(by: .seconds(1)))
        XCTAssertEqual(final, .confirmed)
        XCTAssertEqual(gate.starts, 1)
    }

    func testCancelingObserverDoesNotCancelPhysicalDrain() async {
        let gate = Gate()
        let drain = DesktopBackgroundDrain { await gate.wait()
            return true
        }
        let observer = Task { await drain.join(until: ContinuousClock.now.advanced(by: .seconds(1))) }
        observer.cancel()
        let canceled = await observer.value
        XCTAssertEqual(canceled, .blocked)
        gate.open()
        let final = await drain.join(until: ContinuousClock.now.advanced(by: .seconds(1)))
        XCTAssertEqual(final, .confirmed)
        XCTAssertEqual(gate.starts, 1)
    }

    func testExpiredDeadlineDoesNotRenewAfterPhysicalCompletion() async {
        let expired = ContinuousClock.now
        let drain = DesktopBackgroundDrain { true }
        let joined = await drain.join(until: expired.advanced(by: .seconds(1)))
        XCTAssertEqual(joined, .confirmed)
        let tooLate = await drain.join(until: expired)
        XCTAssertEqual(tooLate, .blocked)
    }

    func testPhysicallyJoinedUncleanDaemonCannotCertifyQueryCohortClosure() async {
        // A forced parent exit is physically terminal but supplies no cooperative query join proof.
        let drain = DesktopBackgroundDrain { false }
        let first = await drain.join(until: ContinuousClock.now.advanced(by: .seconds(1)))
        XCTAssertEqual(first, .blocked)
        let retry = await drain.join(until: ContinuousClock.now.advanced(by: .seconds(1)))
        XCTAssertEqual(retry, .blocked)
    }
}
