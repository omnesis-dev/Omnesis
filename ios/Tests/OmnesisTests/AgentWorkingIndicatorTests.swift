// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

/// Exercises the turn-level "working" dots eligibility
/// (`AgentCoordinator.workingIndicatorActive`). The reveal itself is a
/// SwiftUI debounce verified by snapshot; this is the pure decision of
/// WHETHER the dots are eligible given the transcript tail — the piece that
/// determines the fallback covers the beats no per-item card can (a batch
/// tool running with no card, a completed tool before the next step).
@available(iOS 17.0, *)
@MainActor
final class AgentWorkingIndicatorTests: XCTestCase {
    private func tool(
        _ name: String,
        result: AgentToolResult? = nil,
        children: [AgentToolChild] = []
    )
        -> AgentToolCall {
        var call = AgentToolCall(
            toolCallId: "tc",
            tool: name,
            args: JSONAny(value: NSNull()),
            argsSummary: "",
            argsKnown: true,
            result: result,
            durationMs: nil
        )
        call.children = children
        return call
    }

    private func someSearch() -> AgentToolResult {
        .searchResults(query: "x", durationMs: 1, candidates: 0, results: [])
    }

    private func batchResult() -> AgentToolResult {
        .searchBatch(items: [someSearch()])
    }

    private func assistant(_ parts: [AgentPart], stopReason: String? = nil) -> [AgentTurn] {
        [.assistant(AgentAssistantTurn(id: "a", parts: parts, stopReason: stopReason))]
    }

    private func active(_ turns: [AgentTurn], busy: Bool = true) -> Bool {
        AgentCoordinator.workingIndicatorActive(busy: busy, turns: turns)
    }

    func testIdleTurnIsNeverActive() {
        XCTAssertFalse(active(assistant([.text("done")]), busy: false))
    }

    func testEmptyTranscriptIsInactive() {
        XCTAssertFalse(active([], busy: true))
    }

    func testUserTailAwaitingFirstToken() {
        XCTAssertTrue(active([.user(id: "u", text: "hi")]))
    }

    func testEmptyAssistantPartsIsActive() {
        // message.start landed, no delta yet — nothing renders, dots cover it.
        XCTAssertTrue(active(assistant([])))
    }

    func testFinishedTurnIsInactive() {
        XCTAssertFalse(active(assistant([.text("answer")], stopReason: "end_turn")))
    }

    func testStreamingTextTailIsEligible() {
        // Eligibility says yes; the view's version-debounce suppresses the
        // reveal while tokens actively stream, and surfaces it once quiet.
        XCTAssertTrue(active(assistant([.text("partial")])))
    }

    func testLiveThinkingTailSuppressesDots() {
        // The thinking shimmer already signals activity.
        XCTAssertFalse(active(assistant([.thinking("reasoning…")])))
    }

    func testRunningSubagentSuppressesDots() {
        var card = AgentSubagentCard(
            subagentId: "s", specialist: "history-sweep", title: "Sweep", task: "t", parentToolCallId: nil
        )
        card.status = nil // still running
        XCTAssertFalse(active(assistant([.subagent(card)])))
    }

    func testFinishedSubagentTailIsActive() {
        var card = AgentSubagentCard(
            subagentId: "s", specialist: "history-sweep", title: "Sweep", task: "t", parentToolCallId: nil
        )
        card.status = "complete"
        XCTAssertTrue(active(assistant([.subagent(card)])))
    }

    // MARK: - The core fix: batch tools with no rendered card

    /// The +28→+47 "thinking-gap" from the field report: `search_many` has just
    /// returned and, with no child-progress events (only Codex streams those),
    /// renders NO card — while the model thinks server-side before the answer.
    /// The dots are the only "still working" signal, so eligibility is true.
    func testCompletedBatchWithNoChildrenIsActive() {
        XCTAssertTrue(active(assistant([.tool(tool("search_many", result: batchResult()))])))
    }

    /// A batch tool RUNNING with no child cards — the multi-second silent
    /// window on Anthropic. Previously classed inactive (pending tool), so the
    /// dots never showed; now eligible.
    func testPendingBatchWithNoChildrenIsActive() {
        XCTAssertTrue(active(assistant([.tool(tool("search_many"))])))
    }

    /// A batch tool WITH per-child cards (Codex) is self-signalling — the cards
    /// roll/dismiss — so the dots stay out of their way, running or finished.
    func testBatchWithChildCardsSuppressesDots() {
        let child = AgentToolChild(index: 0, tool: "search_documents", argsSummary: "q", result: nil)
        XCTAssertFalse(active(assistant([.tool(tool("search_many", children: [child]))])))
        XCTAssertFalse(active(assistant([
            .tool(tool("search_many", result: batchResult(), children: [child])),
        ])))
    }

    // MARK: - Singular tools keep their existing self-affordance

    func testPendingSingularToolShowsOwnSpinner() {
        // An ephemeral card (or the generic tool chrome) already spins.
        XCTAssertFalse(active(assistant([.tool(tool("search_documents"))])))
    }

    func testCompletedSingularToolIsActive() {
        // The card is static/dismissing while the model generates the next step.
        XCTAssertTrue(active(assistant([.tool(tool("search_documents", result: someSearch()))])))
    }
}
