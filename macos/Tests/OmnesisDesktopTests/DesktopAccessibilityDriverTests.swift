// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import AppKit
import XCTest

private final class FixtureAccessibilityValue: NSObject {
    let value: Any
    init(_ value: Any) {
        self.value = value
    }

    @objc func accessibilityValue() -> Any {
        value
    }
}

@MainActor
final class DesktopAccessibilityDriverTests: XCTestCase {
    func testPressUsesExactlyOneSupportedDispatchWithoutTogglingAgainOnFalse() {
        var presses = 0
        XCTAssertTrue(DesktopAccessibilityDriver.performOnePress(named: { presses += 1 }, direct: { presses += 1
            return true
        }))
        XCTAssertEqual(presses, 1)
        XCTAssertFalse(DesktopAccessibilityDriver.performOnePress(named: nil, direct: { presses += 1
            return false
        }))
        XCTAssertEqual(presses, 2, "A false result cannot justify dispatching the same action again")
        XCTAssertFalse(DesktopAccessibilityDriver.performOnePress(named: nil, direct: nil))
        XCTAssertEqual(presses, 2)
    }

    func testPlainAndAttributedAccessibleValuesPreserveTheExactText() {
        let text = "The fictional fixture has one item. This is the saved answer."
        let plain = DesktopAccessibilityDriver.Element(object: FixtureAccessibilityValue(text))
        let rich = DesktopAccessibilityDriver.Element(object: FixtureAccessibilityValue(NSAttributedString(string: text)))
        XCTAssertEqual(plain.accessibilityTextValue(), text)
        XCTAssertEqual(rich.accessibilityTextValue(), text)
        XCTAssertNil(DesktopAccessibilityDriver.Element(object: FixtureAccessibilityValue(42)).accessibilityTextValue())
    }
}
