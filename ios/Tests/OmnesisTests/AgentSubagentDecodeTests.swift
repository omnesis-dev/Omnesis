// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

/// JSON-decode round-trip regression net for `agent.subagent.event`.
///
/// The deep-research researcher cards are fed by a sub-agent's WRAPPED child
/// events: each `agent.subagent.event` envelope carries an inner `{type,payload}`
/// event the parent re-reduces. On the wire those child payloads are THIN — they
/// omit `sessionId`/`messageId` (the parent envelope already names the session).
/// A non-optional field on the child payload throws `keyNotFound`, which bubbles
/// up and discards the ENTIRE sub-agent event — so a researcher silently loses its
/// nested search results and documents.
///
/// Earlier sub-agent tests built `AgentEvent` values in-memory and never crossed
/// the JSON decoder, so this regression slipped through. These tests drive the
/// literal wire string through the SAME `JSONDecoder` the SSE loop uses, then
/// through the coordinator, closing that gap.
@available(iOS 17.0, *)
@MainActor
final class AgentSubagentDecodeTests: XCTestCase {
    private func decode(_ json: String) throws -> AgentEvent {
        try JSONDecoder().decode(AgentEvent.self, from: Data(json.utf8))
    }

    /// The exact shape that regressed: a wrapped `agent.tool.result` carrying a
    /// `search.results` payload with a doc, and NO `sessionId`/`messageId` on the
    /// child. It must decode — not drop to `.unknown` / nil on `keyNotFound`.
    private let wire = #"""
    {"type":"agent.subagent.event","payload":{
      "sessionId":"s","subagentId":"s.sub.bank","specialist":"history-sweep","event":{
        "type":"agent.tool.result","payload":{"toolCallId":"tc","durationMs":210,"result":{
          "kind":"search.results","query":"q","candidates":1,"results":[{
            "documentId":"d1","sourceType":"enable-banking-accounts",
            "sourceId":"enable-banking-accounts:self","documentType":"transaction",
            "title":"Tokyo Riverside Hotel","snippet":"...","ts":1775000000000
          }]}
        }
      }
    }}
    """#

    func testSubagentEventWithThinChildSearchResultDecodesNotDropped() throws {
        let event = try decode(wire)

        guard case .subagentEvent(_, let subId, let specialist, let child) = event else {
            return XCTFail("expected .subagentEvent, got \(event)")
        }
        XCTAssertEqual(subId, "s.sub.bank")
        XCTAssertEqual(specialist, "history-sweep")

        // The child decoded despite the missing sessionId/messageId — the whole
        // point of the regression. A `keyNotFound` here would have discarded the
        // entire sub-agent event upstream.
        guard case .toolResult(_, _, let toolCallId, let result, let durationMs) = child else {
            return XCTFail("expected wrapped .toolResult, got \(child)")
        }
        XCTAssertEqual(toolCallId, "tc")
        XCTAssertEqual(durationMs, 210)

        guard case .searchResults(_, _, let candidates, let results) = result else {
            return XCTFail("expected .searchResults, got \(result)")
        }
        XCTAssertEqual(candidates, 1)
        // The doc survived — NOT dropped to an empty set.
        XCTAssertEqual(results.map(\.documentId), ["d1"])
        XCTAssertEqual(results.first?.sourceId, "enable-banking-accounts:self")
        XCTAssertEqual(results.first?.title, "Tokyo Riverside Hotel")
    }

    /// Driving the decoded event through the coordinator yields a research panel
    /// whose `docs` carries the one search hit — the end-to-end proof that a
    /// faithfully-decoded sub-agent search result reaches the research surface.
    func testDecodedSubagentEventDrivesResearchPanelWithDocs() async throws {
        let coord = AgentCoordinator()
        coord.installPreviewState(
            sessionId: "s", model: "m", backend: "b", title: "t",
            turns: [], citations: [], conversations: []
        )
        // A parent assistant turn so the card has somewhere to attach, then the
        // spawn that opens the researcher card.
        await coord.applyEventForTesting(.messageStart(sessionId: "s", messageId: "msg-1"))
        await coord.applyEventForTesting(.subagentSpawned(
            sessionId: "s", subagentId: "s.sub.bank", specialist: "history-sweep",
            task: "Find the hotel charge", parentToolCallId: "tu_bank"
        ))

        // Feed the SAME wire event the decode test asserts on — decoded, then reduced.
        let event = try decode(wire)
        await coord.applyEventForTesting(event)

        let panel = coord.researchPanels.first
        XCTAssertEqual(panel?.subagentId, "s.sub.bank")
        XCTAssertEqual(panel?.docs.count, 1)
        XCTAssertEqual(panel?.docs.first?.documentId, "d1")
    }
}
