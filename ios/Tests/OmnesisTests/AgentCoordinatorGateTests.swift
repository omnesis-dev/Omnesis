// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

/// Exercises the ephemeral-tool causality gate in `AgentCoordinator`.
/// Mirrors `agent reducer — ephemeral causality gate` on the portal
/// side; the two surfaces share the same semantics so the test names
/// and shapes track each other closely.
///
/// The gate parks any SSE event that would extend the current
/// assistant turn while the latest ephemeral tool card is mid-
/// dismiss-lifecycle, and replays the queue once the card emits a
/// `flushEphemeralTail` callback. These tests drive the coordinator
/// directly through `applyEventForTesting`, bypassing the live SSE
/// stream so the gate semantics can be observed in isolation.
@available(iOS 17.0, *)
@MainActor
final class AgentCoordinatorGateTests: XCTestCase {
    func testSqlLifecycleKeyDistinguishesArgumentsResultAndExpedite() {
        let initial = AgentEphemeralSqlLifecycleKey(
            argsKnown: false, hasResult: false, expedited: false
        )
        let argumentsReady = AgentEphemeralSqlLifecycleKey(
            argsKnown: true, hasResult: false, expedited: false
        )
        let resultReady = AgentEphemeralSqlLifecycleKey(
            argsKnown: true, hasResult: true, expedited: false
        )
        let expedited = AgentEphemeralSqlLifecycleKey(
            argsKnown: true, hasResult: true, expedited: true
        )

        XCTAssertNotEqual(initial, argumentsReady)
        XCTAssertNotEqual(argumentsReady, resultReady)
        XCTAssertNotEqual(resultReady, expedited)
        XCTAssertNotEqual(
            initial,
            AgentEphemeralSqlLifecycleKey(argsKnown: false, hasResult: true, expedited: false),
            "a result that arrives before arguments must also start the lifecycle"
        )
    }

    private func makeCoordinator() -> AgentCoordinator {
        let coord = AgentCoordinator()
        coord.installPreviewState(
            sessionId: "sess-1",
            model: "m",
            backend: "b",
            title: "test",
            turns: [],
            citations: [],
            conversations: []
        )
        return coord
    }

    private func docRef(_ id: String) -> AgentDocRef {
        AgentDocRef(documentId: id, sourceType: "gmail", sourceId: "gmail:x")
    }

    private func searchResult(_ docs: [AgentDocRef]) -> AgentToolResult {
        .searchResults(query: "x", durationMs: 1, candidates: docs.count, results: docs)
    }

    private func documentResult(_ id: String) -> AgentToolResult {
        .document(ref: docRef(id), content: "body", neighbors: [])
    }

    /// Seed the coordinator with an assistant turn that already has a
    /// completed ephemeral search call. `tc-1` is the active gate.
    private func setupActiveGate(_ coord: AgentCoordinator) async {
        await coord.applyEventForTesting(.messageStart(sessionId: "sess-1", messageId: "msg-1"))
        await coord.applyEventForTesting(.toolInputStart(
            sessionId: "sess-1", messageId: "msg-1", toolCallId: "tc-1", tool: "search_documents"
        ))
        await coord.applyEventForTesting(.toolStart(
            sessionId: "sess-1", messageId: "msg-1", toolCallId: "tc-1",
            tool: "search_documents",
            args: JSONAny(value: ["query": "x"] as [String: Any]),
            argsSummary: "x"
        ))
        await coord.applyEventForTesting(.toolResult(
            sessionId: "sess-1", messageId: "msg-1", toolCallId: "tc-1",
            result: searchResult([docRef("d1")]),
            durationMs: 1
        ))
    }

    /// Extract the AgentToolCall by id from the latest assistant turn.
    private func toolCall(_ coord: AgentCoordinator, toolCallId: String) -> AgentToolCall? {
        guard let last = coord.turns.last, case .assistant(let a) = last else { return nil }
        for p in a.parts {
            if case .tool(let c) = p, c.toolCallId == toolCallId { return c }
        }
        return nil
    }

    /// Quick visual: parts in the latest assistant turn as a list of
    /// short tags so order assertions stay readable.
    private func partTags(_ coord: AgentCoordinator) -> [String] {
        guard let last = coord.turns.last, case .assistant(let a) = last else { return [] }
        return a.parts.map { p in
            switch p {
            case .text(let s): "text:\(s)"
            case .thinking(let s): "think:\(s)"
            case .tool(let c): "tool:\(c.toolCallId)"
            case .subagent(let c): "subagent:\(c.subagentId)"
            case .unknown(_, let kind): "unknown:\(kind)"
            }
        }
    }

