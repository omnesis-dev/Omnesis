// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import DesktopCore
import Foundation
import XCTest

final class BackgroundRebindTests: XCTestCase {
    private func encode(_ object: [String: Any]) throws -> String {
        try JSONSerialization.data(withJSONObject: object).base64EncodedString().replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(
                of: "/",
                with: "_"
            ).replacingOccurrences(of: "=", with: "")
    }

    private var target: [String: Any] {
        [
            "version": 1,
            "scope": [
                "format": 1,
                "configDir": "/example/owned-home",
                "instance": "desktop-" + String(repeating: "a", count: 16),
                "secretService": "dev.omnesis.desktop." + String(repeating: "a", count: 64),
            ],
            "epoch": String(repeating: "b", count: 64),
        ]
    }

    private var expected: [String: Any] {
        [
            "scope": target["scope"]!,
            "epoch": String(repeating: "c", count: 64),
            "pid": 123,
            "birth": ["seconds": "12345", "microseconds": "42"],
            "origin": ["state": "verified"],
        ]
    }

    func testQueryCannotSmuggleRebindOrLaunchParameters() throws {
        XCTAssertNil(try DesktopBackgroundRebind.decode(encode(target), replacing: false).expected)
        for key in ["expected", "activation", "nonce", "executable", "environment"] {
            var changed = target
            changed[key] = expected
            XCTAssertThrowsError(try DesktopBackgroundRebind.decode(encode(changed), replacing: false))
        }
        XCTAssertThrowsError(try DesktopBackgroundRebind.decode(encode(target), replacing: true))
    }

    func testRebindIsBoundToExactPriorProcessBirthAndSameOwnedConfig() throws {
        var request = target
        request["expected"] = expected
        let value = try DesktopBackgroundRebind.decode(encode(request), replacing: true)
        XCTAssertEqual(value.expected?.pid, 123)
        XCTAssertEqual(value.expected?.birth.microseconds, "42")
        XCTAssertEqual(value.expected?.epoch, String(repeating: "c", count: 64))
        for birth in [
            ["seconds": "012345", "microseconds": "42"],
            ["seconds": "12345", "microseconds": "1000000"],
            ["seconds": "-1", "microseconds": "0"],
        ] {
            var changed = expected
            changed["birth"] = birth
            request["expected"] = changed
            XCTAssertThrowsError(try DesktopBackgroundRebind.decode(encode(request), replacing: true))
        }
        var changed = expected
        changed["scope"] = [
            "format": 1,
            "configDir": "/example/another-home",
            "instance": "desktop-" + String(repeating: "a", count: 16),
            "secretService": "dev.omnesis.desktop." + String(repeating: "a", count: 64),
        ]
        request["expected"] = changed
        XCTAssertThrowsError(try DesktopBackgroundRebind.decode(encode(request), replacing: true))
    }
}
