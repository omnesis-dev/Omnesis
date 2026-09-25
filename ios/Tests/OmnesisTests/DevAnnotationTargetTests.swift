// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

/// Pure-logic coverage for the developer-annotations iOS model: the target
/// factory helpers and the `/status` `developer` flag decode. Runs on the
/// sim-less macOS logic lane — no UIKit, no simulator.
final class DevAnnotationTargetTests: XCTestCase {
    func testFactoryHelpersCarryTypeIdAndLabel() {
        let doc = DevAnnotationTarget.document("doc-1", label: "Re: Q4 budget review")
        XCTAssertEqual(doc.type, "document")
        XCTAssertEqual(doc.id, "doc-1")
        XCTAssertEqual(doc.label, "Re: Q4 budget review")

        XCTAssertEqual(DevAnnotationTarget.brief("b-1").type, "brief")
        XCTAssertEqual(DevAnnotationTarget.openLoop("l-1").type, "open_loop")
        XCTAssertEqual(DevAnnotationTarget.retiredLoop("rl-1").type, "retired_loop")
        XCTAssertEqual(DevAnnotationTarget.agentRun("r-1").type, "agent_run")
        XCTAssertEqual(DevAnnotationTarget.firing("f-1").type, "firing")
        XCTAssertEqual(
            DevAnnotationTarget.temporalAnnotation("ta-1").type,
            "temporal_annotation"
        )
        XCTAssertEqual(DevAnnotationTarget.conversation("c-1").type, "conversation")
    }

    func testDefaultLabelsFallBackToNounPlusId() {
        XCTAssertEqual(DevAnnotationTarget.openLoop("l-9").label, "Loop l-9")
        XCTAssertEqual(DevAnnotationTarget.brief("b-9").label, "Brief b-9")
    }

    func testRouteTargetHasNoId() {
        let route = DevAnnotationTarget.route("iOS app")
        XCTAssertEqual(route.type, "route")
        XCTAssertNil(route.id)
        XCTAssertEqual(route.label, "iOS app")
    }

    func testAgentNotesTargetHasNoId() {
        let notes = DevAnnotationTarget.agentNotes()
        XCTAssertEqual(notes.type, "agent_notes")
        XCTAssertNil(notes.id)
    }

    func testStatusSnapshotDecodesDeveloperFlag() throws {
        let on = try decodeStatus(#"{"documents":{"total":0,"bySource":{}},"developer":true}"#)
        XCTAssertTrue(on.developer)

        let off = try decodeStatus(#"{"documents":{"total":0,"bySource":{}},"developer":false}"#)
        XCTAssertFalse(off.developer)
    }

    func testStatusSnapshotDefaultsDeveloperToFalseWhenMissing() throws {
        // A gateway that predates developer mode omits the field entirely.
        let snap = try decodeStatus(#"{"documents":{"total":0,"bySource":{}}}"#)
        XCTAssertFalse(snap.developer)
    }

    private func decodeStatus(_ json: String) throws -> StatusSnapshot {
        try JSONDecoder().decode(StatusSnapshot.self, from: Data(json.utf8))
    }
}
