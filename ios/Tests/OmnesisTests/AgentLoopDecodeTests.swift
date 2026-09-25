// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

/// Decode contract for the steward read surface the chat agent renders
/// (experimental): the `loops.searched` / `loop.fetched` tool-result kinds and
/// the `openLoops` / `annotations` hints attached inline to a `DocRef`. Mirrors
/// the wire shapes locked in `@omnesis/core/agent-protocol.ts`. All fixtures are
/// invented (never sourced from the corpus).
@available(iOS 17.0, *)
final class AgentLoopDecodeTests: XCTestCase {
    private func decodeResult(_ json: String) throws -> AgentToolResult {
        try JSONDecoder().decode(AgentToolResult.self, from: Data(json.utf8))
    }

    // MARK: - loops.searched

    func test_loops_searched_decodes_every_field() throws {
        let json = """
        {
          "kind": "loops.searched",
          "query": "offsite follow-ups",
          "durationMs": 14,
          "loops": [
            {
              "loopId": "loop-venue-1",
              "title": "Reply to Maya Reeves about the Q3 offsite venue",
              "description": "Maya needs a venue decision before the deposit deadline.",
              "state": "open",
              "importance": 0.82,
              "confidence": 0.7,
              "deadline": "Jul 12"
            },
            {
              "loopId": "loop-catering-1",
              "title": "Confirm catering headcount",
              "state": "snoozed"
            }
          ]
        }
        """
        guard case .loopsSearched(let query, let durationMs, let loops) = try decodeResult(json) else {
            return XCTFail("not loops.searched")
        }
        XCTAssertEqual(query, "offsite follow-ups")
        XCTAssertEqual(durationMs, 14, accuracy: 0.001)
        XCTAssertEqual(loops.count, 2)
        XCTAssertEqual(loops[0].loopId, "loop-venue-1")
        XCTAssertEqual(loops[0].state, "open")
        XCTAssertEqual(loops[0].importance ?? 0, 0.82, accuracy: 0.001)
        XCTAssertEqual(loops[0].confidence ?? 0, 0.7, accuracy: 0.001)
        XCTAssertEqual(loops[0].deadline, "Jul 12")
        // Second loop: optional fields absent → nil, required fields present.
        XCTAssertEqual(loops[1].state, "snoozed")
        XCTAssertNil(loops[1].importance)
        XCTAssertNil(loops[1].deadline)
        XCTAssertNil(loops[1].description)
    }

    func test_loops_searched_empty_is_clean_no_match() throws {
        let json = #"{ "kind": "loops.searched", "query": "nothing", "durationMs": 3, "loops": [] }"#
        guard case .loopsSearched(_, _, let loops) = try decodeResult(json) else {
            return XCTFail("not loops.searched")
        }
        XCTAssertTrue(loops.isEmpty)
    }

    // MARK: - loop.fetched

    func test_loop_fetched_decodes_full_detail() throws {
        let json = """
        {
          "kind": "loop.fetched",
          "loop": {
            "loopId": "loop-venue-1",
            "title": "Reply to Maya Reeves about the Q3 offsite venue",
            "description": "Maya asked which venue to lock in.",
            "state": "open",
            "importance": 0.82,
            "confidence": 0.7,
            "deadline": "Jul 12",
            "actors": ["Maya Reeves"],
            "involved": ["Jamie Lopez", "David Lin"],
            "docIds": ["gmail-venue-1", "gmail-venue-2"],
            "ledger": [
              { "at": 1719500000000, "note": "Detected obligation from Maya's email" },
              { "at": 1719900000000, "note": "Reopened — deposit deadline approaching" }
            ]
          }
        }
        """
        guard case .loopFetched(let loop) = try decodeResult(json), let loop else {
            return XCTFail("not loop.fetched with a loop")
        }
        XCTAssertEqual(loop.loopId, "loop-venue-1")
        XCTAssertEqual(loop.state, "open")
        XCTAssertEqual(loop.importance ?? 0, 0.82, accuracy: 0.001)
        XCTAssertEqual(loop.deadline, "Jul 12")
        XCTAssertEqual(loop.actors, ["Maya Reeves"])
        XCTAssertEqual(loop.involved, ["Jamie Lopez", "David Lin"])
        XCTAssertEqual(loop.docIds, ["gmail-venue-1", "gmail-venue-2"])
        XCTAssertEqual(loop.ledger?.count, 2)
        XCTAssertEqual(loop.ledger?[0].at ?? 0, 1_719_500_000_000, accuracy: 1)
        XCTAssertEqual(loop.ledger?[1].note, "Reopened — deposit deadline approaching")
    }

