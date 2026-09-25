// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

/// Exercises the sub-agent card reducer in `AgentCoordinator` — the
/// iOS twin of the portal `agent.subagent.*` reducer arms. Drives events
/// through `applyEventForTesting`, bypassing the live SSE stream, so the
/// card-building semantics (spawn → live accounting → finalise) can be
/// observed in isolation. Mirrors the portal reducer tests one-for-one.
@available(iOS 17.0, *)
@MainActor
final class AgentCoordinatorSubagentTests: XCTestCase {
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

    /// Open the parent assistant turn, then spawn one sub-agent on it.
    private func spawnOn(_ coord: AgentCoordinator) async {
        await coord.applyEventForTesting(.messageStart(sessionId: "sess-1", messageId: "msg-1"))
        await coord.applyEventForTesting(.subagentSpawned(
            sessionId: "sess-1",
            subagentId: "sess-1.sub.a",
            specialist: "history-sweep",
            task: "Find Q4 budget docs",
            parentToolCallId: "tu_spawn"
        ))
    }

    private func card(_ coord: AgentCoordinator, _ subagentId: String) -> AgentSubagentCard? {
        for turn in coord.turns {
            guard case .assistant(let a) = turn else { continue }
            for part in a.parts {
                if case .subagent(let c) = part, c.subagentId == subagentId { return c }
            }
        }
        return nil
    }

    // MARK: - Spawn

    func testSpawnOpensCollapsedCardOnParentTurn() async {
        let coord = makeCoordinator()
        await spawnOn(coord)
        let c = card(coord, "sess-1.sub.a")
        XCTAssertNotNil(c)
        XCTAssertEqual(c?.specialist, "history-sweep")
        XCTAssertEqual(c?.task, "Find Q4 budget docs")
        XCTAssertEqual(c?.parentToolCallId, "tu_spawn")
        XCTAssertEqual(c?.stepCount, 0)
        XCTAssertEqual(c?.tokens, 0)
        XCTAssertNil(c?.status, "card is in flight until result lands")
        XCTAssertTrue(c?.childTurns.isEmpty ?? false)
    }

    func testRedeliveredSpawnIsIdempotent() async {
        let coord = makeCoordinator()
        await spawnOn(coord)
        await coord.applyEventForTesting(.subagentSpawned(
            sessionId: "sess-1", subagentId: "sess-1.sub.a",
            specialist: "history-sweep", task: "Find Q4 budget docs", parentToolCallId: "tu_spawn"
        ))
        // Exactly one card across all turns.
        let count = coord.turns.reduce(0) { acc, turn in
            guard case .assistant(let a) = turn else { return acc }
            return acc + a.parts.filter {
                if case .subagent(let c) = $0 { return c.subagentId == "sess-1.sub.a" }
                return false
            }.count
        }
        XCTAssertEqual(count, 1)
    }

    func testSpawnToolCardIsReplacedByStableWorkerCard() async {
        let coord = makeCoordinator()
        await coord.applyEventForTesting(.messageStart(sessionId: "sess-1", messageId: "msg-1"))
        await coord.applyEventForTesting(.toolInputStart(
            sessionId: "sess-1", messageId: "msg-1",
            toolCallId: "tu_spawn", tool: "spawn_subagent"
        ))
        await coord.applyEventForTesting(.toolStart(
            sessionId: "sess-1", messageId: "msg-1", toolCallId: "tu_spawn",
            tool: "spawn_subagent", args: JSONAny(value: ["task": "Compare two periods"]),
            argsSummary: "Compare two periods"
        ))
        await coord.applyEventForTesting(.subagentSpawned(
            sessionId: "sess-1", subagentId: "sess-1.sub.a", specialist: "generic",
            task: "Compare two periods", parentToolCallId: "tu_spawn"
        ))

        let parts = assistantTurn(coord, "msg-1")?.parts ?? []
        XCTAssertTrue(parts.contains { if case .subagent = $0 { return true }
            return false
        })
        XCTAssertFalse(parts.contains {
            if case .tool(let call) = $0 { return call.tool == "spawn_subagent" }
            return false
        })
    }

