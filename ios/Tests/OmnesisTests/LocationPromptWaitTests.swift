// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

final class LocationPromptWaitTests: XCTestCase {
    func testAWhileUsingAnswerEndsTheWait() {
        var wait = LocationPromptWait()

        XCTAssertEqual(wait.whileUsing(isDecided: true, isActive: true, elapsed: .zero), .stop)
    }

    func testASlowPromptIsNotTakenForAnAnswer() {
        var wait = LocationPromptWait()

        XCTAssertEqual(wait.whileUsing(isDecided: false, isActive: true, elapsed: .seconds(5)), .keepWaiting)
    }

    func testComingBackToTheAppAfterThePromptEndsTheWaitEvenIfUndecided() {
        var wait = LocationPromptWait()

        XCTAssertEqual(wait.whileUsing(isDecided: false, isActive: false, elapsed: .milliseconds(100)), .promptShown)
        XCTAssertEqual(wait.whileUsing(isDecided: false, isActive: false, elapsed: .seconds(3)), .keepWaiting)
        XCTAssertEqual(wait.whileUsing(isDecided: false, isActive: true, elapsed: .seconds(4)), .stop)
    }

    func testTheWhileUsingWaitEndsAtItsCeiling() {
        var active = LocationPromptWait()
        var away = LocationPromptWait()

        XCTAssertEqual(active.whileUsing(isDecided: false, isActive: true, elapsed: .seconds(60)), .stop)
        XCTAssertEqual(away.whileUsing(isDecided: false, isActive: false, elapsed: .seconds(61)), .stop)
    }

    func testAnAlwaysUpgradeIOSDoesNotShowEndsAtOnce() {
        var wait = LocationPromptWait()

        XCTAssertEqual(wait.alwaysUpgrade(isAlways: false, isActive: true, elapsed: .milliseconds(100)), .keepWaiting)
        XCTAssertEqual(wait.alwaysUpgrade(isAlways: false, isActive: true, elapsed: .milliseconds(500)), .stop)
    }

    func testAnAlwaysUpgradeOnScreenWaitsForTheUsersAnswer() {
        var wait = LocationPromptWait()

        XCTAssertEqual(wait.alwaysUpgrade(isAlways: false, isActive: false, elapsed: .milliseconds(200)), .promptShown)
        XCTAssertEqual(wait.alwaysUpgrade(isAlways: false, isActive: false, elapsed: .seconds(10)), .keepWaiting)
        XCTAssertEqual(wait.alwaysUpgrade(isAlways: false, isActive: true, elapsed: .seconds(11)), .stop)
    }

    func testGrantingAlwaysEndsTheWait() {
        var wait = LocationPromptWait()

        XCTAssertEqual(wait.alwaysUpgrade(isAlways: true, isActive: false, elapsed: .zero), .stop)
    }
}
