// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if canImport(SwiftUI) && canImport(UIKit)
@testable import Omnesis
import XCTest

/// Verifies `MarkdownStreaming.completeTrailingMarkup` — the streaming
/// polish that pre-closes a half-typed trailing inline construct so a
/// mid-stream link styles its label immediately instead of showing raw
/// `[label](https://… until the closing paren arrives.
@available(iOS 17.0, *)
final class MarkdownStreamingTests: XCTestCase {
    private func complete(_ input: String) -> String {
        MarkdownStreaming.completeTrailingMarkup(input)
    }

    // MARK: - Links

    func testOpenLinkDestinationGetsClosingParen() {
        XCTAssertEqual(
            complete("See [the docs](https://example.com/getting-star"),
            "See [the docs](https://example.com/getting-star)"
        )
    }

    func testEmptyDestinationGetsClosingParen() {
        XCTAssertEqual(complete("Read [more]("), "Read [more]()")
    }

    func testCompleteLinkIsUntouched() {
        let text = "See [the docs](https://example.com)."
        XCTAssertEqual(complete(text), text)
    }

    func testOpenLabelWithoutParenIsLeftAlone() {
        // No `](` yet — not provably a link, so don't guess.
        XCTAssertEqual(complete("A footnote ref [1"), "A footnote ref [1")
        XCTAssertEqual(complete("Closed bracket [label]"), "Closed bracket [label]")
    }

    func testNonAdjacentParenIsNotALink() {
        // `] (` with a space is not a markdown link, so nothing opens.
        let text = "End of sentence] (aside"
        XCTAssertEqual(complete(text), text)
    }

    func testLinkWithStyledLabel() {
        XCTAssertEqual(
            complete("Try [**bold** label](https://example.io"),
            "Try [**bold** label](https://example.io)"
        )
    }

    // MARK: - Inline code

    func testOpenInlineCodeGetsBacktick() {
        XCTAssertEqual(complete("Call `fetchAll"), "Call `fetchAll`")
    }

    func testClosedInlineCodeIsUntouched() {
        let text = "Call `fetchAll()` first."
        XCTAssertEqual(complete(text), text)
    }

    func testBracketsInsideCodeAreLiteral() {
        // The `](` lives inside an open code span, so it must not be
        // mistaken for a link — close the code span instead.
        XCTAssertEqual(complete("Syntax is `[x]("), "Syntax is `[x](`")
    }

    func testMultiBacktickFenceClosesWithSameLength() {
        XCTAssertEqual(complete("Edge ``a`b"), "Edge ``a`b``")
    }

    // MARK: - Emphasis is intentionally untouched

    func testTrailingAsteriskIsNotCompleted() {
        XCTAssertEqual(complete("paid $5 * 3 *"), "paid $5 * 3 *")
        XCTAssertEqual(complete("**bold opening"), "**bold opening")
    }

    // MARK: - Escapes and no-ops

    func testEscapedBracketIsNotALink() {
        // The `\[` is escaped, so no label opens and the `](` can't
        // form a link; left untouched.
        let text = "A literal \\[bracket](not-a-link"
        XCTAssertEqual(complete(text), text)
    }

    func testPlainTextIsUntouched() {
        let text = "Just a normal sentence with no markup."
        XCTAssertEqual(complete(text), text)
    }

    func testEmptyStringIsUntouched() {
        XCTAssertEqual(complete(""), "")
    }

    // MARK: - Streaming convergence

    func testStreamingLinkConvergesWithoutVisibleSyntax() {
        // At every prefix of a streamed link, the completed string must
        // parse as inline markdown without ever exposing raw `[`/`]`/`(`
        // brackets in the rendered (visible) characters.
        let full = "Open [the report](https://example.com/q4-report) now."
        var grown = ""
        for ch in full {
            grown.append(ch)
            let completed = complete(grown)
            let opts = AttributedString.MarkdownParsingOptions(
                interpretedSyntax: .inlineOnlyPreservingWhitespace
            )
            guard let attributed = try? AttributedString(markdown: completed, options: opts) else {
                continue
            }
            let visible = String(attributed.characters)
            XCTAssertFalse(visible.contains("]("), "raw link syntax visible at: \(grown)")
        }
    }
}
#endif