    func testJoinToolNeverAppearsInTranscript() async {
        let coord = makeCoordinator()
        await coord.applyEventForTesting(.messageStart(sessionId: "sess-1", messageId: "msg-1"))
        await coord.applyEventForTesting(.toolInputStart(
            sessionId: "sess-1", messageId: "msg-1",
            toolCallId: "tu_join", tool: "join_subagents"
        ))
        await coord.applyEventForTesting(.toolStart(
            sessionId: "sess-1", messageId: "msg-1", toolCallId: "tu_join",
            tool: "join_subagents", args: JSONAny(value: ["subagentIds": ["sess-1.sub.a"]]),
            argsSummary: "1 worker"
        ))
        await coord.applyEventForTesting(.toolResult(
            sessionId: "sess-1", messageId: "msg-1", toolCallId: "tu_join",
            result: .error(code: "ok", message: ""), durationMs: 1
        ))

        XCTAssertFalse((assistantTurn(coord, "msg-1")?.parts ?? []).contains {
            if case .tool(let call) = $0 { return call.tool == "join_subagents" }
            return false
        })
    }

    func testMessageEndDrainsQueuedWorkerThenRemovesLaunchTool() async {
        let coord = makeCoordinator()
        await coord.applyEventForTesting(.messageStart(sessionId: "sess-1", messageId: "msg-1"))
        await coord.applyEventForTesting(.toolStart(
            sessionId: "sess-1", messageId: "msg-1", toolCallId: "tu_spawn",
            tool: "spawn_subagent", args: JSONAny(value: ["task": "Inspect evidence"]),
            argsSummary: "Inspect evidence"
        ))
        await coord.applyEventForTesting(.toolResult(
            sessionId: "sess-1", messageId: "msg-1", toolCallId: "tu_spawn",
            result: .error(code: "ok", message: ""), durationMs: 1
        ))
        // The finished ephemeral launch is now a causality gate, so the
        // stable row queues until the animation or end-of-turn safety net.
        await coord.applyEventForTesting(.subagentSpawned(
            sessionId: "sess-1", subagentId: "sess-1.sub.a", specialist: "generic",
            task: "Inspect evidence", parentToolCallId: "tu_spawn"
        ))
        await coord.applyEventForTesting(.messageEnd(
            sessionId: "sess-1", messageId: "msg-1", stopReason: "end_turn"
        ))

        let parts = assistantTurn(coord, "msg-1")?.parts ?? []
        XCTAssertTrue(parts.contains { if case .subagent = $0 { return true }
            return false
        })
        XCTAssertFalse(parts.contains {
            if case .tool(let call) = $0 { return agentOrchestrationTools.contains(call.tool) }
            return false
        })
    }

    // MARK: - Live accounting

    /// Child prose is not retained; completed tools leave only counters/docs.
    func testWrappedChildEventsKeepBoundedAccountingState() async {
        let coord = makeCoordinator()
        await spawnOn(coord)
        await wrap(coord, .messageStart(sessionId: "sess-1.sub.a", messageId: "cm1"))
        await wrap(coord, .textDelta(sessionId: "sess-1.sub.a", messageId: "cm1", delta: "sweeping "))
        await wrap(coord, .textDelta(sessionId: "sess-1.sub.a", messageId: "cm1", delta: "email"))
        await wrap(coord, .toolStart(
            sessionId: "sess-1.sub.a", messageId: "cm1", toolCallId: "ct1",
            tool: "search_documents",
            args: JSONAny(value: ["query": "Q4"] as [String: Any]),
            argsSummary: "Q4"
        ))
        await wrap(coord, .toolResult(
            sessionId: "sess-1.sub.a", messageId: "cm1", toolCallId: "ct1",
            result: .searchResults(query: "Q4", durationMs: 1, candidates: 1, results: [
                AgentDocRef(documentId: "d1", sourceType: "gmail", sourceId: "gmail:me"),
            ]),
            durationMs: 5
        ))
        let c = card(coord, "sess-1.sub.a")
        XCTAssertEqual(c?.stepCount, 1, "one child tool call = one step")
        XCTAssertEqual(c?.childTurns.count, 1)
        XCTAssertEqual(c?.childTurns.first?.parts.count, 0)
        XCTAssertEqual(c?.docs.map(\.documentId), ["d1"])
    }