    func testTextDeltasAfterEphemeralResultAreBufferedNotAppended() async throws {
        let coord = makeCoordinator()
        await setupActiveGate(coord)
        await coord.applyEventForTesting(.textDelta(sessionId: "sess-1", messageId: "msg-1", delta: "Found one. "))
        await coord.applyEventForTesting(.textDelta(sessionId: "sess-1", messageId: "msg-1", delta: "Opening it."))
        let call = try XCTUnwrap(toolCall(coord, toolCallId: "tc-1"))
        XCTAssertEqual(call.pendingTail.count, 2, "both deltas should be queued")
        XCTAssertFalse(call.tailDismissed)
        // No new text part has been appended to the turn.
        XCTAssertEqual(partTags(coord), ["tool:tc-1"])
    }

    func testFlushEphemeralTailDrainsQueueInOrder() async throws {
        let coord = makeCoordinator()
        await setupActiveGate(coord)
        await coord.applyEventForTesting(.textDelta(sessionId: "sess-1", messageId: "msg-1", delta: "Hello "))
        await coord.applyEventForTesting(.textDelta(sessionId: "sess-1", messageId: "msg-1", delta: "world."))
        await coord.flushEphemeralTail(toolCallId: "tc-1")
        let call = try XCTUnwrap(toolCall(coord, toolCallId: "tc-1"))
        XCTAssertTrue(call.tailDismissed)
        XCTAssertEqual(call.pendingTail, [])
        // The two deltas have been consolidated into one trailing text part.
        XCTAssertEqual(partTags(coord), ["tool:tc-1", "text:Hello world."])
    }

    func testEphemeralErrorResultArmsGateAndFlushesTailInOrder() async throws {
        let coord = makeCoordinator()
        await coord.applyEventForTesting(.messageStart(sessionId: "sess-1", messageId: "msg-1"))
        await coord.applyEventForTesting(.toolInputStart(
            sessionId: "sess-1",
            messageId: "msg-1",
            toolCallId: "tc-error",
            tool: "search_documents"
        ))
        await coord.applyEventForTesting(.toolStart(
            sessionId: "sess-1",
            messageId: "msg-1",
            toolCallId: "tc-error",
            tool: "search_documents",
            args: JSONAny(value: ["query": "x"] as [String: Any]),
            argsSummary: "x"
        ))
        await coord.applyEventForTesting(.toolResult(
            sessionId: "sess-1", messageId: "msg-1", toolCallId: "tc-error",
            result: .error(code: "search_failed", message: "Search failed."),
            durationMs: 1
        ))

        await coord.applyEventForTesting(.textDelta(sessionId: "sess-1", messageId: "msg-1", delta: "I hit an error. "))
        await coord.applyEventForTesting(.textDelta(sessionId: "sess-1", messageId: "msg-1", delta: "Trying the next step."))

        var call = try XCTUnwrap(toolCall(coord, toolCallId: "tc-error"))
        XCTAssertEqual(call.pendingTail.count, 2, "error results on ephemeral tools should still arm the gate")
        if call.pendingTail.count == 2,
           case .textDelta(_, _, let firstDelta) = call.pendingTail[0],
           case .textDelta(_, _, let secondDelta) = call.pendingTail[1] {
            XCTAssertEqual(firstDelta, "I hit an error. ")
            XCTAssertEqual(secondDelta, "Trying the next step.")
        } else {
            XCTFail("expected text deltas to be buffered in arrival order")
        }
        XCTAssertFalse(call.tailDismissed)
        XCTAssertEqual(partTags(coord), ["tool:tc-error"])

        await coord.flushEphemeralTail(toolCallId: "tc-error")

        call = try XCTUnwrap(toolCall(coord, toolCallId: "tc-error"))
        XCTAssertTrue(call.tailDismissed)
        XCTAssertEqual(call.pendingTail, [])
        XCTAssertEqual(partTags(coord), ["tool:tc-error", "text:I hit an error. Trying the next step."])
    }

