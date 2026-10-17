// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

final class AgentToolCardsTests: XCTestCase {
    /// The fixture the gateway generates from `AGENT_TOOL_CARDS`, from the
    /// copy that ships beside this test (the native dispatcher rsyncs `ios/`
    /// alone).
    private func fixture() throws -> [String: [String: Any]] {
        let file = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .appendingPathComponent("wire-fixtures")
            .appendingPathComponent("agent-tool-cards.json")
        let data = try XCTUnwrap(
            FileManager.default.contents(atPath: file.path),
            "missing \(file.path) — run `npm run wire-fixtures`"
        )
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: [String: Any]])
    }

    func testTableIsTheOneEveryClientFollows() throws {
        let expected = try fixture()
        XCTAssertEqual(Set(AgentToolCards.table.keys), Set(expected.keys))
        for (tool, entry) in expected {
            let card = try XCTUnwrap(AgentToolCards.table[tool], tool)
            XCTAssertEqual(card.presentation.rawValue, entry["presentation"] as? String, tool)
            XCTAssertEqual(card.label, entry["label"] as? String, tool)
            XCTAssertEqual(card.icon, entry["icon"] as? String, tool)
            XCTAssertEqual(card.scrollsContent, (entry["scrollsContent"] as? Bool) ?? false, tool)
            if let icon = card.icon {
                XCTAssertNotNil(AgentToolCards.symbols[icon], "no symbol for \(icon)")
            }
        }
    }

    func testDismissesExactlyTheEphemeralCards() throws {
        for (tool, entry) in try fixture() {
            let presentation = entry["presentation"] as? String
            XCTAssertEqual(
                agentEphemeralTools.contains(tool),
                presentation == "ephemeral" || presentation == "subagent",
                tool
            )
            XCTAssertEqual(AgentToolCards.silentTools.contains(tool), presentation == "silent", tool)
        }
    }

    func testWikiReadUsesTheWikiGlyph() {
        XCTAssertEqual(AgentToolCards.label(for: "knowledge_fetch"), "Read wiki page")
        XCTAssertEqual(AgentToolCards.symbol(for: "knowledge_fetch"), "book.pages")
    }

    func testDocumentAndPersonMemoryActionsStayDistinct() {
        for (document, person, verb) in [
            ("annotate_durable", "annotate_person", "Remember"),
            ("annotation_revise", "person_annotation_revise", "Update"),
            ("annotation_retract", "person_annotation_retract", "Forget"),
            ("annotation_supersede", "person_annotation_supersede", "Replace"),
        ] {
            let suffix = verb == "Remember" ? "" : " memory"
            XCTAssertEqual(AgentToolCards.label(for: document), "\(verb) document\(suffix)")
            XCTAssertEqual(AgentToolCards.label(for: person), "\(verb) person\(suffix)")
        }
    }

    func testRenamedDateToolsKeepTheirCard() {
        for (temporal, timeIndex, label) in [
            ("temporal_query", "time_index_query", "Check dates"),
            ("temporal_annotation_add", "time_index_add", "Add date note"),
            ("temporal_annotation_update", "time_index_update", "Update date note"),
            ("temporal_annotation_delete", "time_index_delete", "Remove date note"),
        ] {
            XCTAssertEqual(AgentToolCards.label(for: temporal), label)
            XCTAssertEqual(AgentToolCards.label(for: timeIndex), label)
            XCTAssertTrue(agentEphemeralTools.contains(timeIndex))
        }
    }

    func testUnknownToolKeepsItsNameAndAGenericGlyph() {
        XCTAssertEqual(AgentToolCards.label(for: "annotation_future_action"), "annotation_future_action")
        XCTAssertEqual(AgentToolCards.label(for: ""), "")
        XCTAssertEqual(AgentToolCards.symbol(for: "annotation_future_action"), "wrench.and.screwdriver")
    }

    func testAWikiReadIsTheFirstDocumentOfItsBatch() throws {
        let data = Data("""
        {"kind":"document.batch","items":[{"kind":"error","code":"not_found","message":"gone"},
        {"kind":"document","ref":{"documentId":"wiki-doc","sourceType":"brain-knowledge","sourceId":"brain-knowledge","title":"Pottery workshop"},
        "document":{"title":"Pottery workshop","content":"Opens at nine."}}]}
        """.utf8)
        let result = try JSONDecoder().decode(AgentToolResult.self, from: data)
        let read = try XCTUnwrap(agentDocumentRead(result))
        XCTAssertEqual(read.ref.title, "Pottery workshop")
        XCTAssertEqual(read.content, "Opens at nine.")
        XCTAssertNil(agentDocumentRead(nil))
    }
}