    /// A wrapped child event whose `type` this build doesn't know leaves the
    /// card unchanged — the iOS analogue of Android's `AgentPart.Unknown`.
    func testUnknownWrappedChildEventDegradesGracefully() async {
        let coord = makeCoordinator()
        await spawnOn(coord)
        let before = card(coord, "sess-1.sub.a")
        await coord.applyEventForTesting(.subagentEvent(
            sessionId: "sess-1", subagentId: "sess-1.sub.a", specialist: "history-sweep",
            event: .unknown(type: "agent.future.kind")
        ))
        let after = card(coord, "sess-1.sub.a")
        XCTAssertEqual(before?.childTurns.count, after?.childTurns.count)
        XCTAssertEqual(after?.childTurns.count, 0)
        XCTAssertEqual(after?.stepCount, 0)
    }

    func testChildMessageEndAccruesReportedUsageBeforeTheResearcherFinishes() async {
        let coord = makeCoordinator()
        await spawnOn(coord)
        await wrap(coord, .messageEnd(
            sessionId: "sess-1.sub.a",
            messageId: "cm1",
            stopReason: "tool_use",
            usage: AgentUsage(inputTokens: 800, outputTokens: 200)
        ))
        XCTAssertEqual(card(coord, "sess-1.sub.a")?.tokens, 1000)
        XCTAssertTrue(card(coord, "sess-1.sub.a")?.childTurns.isEmpty ?? false)
    }

    func testChildUsageUpdateShowsCumulativeTokensBeforeTheRequestEnds() async {
        let coord = makeCoordinator()
        await spawnOn(coord)
        await wrap(coord, .usageUpdate(
            sessionId: "sess-1.sub.a",
            messageId: "cm1",
            usage: AgentUsage(inputTokens: 800, outputTokens: 200)
        ))
        XCTAssertEqual(card(coord, "sess-1.sub.a")?.tokens, 1000)
    }

    func testChildUsageUpdateIsReplacedByTerminalUsageWithoutDoubleCounting() async {
        let coord = makeCoordinator()
        await spawnOn(coord)
        await wrap(coord, .usageUpdate(sessionId: "sess-1.sub.a", messageId: "cm1", usage: AgentUsage(inputTokens: 800, outputTokens: 200)))
        await wrap(
            coord,
            .messageEnd(
                sessionId: "sess-1.sub.a",
                messageId: "cm1",
                stopReason: "tool_use",
                usage: AgentUsage(inputTokens: 800, outputTokens: 200)
            )
        )
        await wrap(coord, .usageUpdate(sessionId: "sess-1.sub.a", messageId: "cm2", usage: AgentUsage(inputTokens: 500, outputTokens: 100)))
        XCTAssertEqual(card(coord, "sess-1.sub.a")?.tokens, 1600)
    }