    func testSecondEphemeralToolWhileGateActiveIsAlsoBuffered() async throws {
        let coord = makeCoordinator()
        await setupActiveGate(coord)
        // Mid-rotation: text starts arriving, then a second tool kicks off.
        await coord.applyEventForTesting(.textDelta(sessionId: "sess-1", messageId: "msg-1", delta: "Found it. "))
        await coord.applyEventForTesting(.toolInputStart(
            sessionId: "sess-1", messageId: "msg-1", toolCallId: "tc-2", tool: "fetch_document"
        ))
        await coord.applyEventForTesting(.toolStart(
            sessionId: "sess-1", messageId: "msg-1", toolCallId: "tc-2",
            tool: "fetch_document",
            args: JSONAny(value: ["documentId": "doc-1"] as [String: Any]),
            argsSummary: "doc-1"
        ))
        await coord.applyEventForTesting(.toolResult(
            sessionId: "sess-1", messageId: "msg-1", toolCallId: "tc-2",
            result: documentResult("doc-1"),
            durationMs: 1
        ))
        // tc-2 must NOT yet appear in the turn — it lives on tc-1's queue.
        XCTAssertEqual(partTags(coord), ["tool:tc-1"])
        let call = try XCTUnwrap(toolCall(coord, toolCallId: "tc-1"))
        XCTAssertEqual(call.pendingTail.count, 4, "text + tc-2 input_start + start + result")
    }

    func testFlushingFirstGatePromotesSecondToolAndMakesItTheNewGate() async throws {
        let coord = makeCoordinator()
        await setupActiveGate(coord)
        await coord.applyEventForTesting(.textDelta(sessionId: "sess-1", messageId: "msg-1", delta: "Found it. "))
        await coord.applyEventForTesting(.toolInputStart(
            sessionId: "sess-1", messageId: "msg-1", toolCallId: "tc-2", tool: "fetch_document"
        ))
        await coord.applyEventForTesting(.toolStart(
            sessionId: "sess-1", messageId: "msg-1", toolCallId: "tc-2",
            tool: "fetch_document",
            args: JSONAny(value: ["documentId": "doc-1"] as [String: Any]),
            argsSummary: "doc-1"
        ))
        await coord.applyEventForTesting(.toolResult(
            sessionId: "sess-1", messageId: "msg-1", toolCallId: "tc-2",
            result: documentResult("doc-1"),
            durationMs: 1
        ))
        await coord.flushEphemeralTail(toolCallId: "tc-1")
        let tc1 = try XCTUnwrap(toolCall(coord, toolCallId: "tc-1"))
        let tc2 = try XCTUnwrap(toolCall(coord, toolCallId: "tc-2"))
        XCTAssertTrue(tc1.tailDismissed)
        XCTAssertEqual(tc2.tool, "fetch_document")
        XCTAssertNotNil(tc2.result)
        // tc-2's queue is initialised but empty (it's an ephemeral tool,
        // nothing has landed on its tail yet); it's the new gate.
        XCTAssertEqual(tc2.pendingTail, [])
        XCTAssertFalse(tc2.tailDismissed)
        XCTAssertEqual(partTags(coord), ["tool:tc-1", "text:Found it. ", "tool:tc-2"])
    }

    func testTextAfterSecondResultLandsOnSecondGatePostFlush() async throws {
        // The full causality chain. Card 1 → text → card 2 → more text,
        // all arriving before card 1 finishes. After card 1 flushes,
        // card 2 must absorb the trailing text as its OWN gate.
        let coord = makeCoordinator()
        await setupActiveGate(coord)
        await coord.applyEventForTesting(.textDelta(sessionId: "sess-1", messageId: "msg-1", delta: "a"))
        await coord.applyEventForTesting(.toolInputStart(
            sessionId: "sess-1", messageId: "msg-1", toolCallId: "tc-2", tool: "fetch_document"
        ))
        await coord.applyEventForTesting(.toolStart(
            sessionId: "sess-1", messageId: "msg-1", toolCallId: "tc-2",
            tool: "fetch_document",
            args: JSONAny(value: ["documentId": "doc-1"] as [String: Any]),
            argsSummary: "doc-1"
        ))
        await coord.applyEventForTesting(.toolResult(
            sessionId: "sess-1", messageId: "msg-1", toolCallId: "tc-2",
            result: documentResult("doc-1"),
            durationMs: 1
        ))
        // "b" arrives AFTER tc-2's result, still inside tc-1's window.
        await coord.applyEventForTesting(.textDelta(sessionId: "sess-1", messageId: "msg-1", delta: "b"))
        await coord.flushEphemeralTail(toolCallId: "tc-1")
        // tc-2 is the new gate; "b" is on its tail.
        let tc2 = try XCTUnwrap(toolCall(coord, toolCallId: "tc-2"))
        XCTAssertFalse(tc2.tailDismissed)
        XCTAssertEqual(tc2.pendingTail.count, 1)
        if case .textDelta(_, _, let delta) = tc2.pendingTail.first {
            XCTAssertEqual(delta, "b")
        } else {
            XCTFail("expected textDelta on tc-2's tail")
        }
        // First text ("a") landed before tc-2 in the turn.
        XCTAssertEqual(partTags(coord), ["tool:tc-1", "text:a", "tool:tc-2"])
    }

