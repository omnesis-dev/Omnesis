// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
import XCTest

/// Pure policy checks only. Never sample or warm the UI before the selected diagnostic cases.
final class DesktopOwnedUIObservationTests: XCTestCase {
    func testCoreObservationHasOneAbsoluteEarlierTriggerWithoutChangingHostedWindows() {
        let began = ContinuousClock.now
        let core = DesktopOwnedUIObservation.Trigger(.blockedDNS, began: began)
        XCTAssertFalse(core.isDue(at: began.advanced(by: .milliseconds(999))))
        XCTAssertTrue(core.isDue(at: began.advanced(by: .seconds(1))))
        XCTAssertTrue(core.isDue(at: began.advanced(by: .seconds(2))))
        for selected in [DesktopOwnedUIObservation.Case.staleOffMac, .currentOffMac] {
            let hosted = DesktopOwnedUIObservation.Trigger(selected, began: began)
            XCTAssertFalse(hosted.isDue(at: began.advanced(by: .seconds(1))))
            XCTAssertFalse(hosted.isDue(at: began.advanced(by: .milliseconds(4999))))
            XCTAssertTrue(hosted.isDue(at: began.advanced(by: .seconds(5))))
        }
        XCTAssertEqual(core.deadline, began.advanced(by: .seconds(1)), "Repeated observations cannot renew the trigger")
    }

    func testUnknownOrAutomaticallyReapedSignalPolicyCannotStartAnOwnedSampler() {
        XCTAssertTrue(DesktopOwnedUISelfSampler.permitsSoleWaiter(defaultHandler: true, autoReaps: false))
        XCTAssertFalse(DesktopOwnedUISelfSampler.permitsSoleWaiter(defaultHandler: false, autoReaps: false))
        XCTAssertFalse(DesktopOwnedUISelfSampler.permitsSoleWaiter(defaultHandler: true, autoReaps: true))
        XCTAssertFalse(DesktopOwnedUISelfSampler.permitsSoleWaiter(defaultHandler: false, autoReaps: true))
    }

    func testRunningSamplerHasSameFiniteFiveSixSevenSecondProtocol() {
        var state = DesktopOwnedUISelfSampler.SamplerLifecycle()
        XCTAssertEqual(state.advance(.running, elapsed: .seconds(0), refused: false), .wait)
        XCTAssertEqual(state.advance(.running, elapsed: .seconds(5), refused: false), .terminate)
        XCTAssertEqual(state.advance(.running, elapsed: .milliseconds(5999), refused: false), .wait)
        XCTAssertEqual(state.advance(.running, elapsed: .seconds(6), refused: false), .kill)
        XCTAssertEqual(state.advance(.running, elapsed: .seconds(7), refused: false), .unconfirmed)
        XCTAssertEqual(state.advance(.joined, elapsed: .seconds(8), refused: false), .finished)
    }

    func testLostChildRelationshipCannotSignalOrReviveAnOwner() {
        var state = DesktopOwnedUISelfSampler.SamplerLifecycle()
        XCTAssertEqual(state.advance(.ownershipLost, elapsed: .seconds(1), refused: true), .unconfirmed)
        XCTAssertEqual(state.advance(.running, elapsed: .seconds(2), refused: true), .finished)
    }

    func testInterruptedWaitCannotBorrowPreviousSignalAuthorityOrWaitForever() {
        var state = DesktopOwnedUISelfSampler.SamplerLifecycle()
        XCTAssertEqual(state.advance(.interrupted, elapsed: .seconds(5), refused: true), .wait)
        XCTAssertEqual(state.advance(.interrupted, elapsed: .seconds(7), refused: true), .unconfirmed)
    }
}
