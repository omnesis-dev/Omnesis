// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
@testable import OmnesisDesktop
import XCTest

final class DesktopChatLayoutTests: XCTestCase {
    func testSourcesFitMinimumAndFittedWindowWithoutShrinkingReadingBelowItsBudget() {
        // The root sidebar may use its full 260 points in the 860-point window.
        for width in [CGFloat(599), 632, 796] {
            for history in [false, true] {
                let layout = DesktopChatLayout(width: width, historyRequested: history, sourcesRequested: true)
                XCTAssertTrue(layout.showsSources)
                XCTAssertFalse(layout.showsHistory)
                XCTAssertGreaterThanOrEqual(layout.readingWidth, 320)
                XCTAssertGreaterThanOrEqual(layout.sourcesWidth, 260)
                XCTAssertLessThanOrEqual(layout.sourcesWidth, 320)
                XCTAssertEqual(layout.readingWidth + layout.sourcesWidth + 1, width, accuracy: 0.001)
            }
        }
    }

    func testWideDetailCanKeepHistoryReadingAndSourcesVisible() {
        for width in [CGFloat(852), 1000, 1400] {
            let layout = DesktopChatLayout(width: width, historyRequested: true, sourcesRequested: true)
            XCTAssertTrue(layout.showsHistory)
            XCTAssertTrue(layout.showsSources)
            XCTAssertGreaterThanOrEqual(layout.readingWidth, 400)
            XCTAssertEqual(190 + 1 + layout.readingWidth + 1 + layout.sourcesWidth, width, accuracy: 0.001)
        }
    }

    func testClosingSourcesRestoresRequestedHistoryWithoutLosingReadingSpace() {
        let open = DesktopChatLayout(width: 632, historyRequested: true, sourcesRequested: true)
        let closed = DesktopChatLayout(width: 632, historyRequested: true, sourcesRequested: false)
        XCTAssertFalse(open.showsHistory)
        XCTAssertTrue(closed.showsHistory)
        XCTAssertFalse(closed.showsSources)
        XCTAssertEqual(closed.readingWidth, 441)
        let reopened = DesktopChatLayout(width: 632, historyRequested: true, sourcesRequested: true)
        XCTAssertEqual(reopened, open)
    }

    func testUnsupportedNarrowSourceViewportNeverForcesOutwardMinimumOrOverlapsReading() {
        for width in [CGFloat(1), 240, 580] {
            let layout = DesktopChatLayout(width: width, historyRequested: true, sourcesRequested: true)
            XCTAssertFalse(layout.showsReading)
            XCTAssertFalse(layout.showsHistory)
            XCTAssertEqual(layout.sourcesWidth, width)
        }
        let boundary = DesktopChatLayout(width: 581, historyRequested: false, sourcesRequested: true)
        XCTAssertEqual(boundary.readingWidth, 320)
        XCTAssertEqual(boundary.sourcesWidth, 260)
    }

    func testInvalidGeometryCannotPublishInfiniteOrNegativeColumnWidths() {
        for width in [CGFloat(0), -1, .nan, .infinity, -.infinity] {
            for sources in [false, true] {
                let layout = DesktopChatLayout(width: width, historyRequested: true, sourcesRequested: sources)
                XCTAssertEqual(layout.readingWidth, 0)
                XCTAssertEqual(layout.sourcesWidth, 0)
                XCTAssertFalse(layout.showsReading)
                XCTAssertFalse(layout.showsHistory)
                XCTAssertFalse(layout.showsSources)
            }
        }
    }
}
