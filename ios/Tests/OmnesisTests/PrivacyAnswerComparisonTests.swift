// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

/// How a released answer relates to the draft it came from: what the wire says,
/// what survives a shape this client cannot read, and what a reader who sees no
/// colour — or hears the screen rather than seeing it — is told.
final class PrivacyAnswerComparisonTests: XCTestCase {
    // MARK: - Decoding

    /// The three shapes the gateway sends, read back as themselves.
    func testAnswerComparisonDecodesEveryKindItSends() throws {
        XCTAssertEqual(try comparison(from: #"{"kind":"identical"}"#), .identical)
        XCTAssertEqual(
            try comparison(from: #"{"kind":"no_diff","reason":"dissimilar"}"#),
            .noDiff(reason: .dissimilar)
        )
        XCTAssertEqual(
            try comparison(from: #"{"kind":"no_diff","reason":"too_large"}"#),
            .noDiff(reason: .tooLarge)
        )
        XCTAssertEqual(
            try comparison(from: #"""
            {"kind":"diff","lines":[
              {"op":"equal","text":"Thursday afternoon.","spans":null},
              {"op":"removed","text":"At 42 Example Street.","spans":[
                {"op":"equal","text":"At "},
                {"op":"removed","text":"42 Example Street"},
                {"op":"equal","text":"."}
              ]}
            ]}
            """#),
            .diff(lines: [
                PrivacyAnswerDiffLine(op: .equal, text: "Thursday afternoon."),
                PrivacyAnswerDiffLine(
                    op: .removed,
                    text: "At 42 Example Street.",
                    spans: [
                        PrivacyAnswerDiffSpan(op: .equal, text: "At "),
                        PrivacyAnswerDiffSpan(op: .removed, text: "42 Example Street"),
                        PrivacyAnswerDiffSpan(op: .equal, text: "."),
                    ]
                ),
            ])
        )
    }

    /// A comparison this client cannot read renders nothing, and takes nothing
    /// else on the step with it.
    func testAnUnreadableComparisonDegradesToNoneWithoutLosingTheStep() throws {
        let unknownKind = try event(comparison: #"{"kind":"rewritten","lines":[]}"#)
        XCTAssertNil(unknownKind.answerComparison)
        XCTAssertEqual(unknownKind.id, "evt_release")
        XCTAssertEqual(unknownKind.display.title, "Approved answer released")

        // A diff with no lines has nothing to say, and its heading over an empty
        // block would say a comparison was drawn.
        let emptyDiff = try event(comparison: #"{"kind":"diff","lines":[]}"#)
        XCTAssertNil(emptyDiff.answerComparison)

        // A line op it does not know invalidates the whole comparison: a diff
        // rendered from the lines it did understand would assert an edit that
        // dropped whatever the unread line said.
        let unknownLineOp = try event(comparison: #"""
        {"kind":"diff","lines":[
          {"op":"equal","text":"Thursday afternoon.","spans":null},
          {"op":"moved","text":"Near the venue.","spans":null}
        ]}
        """#)
        XCTAssertNil(unknownLineOp.answerComparison)
    }

    /// A span it cannot read costs the line its breakdown, not its text: the
    /// spans only ever re-say the line in more detail.
    func testAnUnreadableSpanKeepsTheLineAndDropsOnlyItsBreakdown() throws {
        let decoded = try comparison(from: #"""
        {"kind":"diff","lines":[
          {"op":"removed","text":"At 42 Example Street.","spans":[
            {"op":"equal","text":"At "},
            {"op":"moved","text":"42 Example Street"},
            {"op":"equal","text":"."}
          ]}
        ]}
        """#)
        XCTAssertEqual(
            decoded,
            .diff(lines: [
                PrivacyAnswerDiffLine(op: .removed, text: "At 42 Example Street.", spans: nil),
            ])
        )
    }

    /// Spans that do not re-join into the line describe some other line.
    /// Highlighting words from them would claim an edit this line never had.
    func testSpansThatDoNotRejoinIntoTheLineAreDropped() throws {
        let decoded = try comparison(from: #"""
        {"kind":"diff","lines":[
          {"op":"added","text":"Near the venue.","spans":[
            {"op":"equal","text":"Somewhere else entirely."}
          ]}
        ]}
        """#)
        XCTAssertEqual(
            decoded,
            .diff(lines: [PrivacyAnswerDiffLine(op: .added, text: "Near the venue.", spans: nil)])
        )
    }

    /// Null spans mean the line has no counterpart, and an absent or null
    /// comparison means none was computed — never that nothing changed.
    func testAbsentAndNullDegradeToNoComparison() throws {
        XCTAssertNil(try event(comparison: nil).answerComparison)
        XCTAssertNil(try event(comparison: "null").answerComparison)
        XCTAssertEqual(
            try comparison(from: #"{"kind":"diff","lines":[{"op":"equal","text":"A line."}]}"#),
            .diff(lines: [PrivacyAnswerDiffLine(op: .equal, text: "A line.", spans: nil)])
        )
    }

    /// A reason a newer gateway invented still means there is no comparison to
    /// show, so the step keeps saying so rather than falling silent.
    func testAnUnknownNoDiffReasonStillReadsAsNoComparison() throws {
        XCTAssertEqual(
            try comparison(from: #"{"kind":"no_diff","reason":"abandoned"}"#),
            .noDiff(reason: .unspecified)
        )
        XCTAssertEqual(
            try comparison(from: #"{"kind":"no_diff"}"#),
            .noDiff(reason: .unspecified)
        )
    }

    // MARK: - Wording

    /// Every branch describes what the comparison did, never what the answer
    /// contains: `no_diff` is not a finding that the answer was rewritten.
    func testComparisonCopyDescribesTheComparisonRatherThanTheAnswer() {
        XCTAssertEqual(
            privacyAnswerComparisonCopy(.identical).title,
            "This answer left exactly as drafted."
        )
        XCTAssertNil(privacyAnswerComparisonCopy(.identical).detail)
        XCTAssertNil(privacyAnswerComparisonCopy(.diff(lines: [])).detail)

        let dissimilar = privacyAnswerComparisonCopy(.noDiff(reason: .dissimilar))
        let tooLarge = privacyAnswerComparisonCopy(.noDiff(reason: .tooLarge))
        let unspecified = privacyAnswerComparisonCopy(.noDiff(reason: .unspecified))
        XCTAssertEqual(dissimilar.title, tooLarge.title)
        XCTAssertNotEqual(dissimilar.detail, tooLarge.detail)
        for copy in [dissimilar, tooLarge, unspecified] {
            let detail = copy.detail ?? ""
            XCTAssertFalse(detail.isEmpty)
            XCTAssertFalse(detail.contains("rewritten"))
            XCTAssertTrue(detail.contains("shown in full above"))
        }
    }

    /// Removed and added must separate for a reader who sees no colour at all.
    func testMarkersAndLegendCarryTheDistinctionWithoutColour() {
        XCTAssertNotEqual(
            privacyAnswerDiffMarker(.removed),
            privacyAnswerDiffMarker(.added)
        )
        XCTAssertEqual(privacyAnswerDiffMarker(.equal), " ")

        let plain = [PrivacyAnswerDiffLine(op: .removed, text: "A dropped line.")]
        XCTAssertEqual(privacyAnswerDiffLegend(plain).count, 2)
        // The strike/underline key appears only where a line actually carries a
        // word-level breakdown to explain.
        let spanned = plain + [
            PrivacyAnswerDiffLine(
                op: .added,
                text: "Near the venue.",
                spans: [PrivacyAnswerDiffSpan(op: .added, text: "Near the venue.")]
            ),
        ]
        XCTAssertEqual(privacyAnswerDiffLegend(spanned).count, 3)
        XCTAssertEqual(privacyAnswerDiffLegend(spanned)[2].contains("struck-through"), true)
    }

    /// A listener gets the side and the changed words as words, never as a
    /// marker or a colour they cannot perceive.
    func testVoiceOverSpeaksWhichSideEachLineIsOn() {
        XCTAssertEqual(
            privacyAnswerDiffLineLabel(PrivacyAnswerDiffLine(op: .equal, text: "Thursday.")),
            "Unchanged. Thursday."
        )
        XCTAssertEqual(
            privacyAnswerDiffLineLabel(PrivacyAnswerDiffLine(op: .removed, text: "By Tuesday.")),
            "In the draft only. By Tuesday."
        )
        XCTAssertEqual(
            privacyAnswerDiffLineLabel(PrivacyAnswerDiffLine(op: .added, text: "Near the venue.")),
            "In what was sent only. Near the venue."
        )
        XCTAssertEqual(
            privacyAnswerDiffLineLabel(
                PrivacyAnswerDiffLine(
                    op: .removed,
                    text: "At 42 Example Street.",
                    spans: [
                        PrivacyAnswerDiffSpan(op: .equal, text: "At "),
                        PrivacyAnswerDiffSpan(op: .removed, text: "42 Example Street"),
                        PrivacyAnswerDiffSpan(op: .equal, text: "."),
                    ]
                )
            ),
            "Draft line. At 42 Example Street. Removed: 42 Example Street."
        )
        XCTAssertEqual(
            privacyAnswerDiffLineLabel(
                PrivacyAnswerDiffLine(
                    op: .added,
                    text: "Near the venue.",
                    spans: [
                        PrivacyAnswerDiffSpan(op: .added, text: "Near the venue"),
                        PrivacyAnswerDiffSpan(op: .equal, text: "."),
                    ]
                )
            ),
            "Sent line. Near the venue. Added: Near the venue."
        )
    }

    /// A reduction can be exactly a run of spaces, and a dropped blank line is
    /// still a drop. Neither may pass in silence.
    func testWhitespaceOnlyDifferencesAreSpokenRatherThanSkipped() {
        XCTAssertEqual(
            privacyAnswerDiffLineLabel(PrivacyAnswerDiffLine(op: .removed, text: "   ")),
            "In the draft only. Blank line."
        )
        XCTAssertEqual(
            privacyAnswerDiffLineLabel(
                PrivacyAnswerDiffLine(
                    op: .removed,
                    text: "About  20 minutes.",
                    spans: [
                        PrivacyAnswerDiffSpan(op: .equal, text: "About"),
                        PrivacyAnswerDiffSpan(op: .removed, text: "  "),
                        PrivacyAnswerDiffSpan(op: .equal, text: "20 minutes."),
                    ]
                )
            ),
            "Draft line. About  20 minutes. Removed: spacing."
        )
    }

    private func comparison(from json: String) throws -> PrivacyAnswerComparison {
        try XCTUnwrap(event(comparison: json).answerComparison)
    }

    private func event(comparison: String?) throws -> PrivacyAuditEventSummary {
        let field = comparison.map { ",\"answerComparison\": \($0)" } ?? ""
        let json = """
        {
          "id": "evt_release",
          "taskId": "task_release",
          "kind": "released",
          "createdAt": 1786852236000,
          "display": { "title": "Approved answer released" }
          \(field)
        }
        """
        return try JSONDecoder().decode(
            PrivacyAuditEventSummary.self,
            from: Data(json.utf8)
        )
    }
}