    func test_loop_fetched_omitted_loop_is_no_match() throws {
        let json = #"{ "kind": "loop.fetched" }"#
        guard case .loopFetched(let loop) = try decodeResult(json) else {
            return XCTFail("not loop.fetched")
        }
        XCTAssertNil(loop, "omitted loop is a clean no-match, decoded as nil")
    }

    // MARK: - DocRef inline hints

    func test_docref_decodes_open_loops_and_annotations() throws {
        let json = """
        {
          "documentId": "gmail-venue-1",
          "sourceType": "gmail",
          "sourceId": "gmail:me",
          "title": "Re: Q3 offsite — venue options",
          "openLoops": [
            { "loopId": "loop-venue-1", "title": "Reply to Maya Reeves", "state": "open", "importance": 0.82 },
            { "loopId": "loop-catering-1", "title": "Confirm catering headcount", "state": "snoozed" }
          ],
          "annotations": [
            { "claimType": "commitment-status", "claim": "Awaiting the user's venue decision", "confidence": 0.6 }
          ]
        }
        """
        let ref = try JSONDecoder().decode(AgentDocRef.self, from: Data(json.utf8))
        XCTAssertEqual(ref.openLoops?.count, 2)
        XCTAssertEqual(ref.openLoops?[0].loopId, "loop-venue-1")
        XCTAssertEqual(ref.openLoops?[0].importance ?? 0, 0.82, accuracy: 0.001)
        XCTAssertNil(ref.openLoops?[1].importance)
        XCTAssertEqual(ref.annotations?.count, 1)
        XCTAssertEqual(ref.annotations?[0].claimType, "commitment-status")
        XCTAssertEqual(ref.annotations?[0].confidence ?? 0, 0.6, accuracy: 0.001)
    }

    func test_docref_without_hints_decodes_to_nil() throws {
        // Backward-compat: a ref from a non-experimental gateway carries
        // neither field; both must decode to nil rather than choke.
        let json = #"{ "documentId": "d1", "sourceType": "gmail", "sourceId": "gmail:me" }"#
        let ref = try JSONDecoder().decode(AgentDocRef.self, from: Data(json.utf8))
        XCTAssertNil(ref.openLoops)
        XCTAssertNil(ref.annotations)
    }

    // MARK: - Round-trip (encode → decode)

    func test_loop_kinds_round_trip_through_encode() throws {
        let searched: AgentToolResult = .loopsSearched(
            query: "q",
            durationMs: 5,
            loops: [AgentLoopSummary(loopId: "l1", title: "T", state: "open", importance: 0.5)]
        )
        let fetched: AgentToolResult = .loopFetched(
            loop: AgentLoopDetail(
                loopId: "l1",
                title: "T",
                state: "open",
                actors: ["Maya Reeves"],
                ledger: [AgentLoopLedgerEntry(at: 1_719_500_000_000, note: "n")]
            )
        )
        let noMatch: AgentToolResult = .loopFetched(loop: nil)

        for original in [searched, fetched, noMatch] {
            let data = try JSONEncoder().encode(original)
            let round = try JSONDecoder().decode(AgentToolResult.self, from: data)
            XCTAssertEqual(round, original, "encode → decode must be lossless")
            if case .unknown = round {
                XCTFail("round-trip fell to .unknown — a modelled kind was dropped")
            }
        }
    }
}