    func testFlushingSecondGateCompletesTheChain() async {
        let coord = makeCoordinator()
        await setupActiveGate(coord)
        await coord.applyEventForTesting(.textDelta(sessionId: "sess-1", messageId: "msg-1", delta: "a"))
        await coord.applyEventForTesting(.toolInputStart(
            sessionId: "sess-1", messageId: "msg-1", toolCallId: "tc-2", tool: "fetch_document"
        ))
        await coord.applyEventForTesting(.toolStart(
            sessionId: "sess-1", messageId: "msg-1", toolCallId: "tc-2",
            tool: "fetch_document",
            args: JSONAny(value: ["documentId": "doc-1"] as [String: Any]),
            argsSummary: "doc-1"
        ))
        await coord.applyEventForTesting(.toolResult(
            sessionId: "sess-1", messageId: "msg-1", toolCallId: "tc-2",
            result: documentResult("doc-1"),
            durationMs: 1
        ))
        await coord.applyEventForTesting(.textDelta(sessionId: "sess-1", messageId: "msg-1", delta: "b"))
        await coord.flushEphemeralTail(toolCallId: "tc-1")
        await coord.flushEphemeralTail(toolCallId: "tc-2")
        XCTAssertEqual(partTags(coord), ["tool:tc-1", "text:a", "tool:tc-2", "text:b"])
    }

    func testNonEphemeralToolNeverActsAsGate() async throws {
        let coord = makeCoordinator()
        await coord.applyEventForTesting(.messageStart(sessionId: "sess-1", messageId: "msg-1"))
        await coord.applyEventForTesting(.toolInputStart(
            sessionId: "sess-1", messageId: "msg-1", toolCallId: "tc-w", tool: "watches_list"
        ))
        await coord.applyEventForTesting(.toolStart(
            sessionId: "sess-1", messageId: "msg-1", toolCallId: "tc-w",
            tool: "watches_list",
            args: JSONAny(value: ["enabledOnly": true] as [String: Any]),
            argsSummary: "enabled only"
        ))
        await coord.applyEventForTesting(.toolResult(
            sessionId: "sess-1", messageId: "msg-1", toolCallId: "tc-w",
            result: .error(code: "ok", message: ""),
            durationMs: 1
        ))
        // Text after a non-ephemeral tool result lands directly.
        await coord.applyEventForTesting(.textDelta(sessionId: "sess-1", messageId: "msg-1", delta: "answer"))
        XCTAssertEqual(partTags(coord), ["tool:tc-w", "text:answer"])
        let call = try XCTUnwrap(toolCall(coord, toolCallId: "tc-w"))
        XCTAssertEqual(call.pendingTail, [], "non-ephemeral tools have an empty tail forever")
    }

    func testTextBeforeResultLandsNormally() async {
        // No gate yet — the spinner-phase card has no result, so text
        // appended at this point lands directly. (Pre-result text is
        // unusual but should not be buffered.)
        let coord = makeCoordinator()
        await coord.applyEventForTesting(.messageStart(sessionId: "sess-1", messageId: "msg-1"))
        await coord.applyEventForTesting(.toolInputStart(
            sessionId: "sess-1", messageId: "msg-1", toolCallId: "tc-1", tool: "search_documents"
        ))
        await coord.applyEventForTesting(.toolStart(
            sessionId: "sess-1", messageId: "msg-1", toolCallId: "tc-1",
            tool: "search_documents",
            args: JSONAny(value: ["query": "x"] as [String: Any]),
            argsSummary: "x"
        ))
        await coord.applyEventForTesting(.textDelta(sessionId: "sess-1", messageId: "msg-1", delta: "waiting…"))
        XCTAssertEqual(partTags(coord), ["tool:tc-1", "text:waiting…"])
    }

