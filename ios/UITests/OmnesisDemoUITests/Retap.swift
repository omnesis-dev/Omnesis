// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import XCTest

extension XCTestCase {
    /// Makes a tap until `element` shows its effect, at most three times.
    ///
    /// The simulator's system gesture gate now and then claims a synthesized
    /// touch for one of the system's own gestures and cancels it: the control
    /// under it may show its pressed state, but its action never runs. So a
    /// step that taps checks the one thing its action changes first, and taps
    /// again only when that has not happened, which a tap that did act can
    /// never cause.
    ///
    /// A DEBUG app launched with `DEMO_CANCEL_TOUCHES` cancels the touches it
    /// names the same way (see `AutomationTouchLog`), so a test can prove that
    /// its steps survive a cancelled tap.
    func retap(
        until element: XCUIElement,
        has effect: String,
        or failure: String,
        file: StaticString = #filePath,
        line: UInt = #line,
        _ makeTap: () -> Void
    ) {
        for _ in 0 ..< 3 {
            makeTap()
            let acted = XCTNSPredicateExpectation(predicate: NSPredicate(format: effect), object: element)
            if XCTWaiter.wait(for: [acted], timeout: 10) == .completed { return }
        }
        XCTFail(failure, file: file, line: line)
    }
}
