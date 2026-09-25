// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

/// Whether a row carries a mark, decided by the gateway rather than by this
/// build's idea of the vocabulary.
///
/// The failure this exists for is silent and one-directional: a phone that
/// decided from a list of names it was compiled with renders **nothing at all**
/// for a verdict a newer gateway learned to raise — on the one surface whose
/// whole job is to raise it. Every case below is that skew, from both ends.
final class WatchVerdictMarkTests: XCTestCase {
    private func verdict(
        _ name: String,
        label: String? = nil,
        actionable: Bool? = nil
    )
        -> WatchVerdict {
        WatchVerdict(name: name, because: "a sentence with its numbers", label: label, actionable: actionable)
    }

    func testMarksAVerdictThisBuildHasNeverHeardOf() {
        // The whole point. A name from a newer gateway, marked with the word
        // that gateway chose, on a phone that knows nothing about it.
        let mark = verdict("arm-drifted", label: "Arm has drifted", actionable: true).mark

        XCTAssertEqual(mark, "Arm has drifted")
    }

    func testDoesNotMarkAVerdictTheGatewayCallsOrdinary() {
        XCTAssertNil(verdict("healthy", label: "Working", actionable: false).mark)
        XCTAssertNil(verdict("stopped", label: "Stopped", actionable: false).mark)
    }

    func testFallsBackToTheNameWhenTheGatewaySentNoWord() {
        // A bare name is still something an operator can act on; an empty mark
        // is a row that says a watch needs attention and will not say which.
        XCTAssertEqual(verdict("silent-risk", actionable: true).mark, "silent-risk")
        XCTAssertEqual(verdict("silent-risk", label: "", actionable: true).mark, "silent-risk")
    }

    func testMarksNothingOnAGatewayThatPredatesTheField() {
        // Neither field sent. Reading that as "nothing to do" is what an older
        // gateway's `healthy` and `resting` meant, which is most of its rows.
        XCTAssertNil(verdict("never-matched").mark)
    }

    func testDecodesTheFieldsOffTheWire() throws {
        let json = """
        {"name":"never-matched","because":"looked at 4,183 events over 21 days and admitted none",\
        "label":"Never matched","actionable":true}
        """
        let decoded = try JSONDecoder().decode(WatchVerdict.self, from: Data(json.utf8))

        XCTAssertEqual(decoded.mark, "Never matched")
    }

    func testDecodesAPayloadWithoutThem() throws {
        // Forward-compatible in the other direction: a phone this new against a
        // gateway that is not must still render the row.
        let json = #"{"name":"healthy","because":"fired 3 times, most recently 2 days ago"}"#
        let decoded = try JSONDecoder().decode(WatchVerdict.self, from: Data(json.utf8))

        XCTAssertNil(decoded.mark)
        XCTAssertEqual(decoded.because, "fired 3 times, most recently 2 days ago")
    }
}
