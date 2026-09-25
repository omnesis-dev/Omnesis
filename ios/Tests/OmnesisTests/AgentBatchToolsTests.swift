// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

/// Covers the batch retrieval tools (`search_many` / `fetch_many` /
/// `annotate_many`) on the iOS surface:
///   • decode of the three batch `tool_result` kinds (`search.batch` /
///     `document.batch` / `annotate.batch`) and the two new streamed events
///     (`agent.tool.child.start` / `agent.tool.child.result`) into typed
///     values — never the graceful `.unknown` fallback;
///   • the reload rebuilders fanning a persisted `annotate.batch` out to one
///     citation / Timeline bucket per child with the SAME `<toolCallId>#<idx>`
///     ids the live `agent.citation` events use, so a reopened conversation is
///     identical to live.
///
/// Mirrors the portal-side coverage in
/// `packages/gateway/portal/js/views/agent-reducer-batch.test.ts`.
@available(iOS 17.0, *)
final class AgentBatchToolsTests: XCTestCase {
    private func ref(_ id: String) -> AgentDocRef {
        AgentDocRef(documentId: id, sourceType: "gmail", sourceId: "gmail:me", title: id)
    }

    private func decodeResult(_ json: String) throws -> AgentToolResult {
        try JSONDecoder().decode(AgentToolResult.self, from: Data(json.utf8))
    }

    private func decodeEvent(_ json: String) throws -> AgentEvent {
        try JSONDecoder().decode(AgentEvent.self, from: Data(json.utf8))
    }

    // MARK: - Decode: batch tool_result kinds