    func testStaleFlushIsSafeNoOp() async {
        let coord = makeCoordinator()
        await setupActiveGate(coord)
        await coord.applyEventForTesting(.textDelta(sessionId: "sess-1", messageId: "msg-1", delta: "buffered"))
        await coord.flushEphemeralTail(toolCallId: "tc-1")
        let after = partTags(coord)
        // Second flush for the same id is a no-op.
        await coord.flushEphemeralTail(toolCallId: "tc-1")
        XCTAssertEqual(partTags(coord), after)
        // Flush for an unknown id is a no-op.
        await coord.flushEphemeralTail(toolCallId: "tc-nonexistent")
        XCTAssertEqual(partTags(coord), after)
    }

    // MARK: - Long-turn max-hold backstop

    /// A person result — what `lookup_people` (ephemeral, NON-batch) returns.
    /// An empty result set still lands a non-nil result, which is all the gate
    /// needs to arm.
    private func personResult() -> AgentToolResult {
        .personResults(query: "x", durationMs: 1, results: [])
    }

    /// A batch result — what `search_many` returns (`search.batch`).
    private func searchBatchResult() -> AgentToolResult {
        .searchBatch(items: [searchResult([docRef("d1")])])
    }

    /// Drive one `search_many` beat (input_start → start → result) on `msg-1`.
    private func driveSearchMany(_ coord: AgentCoordinator, toolCallId: String) async {
        await coord.applyEventForTesting(.toolInputStart(
            sessionId: "sess-1", messageId: "msg-1", toolCallId: toolCallId, tool: "search_many"
        ))
        await coord.applyEventForTesting(.toolStart(
            sessionId: "sess-1",
            messageId: "msg-1",
            toolCallId: toolCallId,
            tool: "search_many",
            args: JSONAny(value: ["queries": ["a", "b"]] as [String: Any]),
            argsSummary: "a, b"
        ))
        await coord.applyEventForTesting(.toolResult(
            sessionId: "sess-1",
            messageId: "msg-1",
            toolCallId: toolCallId,
            result: searchBatchResult(),
            durationMs: 1
        ))
    }

