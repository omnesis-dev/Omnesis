// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if canImport(SwiftUI) && canImport(UIKit)
@testable import Omnesis
import XCTest

/// Verifies that `MarkdownCache` returns the same blocks as a fresh
/// `MarkdownParser.parse(text)` would for every step of a streaming
/// append. The cache exists for perf; correctness is "identical
/// output to the non-cached path."
@available(iOS 17.0, *)
@MainActor
final class MarkdownCacheTests: XCTestCase {
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
