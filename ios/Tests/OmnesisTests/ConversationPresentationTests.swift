// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

@available(iOS 17.0, *)
@MainActor
final class ConversationPresentationTests: XCTestCase {
    private func question(_ id: String = "question") -> AgentToolResult {
        .unknown(kind: "structured", raw: JSONAny(value: [
            "kind": "structured", "resultType": "conversation.clarification",
            "data": [
                "id": id,
                "question": "Which period?",
                "choices": [["label": "This year"], ["label": "Last year"]],
            ],
        ]))
    }

    private func tool(_ name: String, result: AgentToolResult?, id: String = "tool") -> AgentPart {
        .tool(.init(
            toolCallId: id,
            tool: name,
            args: JSONAny(value: [:]),
            argsSummary: "",
            argsKnown: true,
            result: result,
            durationMs: nil
        ))
    }

    private func controls(_ id: String?) -> ConversationControls {
        .init(
            busy: false,
            pendingClarification: id.map {
                .init(id: $0, question: "Which period?", choices: [.init(label: "This year", description: nil)])
            },
            queuedMessages: []
        )
    }

    func testQuestionPresentationIsScopedToMatchingToolAndRestoresHistory() {
        let before = AgentPart.text("Before the question")
        let after = AgentPart.text("Which period?")
        let parts = [before, tool("ask_clarification", result: question()), after]
        XCTAssertEqual(conversationPresentedParts(parts, controls: controls("question")), [before])
        XCTAssertEqual(conversationPresentedParts(parts, controls: controls("different")), [before, after])
        XCTAssertEqual(conversationPresentedParts(parts, controls: controls(nil)), [before, after])
        XCTAssertEqual(conversationPresentedParts(parts, controls: nil), parts)
        XCTAssertEqual(conversationPresentedParts([after], controls: controls("question")), [after])
    }

    func testMalformedUnknownAndFailedClarificationsKeepFallback() {
        let results: [AgentToolResult] = [
            .error(code: "FAILED", message: "Try again"),
            .unknown(kind: "structured", raw: JSONAny(value: ["resultType": "future.result", "data": [:]])),
            .unknown(
                kind: "structured",
                raw: JSONAny(value: ["resultType": "conversation.clarification", "data": [:]])
            ),
        ]
        for result in results {
            let parts = [tool("ask_clarification", result: result), .text("Fallback explanation")]
            XCTAssertEqual(conversationPresentedParts(parts, controls: controls("question")), parts)
        }
    }

    func testDismissalPreservesDurableToolsAndFailures() {
        let failure = tool("search_documents", result: .error(code: "FAILED", message: "Unavailable"))
        let durable = tool("future_action", result: nil, id: "durable")
        let parts: [AgentPart] = [
            .text("Saved answer"),
            .thinking("Working"),
            tool("search_documents", result: nil),
            durable,
            failure,
        ]
        XCTAssertEqual(
            conversationPresentedParts(parts, controls: nil, activityDismissed: true),
            [.text("Saved answer"), durable, failure]
        )
    }

    func testDismissalHidesAbortedBatchCitationAndWorkerActivityButKeepsFailures() async {
        let aborted = AgentToolResult.error(code: "turn_aborted", message: "Interrupted")
        let failure = AgentToolResult.error(code: "FAILED", message: "Unavailable")
        let worker = AgentSubagentCard(
            subagentId: "worker",
            specialist: "generic",
            title: "Compare totals",
            task: "Compare",
            parentToolCallId: "spawn"
        )
        var canceledWorker = worker
        canceledWorker.status = "failed"
        canceledWorker.failureCode = "turn_aborted"
        var failedWorker = worker
        failedWorker.status = "failed"
        guard case .tool(var batch) = tool("search_many", result: nil) else { return XCTFail("Missing batch") }
        batch.children = [.init(index: 0, tool: "search_documents", argsSummary: "", result: aborted)]
        let parts: [AgentPart] = [
            .tool(batch),
            tool("search_many", result: .error(code: "canceled", message: "Canceled")),
            tool("search_many", result: aborted),
            tool("fetch_many", result: .documentBatch(items: [aborted])),
            tool("annotate", result: nil),
            tool("annotate_many", result: nil),
            .subagent(worker),
            .subagent(canceledWorker),
            .subagent(failedWorker),
            tool("search_many", result: .searchBatch(items: [aborted, failure])),
        ]
        XCTAssertEqual(conversationPresentedParts(parts, controls: nil), parts)
        XCTAssertEqual(
            conversationPresentedParts(parts, controls: nil, activityDismissed: true),
            [.subagent(failedWorker), projectedFailureBatch(failure, aborted: aborted)]
        )
        let coordinator = AgentCoordinator()
        coordinator.installPreviewState(
            sessionId: "session",
            model: "m",
            backend: "b",
            title: "Example",
            turns: [.assistant(AgentAssistantTurn(id: "old", parts: [.subagent(worker)]))],
            citations: [],
            conversations: []
        )
        XCTAssertFalse(coordinator.researchPanels.isEmpty)
        await coordinator.dismissPriorConversationActivity()
        XCTAssertTrue(coordinator.researchPanels.isEmpty)
        await coordinator.applyEventForTesting(.subagentSpawned(
            sessionId: "session",
            subagentId: "late",
            specialist: "generic",
            task: "Compare",
            title: "Compare totals",
            parentToolCallId: nil
        ))
        guard case .assistant(let old) = coordinator.turns.last else { return XCTFail("Missing assistant") }
        XCTAssertEqual(old.parts, [.subagent(worker)])
    }