    /// The exact live-Anthropic shape from the field report: an early ephemeral
    /// `lookup_people` (which GATES) followed by interleaved thinking, two
    /// `search_many` batches (which do NOT gate on their own), more thinking,
    /// the answer text and `annotate_many` — with NO child events. Everything
    /// after `lookup_people`'s result parks on its tail; the whole turn must not
    /// stay stranded there. When the gate is released (the card's dismiss task,
    /// or the coordinator's max-hold backstop), the parked beats drain into the
    /// transcript in order — search cards + thinking + text become visible,
    /// rather than every part painting at once at `message.end`.
    func testLongInterleavedTurnDrainsIncrementallyOnGateFlush() async throws {
        let coord = makeCoordinator()
        // Freeze the backstop so this test observes the drain deterministically
        // via an explicit flush (the timing of the auto-fire is covered below).
        coord.gateMaxHoldSecondsForTesting = 3600
        await coord.applyEventForTesting(.messageStart(sessionId: "sess-1", messageId: "msg-1"))
        await coord.applyEventForTesting(.thinkingDelta(sessionId: "sess-1", messageId: "msg-1", delta: "Let me look… "))
        await coord.applyEventForTesting(.toolInputStart(
            sessionId: "sess-1", messageId: "msg-1", toolCallId: "lp", tool: "lookup_people"
        ))
        await coord.applyEventForTesting(.toolStart(
            sessionId: "sess-1",
            messageId: "msg-1",
            toolCallId: "lp",
            tool: "lookup_people",
            args: JSONAny(value: ["query": "maya"] as [String: Any]),
            argsSummary: "maya"
        ))
        await coord.applyEventForTesting(.toolResult(
            sessionId: "sess-1",
            messageId: "msg-1",
            toolCallId: "lp",
            result: personResult(),
            durationMs: 1
        ))
        // Everything from here parks on `lp` until it flushes.
        await coord.applyEventForTesting(.thinkingDelta(sessionId: "sess-1", messageId: "msg-1", delta: "thinking A "))
        await driveSearchMany(coord, toolCallId: "sm1")
        await coord.applyEventForTesting(.thinkingDelta(sessionId: "sess-1", messageId: "msg-1", delta: "thinking B "))
        await driveSearchMany(coord, toolCallId: "sm2")
        await coord.applyEventForTesting(.textDelta(sessionId: "sess-1", messageId: "msg-1", delta: "Here is the answer."))
        await coord.applyEventForTesting(.toolInputStart(
            sessionId: "sess-1", messageId: "msg-1", toolCallId: "am", tool: "annotate_many"
        ))

        // Pre-flush: the whole turn is stranded behind `lp` — no search_many /
        // text parts are visible yet.
        XCTAssertEqual(partTags(coord), ["think:Let me look… ", "tool:lp"])
        let gated = try XCTUnwrap(toolCall(coord, toolCallId: "lp"))
        XCTAssertGreaterThan(gated.pendingTail.count, 6, "the batches + thinking + text all parked on lp")
        XCTAssertFalse(gated.tailDismissed)

        // Release the gate (stand-in for the card's dismiss task OR the
        // wall-clock backstop) — the parked beats drain in order.
        await coord.flushEphemeralTail(toolCallId: "lp")

        let flushed = try XCTUnwrap(toolCall(coord, toolCallId: "lp"))
        XCTAssertTrue(flushed.tailDismissed)
        XCTAssertEqual(flushed.pendingTail, [])
        let tags = partTags(coord)
        XCTAssertTrue(tags.contains("tool:sm1"), "search_many #1 became visible")
        XCTAssertTrue(tags.contains("tool:sm2"), "search_many #2 became visible")
        XCTAssertTrue(tags.contains("tool:am"), "annotate_many became visible")
        XCTAssertTrue(tags.contains { $0.hasPrefix("text:") }, "the answer text became visible")
        // Order is preserved: lp before sm1 before sm2 before the text.
        let idxLp = try XCTUnwrap(tags.firstIndex(of: "tool:lp"))
        let idxSm1 = try XCTUnwrap(tags.firstIndex(of: "tool:sm1"))
        let idxSm2 = try XCTUnwrap(tags.firstIndex(of: "tool:sm2"))
        let idxText = try XCTUnwrap(tags.firstIndex { $0.hasPrefix("text:") })
        XCTAssertTrue(idxLp < idxSm1 && idxSm1 < idxSm2 && idxSm2 < idxText)
    }

    /// The backstop fires on its own: with content parked behind an ephemeral
    /// gate and NO `flushEphemeralTail` from a card (and no `message.end`), the
    /// coordinator's wall-clock max-hold releases the gate so the transcript
    /// still streams. Uses a tiny override so the test doesn't wait 1.5s.
    func testGateMaxHoldBackstopAutoFlushesWithoutCardOrMessageEnd() async throws {
        let coord = makeCoordinator()
        coord.gateMaxHoldSecondsForTesting = 0.02
        await coord.applyEventForTesting(.messageStart(sessionId: "sess-1", messageId: "msg-1"))
        await coord.applyEventForTesting(.toolInputStart(
            sessionId: "sess-1", messageId: "msg-1", toolCallId: "lp", tool: "lookup_people"
        ))
        await coord.applyEventForTesting(.toolStart(
            sessionId: "sess-1",
            messageId: "msg-1",
            toolCallId: "lp",
            tool: "lookup_people",
            args: JSONAny(value: ["query": "maya"] as [String: Any]),
            argsSummary: "maya"
        ))
        await coord.applyEventForTesting(.toolResult(
            sessionId: "sess-1",
            messageId: "msg-1",
            toolCallId: "lp",
            result: personResult(),
            durationMs: 1
        ))
        // Content parks — arms the backstop.
        await coord.applyEventForTesting(.textDelta(sessionId: "sess-1", messageId: "msg-1", delta: "The answer."))
        let parked = try XCTUnwrap(toolCall(coord, toolCallId: "lp"))
        XCTAssertEqual(parked.pendingTail.count, 1)
        XCTAssertFalse(parked.tailDismissed, "not yet — the backstop hasn't fired")

        // Wait past the (tiny) max-hold. No card, no message.end.
        try await Task.sleep(nanoseconds: 250_000_000)

        let released = try XCTUnwrap(toolCall(coord, toolCallId: "lp"))
        XCTAssertTrue(released.tailDismissed, "the wall-clock backstop released the gate on its own")
        XCTAssertEqual(released.pendingTail, [])
        XCTAssertEqual(partTags(coord), ["tool:lp", "text:The answer."])
    }
}
