// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if canImport(SwiftUI) && canImport(UIKit)
@testable import Omnesis
import UIKit
import XCTest

/// Verifies that `MarkdownCache` returns the same blocks as a fresh
/// `MarkdownParser.parse(text)` would for every step of a streaming
/// append. The cache exists for perf; correctness is "identical
/// output to the non-cached path."
@available(iOS 17.0, *)
@MainActor
final class MarkdownCacheTests: XCTestCase {
    func testCopyFencesPreservePayloadAndRequireMatchingCloser() {
        XCTAssertEqual(MarkdownParser.parse("```\n\n  000042  \n```"), [.code("\n  000042  \n", closed: true)])
        XCTAssertEqual(MarkdownParser.parse("````\na`b\n```\n````"), [.code("a`b\n```\n", closed: true)])
        XCTAssertEqual(MarkdownParser.parse("~~~\n42 Example Street\n~~~"), [.code("42 Example Street\n", closed: true)])
        XCTAssertEqual(MarkdownParser.parse("```\n00004"), [.code("00004\n", closed: false)])
        XCTAssertEqual(MarkdownParser.parse("```\n00004\n```unfinished"), [.code("00004\n```unfinished\n", closed: false)])
    }

    func testInlineCopyWritesOnlyExactValueAndPreservesLinks() throws {
        let view = MarkdownCopyTextView()
        view.update(raw: "**Reference:** `000042` [link](https://example.com)", font: .systemFont(ofSize: 15), color: .label)
        view.frame = CGRect(x: 0, y: 0, width: 280, height: 160)
        view.layoutIfNeeded()
        let buttons = view.subviews.compactMap { $0 as? UIButton }
        XCTAssertEqual(buttons.count, 1)
        XCTAssertEqual(buttons.first?.accessibilityLabel, "Copy 000042")
        XCTAssertTrue(view.textView.isSelectable)
        XCTAssertEqual(view.accessibilityElements?.count, 2)
        var links: [URL] = []
        view.textView.attributedText.enumerateAttribute(.link, in: NSRange(
            location: 0,
            length: view.textView.attributedText.length
        )) { value, _, _ in
            if let url = value as? URL { links.append(url) }
        }
        XCTAssertEqual(links, try [XCTUnwrap(URL(string: "https://example.com"))])
        let previous = UIPasteboard.general.string
        defer { UIPasteboard.general.string = previous }
        buttons.first?.sendActions(for: .touchUpInside)
        XCTAssertEqual(UIPasteboard.general.string, "000042")
        XCTAssertEqual(buttons.first?.accessibilityLabel, "Copied 000042")
    }

    func testUnclosedInlineCodeDoesNotCreateCopyButton() {
        let view = MarkdownCopyTextView()
        view.update(raw: "Reference: `00004", font: .systemFont(ofSize: 15), color: .label)
        XCTAssertTrue(view.subviews.compactMap { $0 as? UIButton }.isEmpty)
    }

    func testFencedBlankLinesNeverBecomeStablePrefixBoundaries() {
        let text = "Before.\n\n```\n\n42 Example Street\n\nExampleville\n```\n\nAfter."
        let cache = MarkdownCache()
        var prefix = ""
        for character in text {
            prefix.append(character)
            XCTAssertEqual(cache.blocks(for: prefix), MarkdownParser.parse(prefix), "Diverged for \(prefix.debugDescription)")
        }
        XCTAssertEqual(cache.blocks(for: text), [
            .paragraph("Before."), .code("\n42 Example Street\n\nExampleville\n", closed: true), .paragraph("After."),
        ])
    }

    func testSingleLineFeedsNeverFreezeAnUnfinishedParagraph() {
        let text = "First line\nsecond line\nthird line\n\nNext paragraph.\nwith another line."
        let cache = MarkdownCache()
        var prefix = ""
        for character in text {
            prefix.append(character)
            XCTAssertEqual(cache.blocks(for: prefix), MarkdownParser.parse(prefix), "Diverged for \(prefix.debugDescription)")
        }
    }

    func testCodePayloadNormalizesSourceLineEndings() {
        for lineEnding in ["\r\n", "\r"] {
            let text = ["Before.", "", "```", "", "42 Example Street", "Exampleville", "```", "", "After."].joined(separator: lineEnding)
            let cache = MarkdownCache()
            var prefix = ""
            for character in text {
                prefix.append(character)
                XCTAssertEqual(cache.blocks(for: prefix), MarkdownParser.parse(prefix))
            }
            XCTAssertEqual(cache.blocks(for: text), [
                .paragraph("Before."), .code("\n42 Example Street\nExampleville\n", closed: true), .paragraph("After."),
            ])
        }
    }

    func testEmptyText() {
        let cache = MarkdownCache()
        XCTAssertEqual(cache.blocks(for: ""), [])
    }

    func testIdenticalTextReturnsCached() {
        let cache = MarkdownCache()
        let text = "Hello world"
        let first = cache.blocks(for: text)
        let second = cache.blocks(for: text)
        XCTAssertEqual(first, second)
        XCTAssertEqual(first, MarkdownParser.parse(text))
    }

    func testStreamingAppendMatchesFreshParse() {
        // Representative of the swim-progress demo reply: headings,
        // paragraphs, two tables. Streamed in the same 4-char chunks
        // the replay backend uses. Cached output must equal a fresh
        // parse at every step.
        let full = """
        Here's a breakdown — encouraging signs!

        ## Performance

        | Date | Distance |
        | --- | --- |
        | Apr 22 | 500m |
        | Apr 29 | 500m |

        ## Heart Rate

        Three sessions had HR data.

        | Date | Z1 |
        | --- | --- |
        | Apr 29 | 374s |

        End.
        """
        let cache = MarkdownCache()
        var grown = ""
        for chunk in chunks(of: full, size: 4) {
            grown += chunk
            let cached = cache.blocks(for: grown)
            let fresh = MarkdownParser.parse(grown)
            XCTAssertEqual(cached, fresh, "diverged at length \(grown.count)")
        }
    }

    func testInlineCacheHitsRepeatedText() {
        let cache = MarkdownCache()
        let raw = "A paragraph with **bold**."
        let first = cache.inline(raw)
        let second = cache.inline(raw)
        // `AttributedString` is Equatable; both calls return the same
        // content. The point is correctness — perf is verified by
        // construction (the second call skips the parser).
        XCTAssertEqual(first, second)
    }

    func testNonAppendDivergenceFullyResets() {
        let cache = MarkdownCache()
        _ = cache.blocks(for: "first version\n\npara two")
        let switched = cache.blocks(for: "completely different\n\nbody")
        XCTAssertEqual(switched, MarkdownParser.parse("completely different\n\nbody"))
    }

    // MARK: - Helpers

    private func chunks(of s: String, size: Int) -> [String] {
        var out: [String] = []
        var idx = s.startIndex
        while idx < s.endIndex {
            let end = s.index(idx, offsetBy: size, limitedBy: s.endIndex) ?? s.endIndex
            out.append(String(s[idx ..< end]))
            idx = end
        }
        return out
    }
}
#endif
