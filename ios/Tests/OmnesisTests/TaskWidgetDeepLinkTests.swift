// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

final class TaskWidgetDeepLinkTests: XCTestCase {
    func testRoundTripPreservesDayAndOpaqueTaskId() throws {
        let link = TaskWidgetDeepLink(view: .today, day: "2027-01-02", taskId: "task:/a?b&c")
        XCTAssertEqual(try XCTUnwrap(TaskWidgetDeepLink(url: link.url)), link)
    }

    func testMonthLinkNeedsNoTask() throws {
        let link = TaskWidgetDeepLink(view: .month, day: "2027-02-01")
        XCTAssertEqual(try XCTUnwrap(TaskWidgetDeepLink(url: link.url)), link)
    }

    func testRejectsMalformedOrAmbiguousLinks() throws {
        for raw in [
            "https://tasks?view=today&date=2026-10-14",
            "omnesis://tasks/path?view=today&date=2026-10-14",
            "omnesis://tasks?view=suggested&date=2026-10-14",
            "omnesis://tasks?view=today&date=2026-02-30",
            "omnesis://tasks?view=today&date=2026-13-01",
            "omnesis://tasks?view=today&date=2026-10-14&date=2026-10-15",
            "omnesis://tasks?view=today&date=2026-10-14&task=",
            "omnesis://tasks?view=today&date=2026-10-14&task=%0A",
            "omnesis://tasks?view=today&date=2026-10-14&token=secret",
            "omnesis://tasks?view=today&date=2026-10-14#fragment",
        ] {
            XCTAssertNil(try TaskWidgetDeepLink(url: XCTUnwrap(URL(string: raw))), raw)
        }
    }

    func testLeapDayValidation() {
        XCTAssertTrue(TaskWidgetDeepLink.validDay("2028-02-29"))
        XCTAssertFalse(TaskWidgetDeepLink.validDay("2027-02-29"))
        XCTAssertFalse(TaskWidgetDeepLink.validDay("2026-1-02"))
    }
}
