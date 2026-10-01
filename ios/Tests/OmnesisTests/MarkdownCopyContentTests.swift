// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

final class MarkdownCopyContentTests: XCTestCase {
    func testPlainValueFenceLanguagesAndDisplayKeepPayloadSeparate() {
        for language in ["", "text", "TEXT", "plain", "plaintext", "txt"] {
            XCTAssertTrue(MarkdownCopyContent.isPlainFence(language))
        }
        XCTAssertFalse(MarkdownCopyContent.isPlainFence("swift"))
        let value = "  42 Example Street  \nExampleville\n\n"
        XCTAssertEqual(MarkdownCopyContent.fencedDisplay(value), "  42 Example Street  \nExampleville")
        XCTAssertEqual(value, "  42 Example Street  \nExampleville\n\n")
    }

    func testOnlyCompleteCodeSpansAreCopyable() {
        XCTAssertEqual(MarkdownCopyContent.values(in: "Address: `42 Example Street`. ID: `000042`."), ["42 Example Street", "000042"])
        XCTAssertEqual(MarkdownCopyContent.values(in: "ID: `00004"), [])
        XCTAssertEqual(MarkdownCopyContent.values(in: "Escaped \\`plain\\` and [link](https://example.com)."), [])
    }

    func testLiteralBackticksUnicodeAndSpaces() {
        XCTAssertEqual(MarkdownCopyContent.values(in: "`` a`b `` and `café 📍` and `  two spaces  `"), ["a`b", "café 📍", " two spaces "])
    }

    func testInlineWhitespaceNormalization() {
        XCTAssertEqual(MarkdownCopyContent.values(in: "` first\nsecond `"), ["first second"])
    }

    func testLinksAndEmphasisRemainAttributed() {
        let parsed = MarkdownCopyContent.inline("**Label** [link](https://example.com) `000042`")
        XCTAssertTrue(parsed.runs.contains { $0.inlinePresentationIntent?.contains(.stronglyEmphasized) == true })
        XCTAssertTrue(parsed.runs.contains { $0.link == URL(string: "https://example.com") })
        XCTAssertEqual(MarkdownCopyContent.values(in: "**Label** [link](https://example.com) `000042`"), ["000042"])
    }
}
