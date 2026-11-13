// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

/// The portal checks the same writings against the gateway's own reader; the expected spellings here are its results.
final class ScopeTypedIdentifierTests: XCTestCase {
    func testATypedAddressIsReadIntoTheGatewaySpellingOrRefused() {
        let fullWidthPhone = "\u{FF0B}\u{FF11}\u{FF15}\u{FF15}\u{FF15}\u{FF10}\u{FF11}\u{FF10}\u{FF10}\u{FF11}\u{FF12}\u{FF13}"
        let cases: [String: [(typed: String, saved: String?)]] = [
            "phone": [
                ("+15550100123", "+15550100123"),
                ("+1 (555) 010-0123", "+15550100123"),
                ("+1.555.010.0123", "+15550100123"),
                ("+1 555\u{2011}010\u{2013}0123", "+15550100123"),
                ("0015550100123", "+15550100123"),
                ("00 1 555 010 0123", "+15550100123"),
                ("tel:+1-555-010-0123", "+15550100123"),
                (fullWidthPhone, "+15550100123"),
                ("5550100123", nil),
                ("(555) 010-0123", nil),
                ("+44 (0)7700 900123", nil),
                ("+12", nil),
                ("+1 555 010 CALL", nil),
                ("maya@example.org", nil),
                ("", nil),
            ],
            "email": [
                ("maya@example.org", "maya@example.org"),
                ("  Maya@Example.ORG ", "maya@example.org"),
                ("<maya@example.org>", "maya@example.org"),
                ("Maya <Maya@example.org>", "maya@example.org"),
                ("\"Reeves, Maya\" <maya@example.org>", "maya@example.org"),
                ("mailto:maya@example.org", "maya@example.org"),
                ("maya@example.org.", "maya@example.org"),
                ("maya+receipts@example.org", "maya+receipts@example.org"),
                ("maya@b\u{00FC}cher.example", "maya@b\u{00FC}cher.example"),
                ("maya", nil),
                ("@example.org", nil),
                ("maya@", nil),
                ("maya@localhost", nil),
                ("maya reeves@example.org", nil),
                ("", nil),
            ],
            "domain": [
                ("example.org", "example.org"),
                ("EXAMPLE.Org", "example.org"),
                ("@example.org", "example.org"),
                (" example.org. ", "example.org"),
                ("mail.example.org", "mail.example.org"),
                ("b\u{00FC}cher.example", "b\u{00FC}cher.example"),
                ("localhost", nil),
                ("*.example.org", nil),
                ("example.org/path", nil),
                ("https://example.org", nil),
                ("maya@example.org", nil),
                ("example..org", nil),
                ("-example.org", nil),
                ("example.123", nil),
                ("", nil),
            ],
        ]
        for (type, writings) in cases {
            for item in writings {
                XCTAssertEqual(scopeTypedIdentifier(item.typed, type: type)?.value, item.saved, "\(type): \(item.typed)")
            }
        }
    }

    func testAnUnknownTypeOrAnOversizedValueNamesNothing() {
        XCTAssertNil(scopeTypedIdentifier("Fictional Person", type: "name"))
        XCTAssertNil(scopeTypedIdentifier(String(repeating: "a", count: 600) + "@example.org", type: "email"))
        XCTAssertEqual(scopeTypedIdentifier("maya@example.org", type: "email"), ScopeIdentifier(type: "email", value: "maya@example.org"))
    }
}
