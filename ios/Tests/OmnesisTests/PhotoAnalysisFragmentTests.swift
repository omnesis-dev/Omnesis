// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

final class PhotoAnalysisFragmentTests: XCTestCase {
    func testMergeConcatenatesTextLinesAndTags() {
        let ocr = PhotoAnalysisFragment(textLines: ["hello"], tags: [])
        let labels = PhotoAnalysisFragment(textLines: [], tags: ["beach", "sunset"])
        let merged = PhotoAnalysisFragment.merge([ocr, labels])
        XCTAssertEqual(merged.textLines, ["hello"])
        XCTAssertEqual(merged.tags, ["beach", "sunset"])
    }

    func testMergeLastPlaceNameWins() {
        let first = PhotoAnalysisFragment(placeName: "Paris")
        let second = PhotoAnalysisFragment(placeName: nil)
        // Only one analyzer (PlaceAnalyzer) ever sets placeName in
        // practice, but merge order shouldn't silently drop a later nil
        // over an earlier real value.
        let merged = PhotoAnalysisFragment.merge([first, second])
        XCTAssertEqual(merged.placeName, "Paris")
    }

    func testMergeUnionsExtraKeepingLaterOnConflict() {
        let first = PhotoAnalysisFragment(extra: ["latitude": .double(1), "shared": .string("a")])
        let second = PhotoAnalysisFragment(extra: ["longitude": .double(2), "shared": .string("b")])
        let merged = PhotoAnalysisFragment.merge([first, second])
        XCTAssertEqual(merged.extra["latitude"], .double(1))
        XCTAssertEqual(merged.extra["longitude"], .double(2))
        XCTAssertEqual(merged.extra["shared"], .string("b"))
    }

    func testMergeOfEmptyListIsEmptyFragment() {
        let merged = PhotoAnalysisFragment.merge([])
        XCTAssertTrue(merged.textLines.isEmpty)
        XCTAssertTrue(merged.tags.isEmpty)
        XCTAssertNil(merged.placeName)
        XCTAssertTrue(merged.extra.isEmpty)
    }
}
