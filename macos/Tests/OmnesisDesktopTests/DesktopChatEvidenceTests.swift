// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Omnesis
@testable import OmnesisDesktop
import XCTest

final class DesktopChatEvidenceTests: XCTestCase {
    func testSearchHitsAreNotCitationsAndPersistedAnnotationsRebuildTheSourceSet() {
        let ref = AgentDocRef(documentId: "fictional-document", sourceType: "example", sourceId: "example:notes", title: "Fictional plan")
        let search = AgentToolResult.searchResults(query: "fictional plan", durationMs: 1, candidates: 1, results: [ref])
        XCTAssertTrue(DesktopChatEvidence.annotations(in: search).isEmpty)
        let annotation = AgentToolResult.annotateRecorded(
            documentId: ref.documentId,
            ref: ref,
            quote: nil,
            note: nil,
            quoteAuthor: nil,
            quoteIsSelf: false
        )
        let messages: [ChatMessage] = [
            .user(parts: [.toolResult(toolCallId: "search", result: search)]),
            .user(parts: [.toolResult(
                toolCallId: "cite",
                result: .annotateBatch(items: [annotation, .error(code: "fixture-refused", message: "Unavailable")])
            )]),
        ]
        XCTAssertEqual(DesktopChatEvidence.references(in: messages).map(\.documentId), [ref.documentId])
    }

    func testUpdatedAnnotationsReplaceMetadataWithoutDuplicatingOrResurrectingRemovedSources() {
        let first = AgentDocRef(documentId: "one", sourceType: "example", sourceId: "example:notes", title: "Earlier title")
        let updated = AgentDocRef(documentId: "one", sourceType: "example", sourceId: "example:notes", title: "Corrected title")
        let second = AgentDocRef(documentId: "two", sourceType: "example", sourceId: "example:notes", title: "Another note")
        let merged = DesktopChatEvidence.merging([first, second], [updated])
        XCTAssertEqual(merged.map(\.documentId), ["one", "two"])
        XCTAssertEqual(merged.first?.title, "Corrected title")
        XCTAssertEqual(DesktopChatEvidence.merging(merged, [first], removing: ["one"]).map(\.documentId), ["two"])
    }
}