    func test_search_batch_decodes_children_and_error_slot() throws {
        let result = try decodeResult(#"""
        {
          "kind": "search.batch",
          "items": [
            {
              "kind": "search.results",
              "query": "quarterly budget",
              "durationMs": 5,
              "results": [
                { "documentId": "d1", "sourceType": "gmail", "sourceId": "gmail:me", "title": "T1" }
              ]
            },
            { "kind": "error", "code": "batch_child_failed", "message": "boom" }
          ]
        }
        """#)
        guard case .searchBatch(let items) = result else {
            return XCTFail("expected .searchBatch, got \(result)")
        }
        XCTAssertEqual(items.count, 2)
        guard case .searchResults(let query, _, _, let results) = items[0] else {
            return XCTFail("child 0 should reuse the singular search.results shape")
        }
        XCTAssertEqual(query, "quarterly budget")
        XCTAssertEqual(results.first?.documentId, "d1")
        // A failed child is a `.error` in its slot, never sinking the batch.
        guard case .error(let code, _) = items[1] else {
            return XCTFail("child 1 should be an error slot")
        }
        XCTAssertEqual(code, "batch_child_failed")
    }

    func test_document_batch_decodes_document_children() throws {
        let result = try decodeResult(#"""
        {
          "kind": "document.batch",
          "items": [
            {
              "kind": "document",
              "ref": { "documentId": "d1", "sourceType": "gmail", "sourceId": "gmail:me" },
              "document": { "id": "d1", "content": "hello" },
              "neighbors": []
            }
          ]
        }
        """#)
        guard case .documentBatch(let items) = result else {
            return XCTFail("expected .documentBatch, got \(result)")
        }
        XCTAssertEqual(items.count, 1)
        guard case .document(let docRef, let content, _) = items[0] else {
            return XCTFail("child should reuse the singular document shape")
        }
        XCTAssertEqual(docRef.documentId, "d1")
        XCTAssertEqual(content, "hello")
    }

    func test_annotate_batch_decodes_recorded_children() throws {
        let result = try decodeResult(#"""
        {
          "kind": "annotate.batch",
          "items": [
            {
              "kind": "annotate.recorded",
              "documentId": "d1",
              "ref": { "documentId": "d1", "sourceType": "gmail", "sourceId": "gmail:me" },
              "quote": "q1"
            },
            {
              "kind": "annotate.recorded",
              "documentId": "d2",
              "ref": { "documentId": "d2", "sourceType": "gmail", "sourceId": "gmail:me" },
              "note": "n2"
            }
          ]
        }
        """#)
        guard case .annotateBatch(let items) = result else {
            return XCTFail("expected .annotateBatch, got \(result)")
        }
        XCTAssertEqual(items.count, 2)
        for item in items {
            if case .annotateRecorded = item { continue }
            XCTFail("each child should reuse the singular annotate.recorded shape")
        }
    }

    /// A modelled batch kind must round-trip through encode → decode so a
    /// persisted transcript reloads losslessly (the encode path is what the
    /// resume rebuilders consume).
    func test_batch_result_round_trips_through_encode() throws {
        let original: AgentToolResult = .searchBatch(items: [
            .searchResults(query: "x", durationMs: 1, candidates: nil, results: [ref("d1")]),
            .error(code: "batch_child_failed", message: "boom"),
        ])
        let data = try JSONEncoder().encode(original)
        let decoded = try JSONDecoder().decode(AgentToolResult.self, from: data)
        XCTAssertEqual(decoded, original)
    }

    // MARK: - Decode: child-progress events

    func test_tool_child_start_decodes_with_singular_tool_name() throws {
        let event = try decodeEvent(#"""
        {
          "type": "agent.tool.child.start",
          "payload": {
            "sessionId": "s1",
            "messageId": "m1",
            "toolCallId": "tc-parent",
            "childIndex": 2,
            "tool": "search_documents",
            "argsSummary": "quarterly budget"
          }
        }
        """#)
        guard case .toolChildStart(let sessionId, _, let toolCallId, let childIndex, let tool, let argsSummary) = event else {
            return XCTFail("expected .toolChildStart, got \(event)")
        }
        XCTAssertEqual(sessionId, "s1")
        XCTAssertEqual(toolCallId, "tc-parent")
        XCTAssertEqual(childIndex, 2)
        // The singular tool name so the client reuses the existing per-tool card.
        XCTAssertEqual(tool, "search_documents")
        XCTAssertEqual(argsSummary, "quarterly budget")
    }

    func test_tool_child_result_decodes_typed_result() throws {
        let event = try decodeEvent(#"""
        {
          "type": "agent.tool.child.result",
          "payload": {
            "sessionId": "s1",
            "messageId": "m1",
            "toolCallId": "tc-parent",
            "childIndex": 1,
            "result": {
              "kind": "document",
              "ref": { "documentId": "d9", "sourceType": "gmail", "sourceId": "gmail:me" },
              "document": { "id": "d9", "content": "body" },
              "neighbors": []
            }
          }
        }
        """#)
        guard case .toolChildResult(_, _, let toolCallId, let childIndex, let result) = event else {
            return XCTFail("expected .toolChildResult, got \(event)")
        }
        XCTAssertEqual(toolCallId, "tc-parent")
        XCTAssertEqual(childIndex, 1)
        guard case .document(let docRef, _, _) = result else {
            return XCTFail("child result should decode into the singular document shape")
        }
        XCTAssertEqual(docRef.documentId, "d9")
    }

    // MARK: - Child-card derivation (renders on every backend)

    private func searchManyCall(
        children: [AgentToolChild] = [],
        result: AgentToolResult? = nil,
        queries: [String] = []
    )
        -> AgentToolCall {
        AgentToolCall(
            toolCallId: "tc",
            tool: "search_many",
            args: JSONAny(value: [
                "queries": queries.map { ["query": $0] } as [Any],
            ] as [String: Any]),
            argsSummary: "\(queries.count) searches",
            argsKnown: true,
            result: result,
            durationMs: nil,
            children: children
        )
    }

    private func searchResults(_ query: String, _ docId: String) -> AgentToolResult {
        .searchResults(query: query, durationMs: 1, candidates: nil, results: [ref(docId)])
    }

    /// When the backend streamed `agent.tool.child.*` progress (codex), the
    /// cards come straight off `children`.
    func test_child_cards_use_streamed_children_when_present() {
        let call = searchManyCall(
            children: [
                AgentToolChild(index: 0, tool: "search_documents", argsSummary: "a", result: nil),
                AgentToolChild(index: 1, tool: "search_documents", argsSummary: "b", result: searchResults("b", "d1")),
            ],
            queries: ["ignored"]
        )
        let cards = agentBatchChildCalls(for: call)
        XCTAssertEqual(cards.map(\.toolCallId), ["tc#0", "tc#1"])
        XCTAssertEqual(cards.map(\.tool), ["search_documents", "search_documents"])
        XCTAssertEqual(cards[0].argsSummary, "a")
        XCTAssertNil(cards[0].result)
        XCTAssertNotNil(cards[1].result)
    }

    /// The non-codex case AFTER completion: no `children`, but a settled
    /// `.searchBatch` result. One card per item — the whole point of the fix,
    /// since these backends emit no child events at all.
    func test_child_cards_derive_from_settled_search_batch_when_no_children() {
        let call = searchManyCall(
            result: .searchBatch(items: [
                searchResults("q0", "d0"),
                searchResults("q1", "d1"),
                .error(code: "batch_child_failed", message: "boom"),
            ]),
            queries: ["q0", "q1", "q2"]
        )
        let cards = agentBatchChildCalls(for: call)
        XCTAssertEqual(cards.map(\.toolCallId), ["tc#0", "tc#1", "tc#2"])
        // Every card carries its settled result — even the failed slot — so the
        // singular card renders (a settled card, no spinner).
        XCTAssertTrue(cards.allSatisfy { $0.result != nil })
        // Query pulled from args so the search card header is populated.
        XCTAssertEqual(cards.map(\.argsSummary), ["q0", "q1", "q2"])
    }

    /// The non-codex case WHILE running: no `children`, no result, just `args`.
    /// One pending card per query so the turn looks alive during the tool call.
    func test_child_cards_are_pending_when_no_children_and_no_result() {
        let cards = agentBatchChildCalls(for: searchManyCall(queries: ["alpha", "beta", "gamma"]))
        XCTAssertEqual(cards.map(\.argsSummary), ["alpha", "beta", "gamma"])
        // No result → each singular card shows its live spinner.
        XCTAssertTrue(cards.allSatisfy { $0.result == nil && $0.tool == "search_documents" })
    }

    /// A batch call with no children, no result, and no `args` yet (only
    /// `tool.input_start` has fired) yields no cards — the turn-level working
    /// dots cover that beat instead.
    func test_child_cards_empty_when_args_absent() {
        let call = AgentToolCall(
            toolCallId: "tc", tool: "search_many",
            args: JSONAny(value: NSNull()), argsSummary: "", argsKnown: false,
            result: nil, durationMs: nil
        )
        XCTAssertTrue(agentBatchChildCalls(for: call).isEmpty)
    }

    private func fetchManyCall(result: AgentToolResult?) -> AgentToolCall {
        AgentToolCall(
            toolCallId: "tc",
            tool: "fetch_many",
            args: JSONAny(value: [
                "documents": [["documentId": "d0"], ["documentId": "d1"]] as [Any],
            ] as [String: Any]),
            argsSummary: "2 documents",
            argsKnown: true,
            result: result,
            durationMs: nil
        )
    }

    /// `fetch_many` settled cards are `fetch_document`, preferring the opened
    /// document's title and falling back to the requested id for a failed slot.
    func test_fetch_many_settled_cards_prefer_document_title() {
        let call = fetchManyCall(result: .documentBatch(items: [
            .document(
                ref: AgentDocRef(documentId: "d0", sourceType: "gmail", sourceId: "gmail:me", title: "Opened Doc"),
                content: "body", neighbors: []
            ),
            .error(code: "batch_child_failed", message: "boom"),
        ]))
        let cards = agentBatchChildCalls(for: call)
        XCTAssertEqual(cards.map(\.tool), ["fetch_document", "fetch_document"])
        XCTAssertEqual(cards[0].argsSummary, "Opened Doc") // title from result
        XCTAssertEqual(cards[1].argsSummary, "d1") // id fallback for the error slot
    }

    /// `fetch_many` pending cards are `fetch_document`, summarised by the
    /// requested documentId.
    func test_fetch_many_pending_cards_use_document_ids() {
        let cards = agentBatchChildCalls(for: fetchManyCall(result: nil))
        XCTAssertEqual(cards.map(\.argsSummary), ["d0", "d1"])
        XCTAssertTrue(cards.allSatisfy { $0.result == nil && $0.tool == "fetch_document" })
    }

    // MARK: - Reload fan-out: annotate.batch → citations + Timeline

    /// The canonical persisted transcript a resumed conversation replays: an
    /// `annotate_many` tool_use paired with its `annotate.batch` tool_result.
    private var annotateBatchMessages: [ChatMessage] {
        [
            .user(parts: [.text("where did I live?")]),
            .assistant(parts: [
                .toolUse(
                    toolCallId: "tc",
                    tool: "annotate_many",
                    args: JSONAny(value: [
                        "annotations": [
                            ["documentId": "d1", "quote": "q1"],
                            ["documentId": "d2", "note": "n2"],
                        ] as [Any],
                    ] as [String: Any])
                ),
            ]),
            .user(parts: [
                .toolResult(
                    toolCallId: "tc",
                    result: .annotateBatch(items: [
                        .annotateRecorded(
                            documentId: "d1", ref: ref("d1"),
                            quote: "q1", note: nil, quoteAuthor: nil, quoteIsSelf: false
                        ),
                        .annotateRecorded(
                            documentId: "d2", ref: ref("d2"),
                            quote: nil, note: "n2", quoteAuthor: nil, quoteIsSelf: false
                        ),
                    ])
                ),
            ]),
            .assistant(parts: [.text("here.")]),
        ]
    }

    func test_citations_fans_annotate_batch_into_one_per_child() {
        let cits = AgentTurnBuilder.citations(from: annotateBatchMessages)
        XCTAssertEqual(cits.map(\.documentId).sorted(), ["d1", "d2"])

        let d1 = cits.first { $0.documentId == "d1" }
        XCTAssertEqual(d1?.entries.first?.quote, "q1")
        // Per-child stable id — matches the live `agent.citation` events so
        // live and reloaded citations are identical.
        XCTAssertEqual(d1?.entries.first?.toolCallId, "tc#0")

        // Note-only child routes to a doc-level note, not a quote entry.
        let d2 = cits.first { $0.documentId == "d2" }
        XCTAssertEqual(d2?.docNote, "n2")
        XCTAssertTrue(d2?.entries.isEmpty ?? false)
    }

    func test_trail_annotations_buckets_each_batch_child_by_document() {
        let ann = AgentTurnBuilder.trailAnnotations(from: annotateBatchMessages)
        XCTAssertEqual(Set(ann.byDoc.keys), ["d1", "d2"])
        XCTAssertEqual(ann.byDoc["d1"]?.quotes.first?.quote, "q1")
        XCTAssertEqual(ann.byDoc["d2"]?.note, "n2")
    }

    /// A single citation id (no `#idx` suffix) when the batch has exactly one
    /// child — matching the live path, which only stamps per-child ids for a
    /// multi-child batch.
    func test_citations_single_child_batch_uses_bare_tool_call_id() {
        let messages: [ChatMessage] = [
            .assistant(parts: [
                .toolUse(toolCallId: "solo", tool: "annotate_many", args: JSONAny(value: [:] as [String: Any])),
            ]),
            .user(parts: [
                .toolResult(toolCallId: "solo", result: .annotateBatch(items: [
                    .annotateRecorded(
                        documentId: "d1", ref: ref("d1"),
                        quote: "only", note: nil, quoteAuthor: nil, quoteIsSelf: false
                    ),
                ])),
            ]),
        ]
        let cits = AgentTurnBuilder.citations(from: messages)
        XCTAssertEqual(cits.count, 1)
        XCTAssertEqual(cits[0].entries.first?.toolCallId, "solo")
    }

    // MARK: - Reload: citation-chip count

    func test_turns_counts_annotate_many_children_toward_citation_chip() {
        let turns = AgentTurnBuilder.turns(from: annotateBatchMessages)
        let assistants = turns.compactMap { turn -> AgentAssistantTurn? in
            if case .assistant(let a) = turn { return a }
            return nil
        }
        XCTAssertEqual(assistants.count, 1)
        // One chip increment per annotation in the batch (two here).
        XCTAssertEqual(assistants.first?.citationCount, 2)
    }

    // MARK: - Live coordinator: annotate.batch populates the Timeline

    @MainActor
    private func liveCoordinator() -> AgentCoordinator {
        let coord = AgentCoordinator()
        coord.installPreviewState(
            sessionId: "sess-1", model: "m", backend: "b", title: "t",
            turns: [], citations: [], conversations: []
        )
        return coord
    }

    /// The exact gap that let the live-Timeline bug ship: an `annotate.batch`
    /// tool result arriving on a LIVE turn must fan out into `trailAnnotations`
    /// — the unified Timeline's data source (`hasTimelineContent ==
    /// !byDoc.isEmpty`) — just like the reload rebuild does, so a live turn's
    /// Timeline is identical to the reloaded one. Drives the real reducer via
    /// `applyEventForTesting` (the same seam the sub-agent reducer tests use).
    @MainActor
    func test_live_annotate_batch_populates_timeline() async {
        let coord = liveCoordinator()
        await coord.applyEventForTesting(.messageStart(sessionId: "sess-1", messageId: "msg-1"))
        await coord.applyEventForTesting(.toolResult(
            sessionId: "sess-1", messageId: "msg-1", toolCallId: "tc",
            result: .annotateBatch(items: [
                .annotateRecorded(
                    documentId: "d1", ref: ref("d1"),
                    quote: "q1", note: nil, quoteAuthor: nil, quoteIsSelf: false
                ),
                .annotateRecorded(
                    documentId: "d2", ref: ref("d2"),
                    quote: nil, note: "n2", quoteAuthor: nil, quoteIsSelf: false
                ),
            ]),
            durationMs: 5
        ))
        // Both documents land in the Timeline LIVE — not only after reload.
        XCTAssertEqual(Set(coord.trailAnnotations.byDoc.keys), ["d1", "d2"])
        XCTAssertFalse(coord.trailAnnotations.byDoc.isEmpty, "hasTimelineContent must be true live")
        // Same per-doc routing as the singular path: quote → entry, note → caption.
        XCTAssertEqual(coord.trailAnnotations.byDoc["d1"]?.quotes.first?.quote, "q1")
        XCTAssertEqual(coord.trailAnnotations.byDoc["d2"]?.note, "n2")
    }

    /// A live batch whose children are all failed `.error` slots records
    /// nothing — the Timeline stays empty rather than bucketing a non-doc.
    @MainActor
    func test_live_annotate_batch_all_errors_records_nothing() async {
        let coord = liveCoordinator()
        await coord.applyEventForTesting(.messageStart(sessionId: "sess-1", messageId: "msg-1"))
        await coord.applyEventForTesting(.toolResult(
            sessionId: "sess-1", messageId: "msg-1", toolCallId: "tc",
            result: .annotateBatch(items: [
                .error(code: "batch_child_failed", message: "boom"),
            ]),
            durationMs: 5
        ))
        XCTAssertTrue(coord.trailAnnotations.byDoc.isEmpty)
    }
}
