// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
@testable import Omnesis
import XCTest

final class DocumentOpenURLsTests: XCTestCase {
    func testAppLinkComesBeforeWebLink() {
        XCTAssertEqual(
            docOpenURLs(appUrl: "fictional-app://item/1", sourceUrl: "https://app.example.com/item/1")
                .map(\.absoluteString),
            ["fictional-app://item/1", "https://app.example.com/item/1"]
        )
    }

    func testWebLinkAloneWhenNoAppLink() {
        XCTAssertEqual(
            docOpenURLs(appUrl: nil, sourceUrl: "https://app.example.com/item/1").map(\.absoluteString),
            ["https://app.example.com/item/1"]
        )
    }

    func testBlockedSchemesAndDuplicatesAreDropped() {
        XCTAssertEqual(
            docOpenURLs(appUrl: "https://example.com/a", sourceUrl: "https://example.com/a").map(\.absoluteString),
            ["https://example.com/a"]
        )
        XCTAssertTrue(docOpenURLs(appUrl: "javascript:alert(1)", sourceUrl: "file:///etc/hosts").isEmpty)
        XCTAssertTrue(docOpenURLs(appUrl: "", sourceUrl: nil).isEmpty)
    }
}