    func testChildPartialUsageMergesAndDuplicateTerminalEventIsIgnored() async {
        let coord = makeCoordinator()
        await spawnOn(coord)
        await wrap(coord, .usageUpdate(sessionId: "sess-1.sub.a", messageId: "cm1", usage: AgentUsage(inputTokens: 100)))
        await wrap(coord, .usageUpdate(sessionId: "sess-1.sub.a", messageId: "cm1", usage: AgentUsage(outputTokens: 10)))
        let end = AgentEvent.messageEnd(
            sessionId: "sess-1.sub.a",
            messageId: "cm1",
            stopReason: "tool_use",
            usage: AgentUsage(outputTokens: 20)
        )
        await wrap(coord, end)
        await wrap(coord, end)
        XCTAssertEqual(card(coord, "sess-1.sub.a")?.tokens, 120)
    }

    func testBatchChildResultAddsDocumentsBeforeTheBatchFinishes() async {
        let coord = makeCoordinator()
        await spawnOn(coord)
        await wrap(coord, .toolChildResult(
            sessionId: "sess-1.sub.a",
            messageId: "cm1",
            toolCallId: "batch1",
            childIndex: 0,
            result: .searchResults(query: "ledger", durationMs: 1, candidates: 1, results: [
                AgentDocRef(documentId: "d1", sourceType: "drive", sourceId: "drive:acct", title: "Ledger"),
            ])
        ))
        XCTAssertEqual(card(coord, "sess-1.sub.a")?.docs.map(\.documentId), ["d1"])
    }

    func testTerminalBatchResultAddsDocumentsWhenLiveChildEventsAreUnavailable() async {
        let coord = makeCoordinator()
        await spawnOn(coord)
        await wrap(coord, .toolResult(
            sessionId: "sess-1.sub.a",
            messageId: "cm1",
            toolCallId: "batch1",
            result: .searchBatch(items: [
                .searchResults(query: "ledger", durationMs: 1, candidates: 1, results: [
                    AgentDocRef(documentId: "d1", sourceType: "drive", sourceId: "drive:acct", title: "Ledger"),
                ]),
            ]),
            durationMs: 1
        ))
        XCTAssertEqual(card(coord, "sess-1.sub.a")?.docs.map(\.documentId), ["d1"])
    }

    // MARK: - Finalise

    func testResultFinalisesStatusSummaryAndAdoptsAuthoritativeTokens() async {
        let coord = makeCoordinator()
        await spawnOn(coord)
        await coord.applyEventForTesting(.subagentResult(
            sessionId: "sess-1", subagentId: "sess-1.sub.a", specialist: "history-sweep",
            status: "complete", summary: "Events overspent 18%.",
            citations: [AgentDocRef(documentId: "d1", sourceType: "gmail", sourceId: "gmail:me")],
            usage: AgentUsage(inputTokens: 1200, outputTokens: 340),
            treeUsage: AgentUsage(inputTokens: 4000, outputTokens: 900)
        ))
        let c = card(coord, "sess-1.sub.a")
        XCTAssertEqual(c?.status, "complete")
        XCTAssertEqual(c?.summary, "Events overspent 18%.")
        XCTAssertEqual(c?.tokens, 1540, "authoritative per-child usage adopted on finalise")
        XCTAssertEqual(c?.docs.map(\.documentId), ["d1"])
        XCTAssertEqual(c?.retainedCitationCount, 1)
    }

    func testFailedResultRetainsDeliberateCitationsForPartialResultState() async {
        let coord = makeCoordinator()
        await spawnOn(coord)
        await coord.applyEventForTesting(.subagentResult(
            sessionId: "sess-1", subagentId: "sess-1.sub.a", specialist: "generic",
            status: "failed",
            summary: "Partial evidence collected before the worker reached its output limit:\n- Project note: Approved.",
            citations: [AgentDocRef(documentId: "d1", sourceType: "notes", sourceId: "notes:local")],
            usage: nil, treeUsage: nil,
            failure: AgentTerminalFailure(
                code: "output_truncated", message: "The model reached its output limit.",
                retryable: false, backend: "http", model: "fictional-model"
            )
        ))

        let c = card(coord, "sess-1.sub.a")
        XCTAssertEqual(c?.status, "failed")
        XCTAssertEqual(c?.retainedCitationCount, 1)
        XCTAssertEqual(c?.failureCode, "output_truncated")
        XCTAssertEqual(c?.hasPartialResult, true)
        XCTAssertEqual(c?.docs.map(\.documentId), ["d1"])
    }

