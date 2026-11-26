// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import DesktopCore
import XCTest

final class AnswerPresentationTests: XCTestCase {
    func testReadableBlocksRetainEvidenceAndIncompleteStreamingCode() {
        XCTAssertEqual(
            DesktopAnswerBlock
                .parse(
                    "## Summary\n\nFirst **finding**.\n\n- [Source](https://example.com/source)\n2. Next\n> Note\n```text\nnot executed"
                ),
            [
                .heading("Summary"), .paragraph("First **finding**."), .bullet("[Source](https://example.com/source)"),
                .numbered("2", "Next"), .quote("Note"), .code("not executed"),
            ]
        )
        XCTAssertEqual(DesktopAnswerBlock.parse("```swift\nlet x = 1\n```\n\nDone"), [.code("let x = 1"), .paragraph("Done")])
    }

    func testAnswerLinksCannotOpenLocalFilesOrExecuteSchemes() throws {
        for value in [
            "file:///tmp/example",
            "javascript:alert(1)",
            "https://user:secret@example.com",
            "http://example.com",
            "omnesis://delete",
        ] {
            XCTAssertFalse(try DesktopAnswerBlock.allowsLink(XCTUnwrap(URL(string: value))))
        }
        XCTAssertTrue(try DesktopAnswerBlock.allowsLink(XCTUnwrap(URL(string: "https://example.com/evidence"))))
    }
}