    private func projectedFailureBatch(_ failure: AgentToolResult, aborted: AgentToolResult) -> AgentPart {
        guard case .tool(var call) = tool("search_many", result: .searchBatch(items: [aborted, failure])) else {
            fatalError("Expected batch")
        }
        call.children = [.init(index: 1, tool: "search_documents", argsSummary: "", result: failure)]
        return .tool(call)
    }

    func testDismissedMixedBatchShowsOnlyGenuineFailureChildren() {
        guard case .tool(var call) = tool("search_many", result: nil) else { return XCTFail("Missing batch") }
        let failure = AgentToolResult.error(code: "FAILED", message: "Unavailable")
        call.children = [
            .init(index: 0, tool: "search_documents", argsSummary: "", result: nil),
            .init(index: 1, tool: "search_documents", argsSummary: "", result: .searchResults(
                query: "Example", durationMs: 1, candidates: 0, results: []
            )),
            .init(index: 2, tool: "search_documents", argsSummary: "", result: .error(code: "canceled", message: "Canceled")),
            .init(index: 3, tool: "search_documents", argsSummary: "", result: failure),
        ]
        let parts = conversationPresentedParts([.tool(call)], controls: nil, activityDismissed: true)
        guard case .tool(let retained) = parts.first else { return XCTFail("Missing failure") }
        XCTAssertEqual(retained.children, [call.children[3]])
        XCTAssertNil(retained.result)
        XCTAssertEqual(call.children.count, 4, "Canonical children remain intact")
    }

    func testLateResumedToolFailureUsesOriginalToolIdentity() async {
        let coordinator = AgentCoordinator()
        coordinator.installPreviewState(
            sessionId: "session",
            model: "m",
            backend: "b",
            title: "Example",
            turns: [.assistant(AgentAssistantTurn(id: "history-id", parts: [tool("search_many", result: nil)]))],
            citations: [],
            conversations: []
        )
        await coordinator.dismissPriorConversationActivity()
        await coordinator.applyEventForTesting(.userMessage(sessionId: "session", userMessageId: "next", text: "Continue"))
        await coordinator.applyEventForTesting(.messageStart(sessionId: "session", messageId: "new"))
        await coordinator.applyEventForTesting(.toolResult(
            sessionId: "session",
            messageId: "wire-id",
            toolCallId: "tool",
            result: .error(code: "FAILED", message: "Unavailable"),
            durationMs: 1
        ))
        guard case .assistant(let original) = coordinator.turns.first,
              case .assistant(let next) = coordinator.turns.last else { return XCTFail("Missing turns") }
        XCTAssertTrue(next.parts.isEmpty)
        guard case .tool(let call) = original.parts.first else { return XCTFail("Missing original tool") }
        XCTAssertEqual(call.result, .error(code: "FAILED", message: "Unavailable"))
    }

    func testInterruptFlushesDurableTailAndPreventsLateActivityResurrection() async {
        let coordinator = AgentCoordinator()
        coordinator.installPreviewState(
            sessionId: "session",
            model: "m",
            backend: "b",
            title: "Example",
            turns: [],
            citations: [],
            conversations: []
        )
        await coordinator.applyEventForTesting(.messageStart(sessionId: "session", messageId: "old"))
        await coordinator.applyEventForTesting(.toolStart(
            sessionId: "session",
            messageId: "old",
            toolCallId: "search",
            tool: "search_documents",
            args: JSONAny(value: [:]),
            argsSummary: nil
        ))
        await coordinator.applyEventForTesting(.toolResult(
            sessionId: "session",
            messageId: "old",
            toolCallId: "search",
            result: .searchResults(query: "Example", durationMs: 1, candidates: 0, results: []),
            durationMs: 1
        ))
        await coordinator.applyEventForTesting(.textDelta(
            sessionId: "session",
            messageId: "old",
            delta: "Durable answer"
        ))
        await coordinator.dismissPriorConversationActivity()
        guard case .assistant(let old) = coordinator.turns.last else { return XCTFail("Missing assistant") }
        XCTAssertTrue(old.parts.contains(.text("Durable answer")))
        XCTAssertEqual(
            conversationPresentedParts(old.parts, controls: nil, activityDismissed: true),
            [.text("Durable answer")]
        )
        await coordinator.applyEventForTesting(.userMessage(
            sessionId: "session",
            userMessageId: "queued",
            text: "Follow-up"
        ))
        await coordinator.applyEventForTesting(.messageStart(sessionId: "session", messageId: "new"))
        await coordinator.applyEventForTesting(.toolStart(
            sessionId: "session",
            messageId: "old",
            toolCallId: "late",
            tool: "search_documents",
            args: JSONAny(value: [:]),
            argsSummary: nil
        ))
        guard case .assistant(let current) = coordinator.turns.last else { return XCTFail("Missing new assistant") }
        XCTAssertFalse(coordinator.dismissedConversationActivity.messageIds.contains("new"))
        XCTAssertTrue(conversationPresentedParts(
            current.parts,
            controls: nil,
            dismissedToolCallIds: coordinator.dismissedConversationActivity.toolCallIds
        ).isEmpty)
        await coordinator.applyEventForTesting(.toolResult(
            sessionId: "session",
            messageId: "old",
            toolCallId: "late",
            result: .error(code: "FAILED", message: "Request failed"),
            durationMs: 1
        ))
        guard case .assistant(let failed) = coordinator.turns.first,
              case .assistant(let next) = coordinator.turns.last else { return XCTFail("Missing turns") }
        XCTAssertTrue(next.parts.isEmpty, "Late results must not contaminate the next answer")
        XCTAssertEqual(conversationPresentedParts(
            failed.parts,
            controls: nil,
            activityDismissed: true,
            dismissedToolCallIds: coordinator.dismissedConversationActivity.toolCallIds
        ).count, 2)
    }
}