    func testCitedNonTruncationFailureRemainsAnOrdinaryFailure() async {
        let coord = makeCoordinator()
        await spawnOn(coord)
        await coord.applyEventForTesting(.subagentResult(
            sessionId: "sess-1", subagentId: "sess-1.sub.a", specialist: "generic",
            status: "failed", summary: "HTTP model request failed.",
            citations: [AgentDocRef(documentId: "d1", sourceType: "notes", sourceId: "notes:local")],
            usage: nil, treeUsage: nil,
            failure: AgentTerminalFailure(
                code: "http_api_error", message: "HTTP model request failed.",
                retryable: true, backend: "http", model: "fictional-model"
            )
        ))

        let c = card(coord, "sess-1.sub.a")
        XCTAssertEqual(c?.retainedCitationCount, 1)
        XCTAssertEqual(c?.failureCode, "http_api_error")
        XCTAssertEqual(c?.hasPartialResult, false)
    }

    /// A result that reports no token counts must NOT clobber the running
    /// tally back to zero.
    func testResultWithoutUsageKeepsRunningTally() async {
        let coord = makeCoordinator()
        await spawnOn(coord)
        // Two wrapped tool calls bump stepCount; tokens stay 0 here (iOS
        // accrues the authoritative figure only from the result).
        await wrap(coord, .messageStart(sessionId: "sess-1.sub.a", messageId: "cm1"))
        await wrap(coord, .toolStart(
            sessionId: "sess-1.sub.a", messageId: "cm1", toolCallId: "ct1",
            tool: "search_documents", args: JSONAny(value: NSNull()), argsSummary: "x"
        ))
        await coord.applyEventForTesting(.subagentResult(
            sessionId: "sess-1", subagentId: "sess-1.sub.a", specialist: "history-sweep",
            status: "failed", summary: "no results", citations: [], usage: nil, treeUsage: nil
        ))
        let c = card(coord, "sess-1.sub.a")
        XCTAssertEqual(c?.status, "failed")
        XCTAssertEqual(c?.retainedCitationCount, 0)
        XCTAssertEqual(c?.stepCount, 1)
        XCTAssertEqual(c?.tokens, 0)
    }

    // MARK: - Cross-session isolation

    func testEventForOtherSessionIsIgnored() async {
        let coord = makeCoordinator()
        await spawnOn(coord)
        // A spawn on a different parent session must not touch our turns.
        await coord.applyEventForTesting(.subagentSpawned(
            sessionId: "sess-OTHER", subagentId: "sess-OTHER.sub.z",
            specialist: "source-digest", task: "elsewhere", parentToolCallId: nil
        ))
        XCTAssertNil(card(coord, "sess-OTHER.sub.z"))
    }

    /// A `subagent.event` / `.result` arriving for an unknown card (e.g.
    /// before its spawn) is a no-op rather than a crash.
    func testEventForUnknownCardIsNoOp() async {
        let coord = makeCoordinator()
        await spawnOn(coord)
        await coord.applyEventForTesting(.subagentResult(
            sessionId: "sess-1", subagentId: "sess-1.sub.NOPE", specialist: "x",
            status: "complete", summary: "s", citations: [], usage: nil, treeUsage: nil
        ))
        // Our real card is untouched.
        XCTAssertNil(card(coord, "sess-1.sub.a")?.status)
    }

    private func wrap(_ coord: AgentCoordinator, _ childEvent: AgentEvent) async {
        await coord.applyEventForTesting(.subagentEvent(
            sessionId: "sess-1", subagentId: "sess-1.sub.a", specialist: "history-sweep",
            event: childEvent
        ))
    }

