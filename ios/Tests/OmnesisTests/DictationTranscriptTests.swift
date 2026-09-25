// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

/// Pins the resume-dictation composition rule: the recognizer resets
/// its transcript on every (re)start, so partials compose onto the text
/// committed before the restart — stopping and resuming the mic must
/// never wipe what was already captured.
final class DictationTranscriptTests: XCTestCase {
    func testFirstRunPassesPartialThrough() {
        XCTAssertEqual(DictationTranscript.compose(base: "", partial: "buy oat milk"), "buy oat milk")
    }

    func testResumeAppendsPartialToBase() {
        XCTAssertEqual(
            DictationTranscript.compose(base: "buy oat milk", partial: "and book the dentist"),
            "buy oat milk and book the dentist"
        )
    }

    func testEmptyPartialKeepsBaseUntouched() {
        XCTAssertEqual(DictationTranscript.compose(base: "buy oat milk", partial: ""), "buy oat milk")
        XCTAssertEqual(DictationTranscript.compose(base: "buy oat milk", partial: "   \n"), "buy oat milk")
    }

    func testSeamWhitespaceIsNormalizedToOneSpace() {
        XCTAssertEqual(
            DictationTranscript.compose(base: "typed a bit  ", partial: "  then spoke"),
            "typed a bit then spoke"
        )
    }

    func testWhitespaceOnlyBaseActsAsEmpty() {
        XCTAssertEqual(DictationTranscript.compose(base: "  \n", partial: "hello"), "hello")
    }

    func testBothEmptyStaysEmpty() {
        XCTAssertEqual(DictationTranscript.compose(base: "", partial: ""), "")
    }

    func testSuccessivePartialsReplaceNotAccumulate() {
        // Live partials each re-compose from the same base — a longer
        // partial supersedes the previous render rather than stacking.
        let base = "first thought"
        let render1 = DictationTranscript.compose(base: base, partial: "second")
        let render2 = DictationTranscript.compose(base: base, partial: "second thought entirely")
        XCTAssertEqual(render1, "first thought second")
        XCTAssertEqual(render2, "first thought second thought entirely")
    }
}
