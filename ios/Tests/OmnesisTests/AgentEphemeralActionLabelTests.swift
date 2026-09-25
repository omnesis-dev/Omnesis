// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

final class AgentEphemeralActionLabelTests: XCTestCase {
    func testDocumentAndPersonMemoryActionsStayDistinct() {
        for (document, person, verb) in [
            ("annotate_durable", "annotate_person", "Remember"),
            ("annotation_revise", "person_annotation_revise", "Update"),
            ("annotation_retract", "person_annotation_retract", "Forget"),
            ("annotation_supersede", "person_annotation_supersede", "Replace"),
        ] {
            let suffix = verb == "Remember" ? "" : " memory"
            XCTAssertEqual(AgentEphemeralActionLabel.label(for: document), "\(verb) document\(suffix)")
            XCTAssertEqual(AgentEphemeralActionLabel.label(for: person), "\(verb) person\(suffix)")
        }
    }

    func testDateAliasesKeepTheSameDisplayVerb() {
        for (temporal, timeIndex, label) in [
            ("temporal_query", "time_index_query", "Check dates"),
            ("temporal_annotation_add", "time_index_add", "Add date note"),
            ("temporal_annotation_update", "time_index_update", "Update date note"),
            ("temporal_annotation_delete", "time_index_delete", "Remove date note"),
        ] {
            XCTAssertEqual(AgentEphemeralActionLabel.label(for: temporal), label)
            XCTAssertEqual(AgentEphemeralActionLabel.label(for: timeIndex), label)
        }
    }

    func testUnknownToolKeepsItsNameWithoutMatchingAPrefix() {
        XCTAssertEqual(AgentEphemeralActionLabel.label(for: "annotation_future_action"), "annotation_future_action")
        XCTAssertEqual(AgentEphemeralActionLabel.label(for: ""), "")
    }
}