    // MARK: - Verified-report artifact

    private func assistantTurn(_ coord: AgentCoordinator, _ id: String) -> AgentAssistantTurn? {
        for turn in coord.turns {
            if case .assistant(let a) = turn, a.id == id { return a }
        }
        return nil
    }

    /// The summary event folds onto the named assistant turn as a
    /// `reportArtifact` carrying the honest reason, plan, tree usage, and the
    /// real verification tally.
    func testDeepResearchSummaryFoldsArtifactOntoNamedTurn() async {
        let coord = makeCoordinator()
        await coord.applyEventForTesting(.messageStart(sessionId: "sess-1", messageId: "msg-1"))
        await coord.applyEventForTesting(.deepResearchSummary(
            sessionId: "sess-1",
            messageId: "msg-1",
            stoppedReason: "answer_complete",
            plan: [AgentDeepResearchPlanItem(specialist: "history-sweep", task: "Sweep mail")],
            treeUsage: AgentUsage(inputTokens: 1000, outputTokens: 500),
            verification: AgentDeepResearchVerification(quotesChecked: 3, quotesVerified: 3)
        ))
        let artifact = assistantTurn(coord, "msg-1")?.reportArtifact
        XCTAssertNotNil(artifact)
        XCTAssertEqual(artifact?.stoppedReason, "answer_complete")
        XCTAssertEqual(artifact?.plan, [AgentDeepResearchPlanItem(specialist: "history-sweep", task: "Sweep mail")])
        XCTAssertEqual(artifact?.treeUsage?.total, 1500)
        XCTAssertEqual(artifact?.verification, AgentDeepResearchVerification(quotesChecked: 3, quotesVerified: 3))
    }

    /// Graceful degrade: a turn that never carried a summary event has no
    /// artifact (it renders as the plain report bubble).
    func testTurnWithoutSummaryCarriesNoArtifact() async {
        let coord = makeCoordinator()
        await coord.applyEventForTesting(.messageStart(sessionId: "sess-1", messageId: "msg-1"))
        await coord.applyEventForTesting(.textDelta(sessionId: "sess-1", messageId: "msg-1", delta: "Done."))
        await coord.applyEventForTesting(.messageEnd(sessionId: "sess-1", messageId: "msg-1", stopReason: "end_turn"))
        XCTAssertNil(assistantTurn(coord, "msg-1")?.reportArtifact)
    }

    /// A summary naming a messageId no turn carries (a race / lost turn) is a
    /// no-op — never mis-attaches onto the wrong turn.
    func testDeepResearchSummaryForUnknownTurnIsNoOp() async {
        let coord = makeCoordinator()
        await coord.applyEventForTesting(.messageStart(sessionId: "sess-1", messageId: "msg-1"))
        await coord.applyEventForTesting(.deepResearchSummary(
            sessionId: "sess-1",
            messageId: "msg-NOPE",
            stoppedReason: "answer_complete",
            plan: [],
            treeUsage: nil,
            verification: AgentDeepResearchVerification(quotesChecked: 0, quotesVerified: 0)
        ))
        XCTAssertNil(assistantTurn(coord, "msg-1")?.reportArtifact)
    }

    /// A summary for another session is dropped at the session guard, never
    /// touching our turn.
    func testDeepResearchSummaryForOtherSessionIsIgnored() async {
        let coord = makeCoordinator()
        await coord.applyEventForTesting(.messageStart(sessionId: "sess-1", messageId: "msg-1"))
        await coord.applyEventForTesting(.deepResearchSummary(
            sessionId: "sess-OTHER",
            messageId: "msg-1",
            stoppedReason: "answer_complete",
            plan: [],
            treeUsage: nil,
            verification: AgentDeepResearchVerification(quotesChecked: 1, quotesVerified: 1)
        ))
        XCTAssertNil(assistantTurn(coord, "msg-1")?.reportArtifact)
    }
}
