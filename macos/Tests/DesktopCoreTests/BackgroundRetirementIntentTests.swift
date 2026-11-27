// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import DesktopCore
import Foundation
import XCTest

final class BackgroundRetirementIntentTests: XCTestCase {
    func testOrdinaryMovesDoNotRequestRetirementOrHelperShutdown() {
        var intent = DesktopBackgroundRetirementIntent()
        XCTAssertEqual(intent.observe(inTrash: false), .unchanged)
        XCTAssertEqual(intent.observe(inTrash: false), .unchanged)
        XCTAssertNil(intent.ticket)
    }

    func testRepeatedTrashObservationKeepsOneExactRetirementTicket() throws {
        var intent = DesktopBackgroundRetirementIntent()
        XCTAssertEqual(intent.observe(inTrash: true), .retire)
        let ticket = try XCTUnwrap(intent.ticket)
        XCTAssertTrue(intent.permits(ticket))
        XCTAssertFalse(intent.permits(UUID()))
        XCTAssertEqual(intent.observe(inTrash: true), .retire)
        XCTAssertEqual(intent.ticket, ticket)
    }

    func testRestoreSynchronouslyInvalidatesPendingLaunchBeforeShutdown() throws {
        var intent = DesktopBackgroundRetirementIntent()
        XCTAssertEqual(intent.observe(inTrash: true), .retire)
        let pending = try XCTUnwrap(intent.ticket)
        XCTAssertEqual(intent.observe(inTrash: false), .shutdown)
        XCTAssertNil(intent.ticket)
        XCTAssertFalse(intent.permits(pending))
    }

    func testTrashRestoreTrashCannotReviveTheFrozenHelperOrOldTicket() throws {
        var intent = DesktopBackgroundRetirementIntent()
        _ = intent.observe(inTrash: true)
        let pending = try XCTUnwrap(intent.ticket)
        for inTrash in [false, true, false, true] {
            XCTAssertEqual(intent.observe(inTrash: inTrash), .shutdown)
            XCTAssertNil(intent.ticket)
            XCTAssertFalse(intent.permits(pending))
        }
    }

    @MainActor
    func testRestoreDuringHeldDrainNeverRearmsOldPreparationOrLaunch() async throws {
        @MainActor final class Gate {
            var continuation: CheckedContinuation<Void, Never>?
            var opened = false
            var starts = 0
            func wait() async {
                starts += 1
                guard !opened else { return }
                await withCheckedContinuation { continuation = $0 }
            }

            func open() {
                opened = true
                continuation?.resume()
                continuation = nil
            }
        }
        var intent = DesktopBackgroundRetirementIntent()
        let preparation = DesktopBackgroundPreparationGate()
        let operation = try preparation.begin()
        _ = intent.observe(inTrash: true)
        let pending = try XCTUnwrap(intent.ticket)
        preparation.close()
        let gate = Gate()
        let entered = expectation(description: "Original drain entered")
        let drain = DesktopBackgroundDrain {
            entered.fulfill()
            await gate.wait()
            return true
        }
        let observer = Task { await drain.join(until: ContinuousClock.now.advanced(by: .seconds(1))) }
        await fulfillment(of: [entered], timeout: 1)
        XCTAssertEqual(intent.observe(inTrash: false), .shutdown)
        observer.cancel()
        let blocked = await observer.value
        XCTAssertEqual(blocked, .blocked)
        XCTAssertFalse(intent.permits(pending))
        XCTAssertFalse(preparation.accepts(operation))
        XCTAssertThrowsError(try preparation.begin())
        gate.open()
        let joined = await drain.join(until: ContinuousClock.now.advanced(by: .seconds(1)))
        XCTAssertEqual(joined, .confirmed)
        XCTAssertEqual(gate.starts, 1)
        XCTAssertFalse(intent.permits(pending), "Physical drain cannot revive the old retirement launch")
        XCTAssertThrowsError(try preparation.begin(), "Only a fresh helper may prepare again")
    }
}
