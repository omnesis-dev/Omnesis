// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

/// The Answer detail's stored agent transcripts: tolerant trace decoding,
/// the tool-part skip rules, attempt titles, and the omitted-activity notes.
/// Old gateways omit traces entirely and read as no transcript at all.
final class PrivacyAgentTraceTests: XCTestCase {
    private func toolUse(id: String = "call_1", tool: String, args: JSONValue? = nil) -> JSONValue {
        var fields: [String: JSONValue] = [
            "kind": .string("tool_use"),
            "toolCallId": .string(id),
            "tool": .string(tool),
        ]
        if let args { fields["args"] = args }
        return .object(fields)
    }

    private func toolResult(id: String = "call_1", result: JSONValue) -> JSONValue {
        .object([
            "kind": .string("tool_result"),
            "toolCallId": .string(id),
            "result": result,
        ])
    }

    private func trace(parts: [JSONValue]) -> PrivacyAgentTrace {
        PrivacyAgentTrace(
            attempt: 1,
            provider: "anthropic",
            model: "claude-preview-large",
            sessionId: "trace_session_1",
            messages: parts.compactMap { part in
                guard case .object = part else { return nil }
                return PrivacyAgentTraceMessage(role: "assistant", parts: [part])
            },
            terminalStopReason: "end_turn",
            createdAt: 1000
        )
    }

    // MARK: - Tool-part extraction

    func testToolPartsRenderThroughTheSharedCard() {
        let args = JSONValue.object(["query": .string("marathon")])
        let result = JSONValue.object([
            "kind": .string("search.results"),
            "query": .string("marathon"),
            "results": .array([]),
        ])
        let trace = trace(parts: [
            toolUse(tool: "search_documents", args: args),
            toolResult(result: result),
        ])
        let calls = agentTraceToolCalls(trace)
        XCTAssertEqual(calls.count, 1)
        XCTAssertEqual(calls[0].tool, "search_documents")
        let paired = JSONValue.object(["tool": .string("search_documents"), "args": args, "result": result])
        XCTAssertEqual(calls[0].record, paired)
        XCTAssertEqual(calls[0].rawPart, paired)
        let content = directCardContent(tool: calls[0].tool, record: calls[0].record)
        XCTAssertEqual(content.label, "Search")
        XCTAssertEqual(content.arg, "marathon")
        XCTAssertTrue(content.showsEmpty)
    }

    func testUseAndResultPairAcrossMessagesInEitherOrder() {
        let raw = PrivacyAgentTrace(
            attempt: 1,
            provider: "anthropic",
            model: "claude-preview-large",
            sessionId: "trace_session_1",
            messages: [
                PrivacyAgentTraceMessage(role: "assistant", parts: [
                    toolResult(id: "call_1", result: .object(["kind": .string("search.results")])),
                ]),
                PrivacyAgentTraceMessage(role: "assistant", parts: [
                    toolUse(id: "call_1", tool: "search_documents"),
                ]),
            ],
            createdAt: 1000
        )
        let calls = agentTraceToolCalls(raw)
        XCTAssertEqual(calls.count, 1)
        XCTAssertEqual(calls[0].tool, "search_documents")
    }

    func testOrphanResultsAreDropped() {
        let trace = trace(parts: [
            toolResult(result: .object(["kind": .string("search.results")])),
        ])
        XCTAssertEqual(agentTraceToolCalls(trace), [])
    }

    func testNonToolPartsAreSkipped() {
        let trace = trace(parts: [
            .object(["kind": .string("text"), "text": .string("Thinking out loud.")]),
            .object(["kind": .string("thinking"), "text": .string("Hmm.")]),
        ])
        XCTAssertEqual(agentTraceToolCalls(trace), [])
    }

    func testSettledCitationPartsRenderNothing() {
        let trace = trace(parts: [
            toolUse(tool: "annotate", args: .object(["documentId": .string("doc_1")])),
            toolResult(result: .object([
                "kind": .string("annotate.recorded"),
                "documentId": .string("doc_1"),
            ])),
            toolUse(id: "call_2", tool: "cite_record"),
            toolResult(id: "call_2", result: .object(["kind": .string("cite_record.recorded")])),
            toolUse(id: "call_3", tool: "annotate_many"),
            toolResult(id: "call_3", result: .object(["kind": .string("annotate_batch.recorded")])),
        ])
        XCTAssertEqual(agentTraceToolCalls(trace), [])
    }

    func testPendingCitationPartsRenderNothing() {
        let trace = trace(parts: [
            toolUse(tool: "annotate", args: .object(["documentId": .string("doc_1")])),
        ])
        XCTAssertEqual(agentTraceToolCalls(trace), [])
    }

    func testMalformedPartsAreSkipped() {
        let raw = PrivacyAgentTrace(
            attempt: 1,
            provider: "anthropic",
            model: "claude-preview-large",
            sessionId: "trace_session_1",
            messages: [
                PrivacyAgentTraceMessage(role: "assistant", parts: [
                    .string("not a part"),
                    .object(["tool": .string("search_documents")]),
                    toolUse(tool: ""),
                    toolUse(tool: "search_documents"),
                    toolResult(id: "orphan", result: .object(["kind": .string("search.results")])),
                ]),
            ],
            createdAt: 1000
        )
        let calls = agentTraceToolCalls(raw)
        XCTAssertEqual(calls.count, 1)
        XCTAssertEqual(calls[0].tool, "search_documents")
    }

    func testPartsOutsideUserAndAssistantMessagesAreSkipped() {
        let raw = PrivacyAgentTrace(
            attempt: 1,
            provider: "anthropic",
            model: "claude-preview-large",
            sessionId: "trace_session_1",
            messages: [
                PrivacyAgentTraceMessage(role: "system", parts: [
                    toolUse(tool: "search_documents"),
                ]),
            ],
            createdAt: 1000
        )
        XCTAssertEqual(agentTraceToolCalls(raw), [])
    }

    // MARK: - Tolerant decoding

    func testTraceWithoutMessagesKeyStillDecodes() throws {
        let trace = try JSONDecoder().decode(
            PrivacyAgentTrace.self,
            from: Data(
                """
                {"attempt":1,"provider":"anthropic","model":"m","sessionId":"s",
                "terminalStopReason":null,"createdAt":1000,"truncated":false,
                "omittedParts":null}
                """.utf8
            )
        )
        XCTAssertEqual(trace.messages, [])
        XCTAssertEqual(agentTraceToolCalls(trace), [])
    }

    func testTraceEntryWithoutIdentityIsSkipped() {
        let raw: [JSONValue] = [
            .object(["provider": .string("anthropic")]),
            .object([
                "attempt": .int(2),
                "provider": .string("anthropic"),
                "model": .string("m"),
                "sessionId": .string("s"),
                "messages": .array([]),
            ]),
        ]
        XCTAssertEqual(raw.compactMap(PrivacyAgentTrace.init(json:)).count, 1)
    }

    func testJunkMessageEntriesAreSkipped() throws {
        let raw = JSONValue.object([
            "attempt": .int(1),
            "provider": .string("anthropic"),
            "model": .string("m"),
            "sessionId": .string("s"),
            "messages": .array([
                .string("junk"),
                .object(["role": .string("assistant")]),
                .object([
                    "role": .string("assistant"),
                    "parts": .array([toolUse(tool: "search_documents")]),
                ]),
            ]),
        ])
        let trace = try XCTUnwrap(PrivacyAgentTrace(json: raw))
        XCTAssertEqual(trace.messages.count, 2)
        XCTAssertEqual(agentTraceToolCalls(trace).count, 1)
    }

    // MARK: - Old gateways

    func testOldGatewayWithoutTraceKeysReadsAsNoTranscript() throws {
        let exchange = try JSONDecoder().decode(
            PrivacyExchangePresentation.self,
            from: Data(
                """
                {"taskId":"task_1","conversationId":"conv_1","workflowId":"wf_1",
                "externalAgent":{"displayName":"Atlas","source":"principal"},
                "workflow":{"name":"Atlas research","purpose":"Compare routes."},
                "question":"When?","status":"released","outcome":"shared",
                "createdAt":1000,"resolvedAt":1100,"sharedAt":1200,
                "sharedAnswer":"Friday.","pendingCandidate":null,
                "reductions":[],"approval":null,"userDecision":null,
                "review":null,"failure":null}
                """.utf8
            )
        )
        XCTAssertEqual(exchange.agentTraces, [])
        XCTAssertEqual(exchange.agentTraceOmittedAttempts, 0)
    }

    func testExchangeWithTracesDecodesAttempts() throws {
        let exchange = try JSONDecoder().decode(
            PrivacyExchangePresentation.self,
            from: Data(
                """
                {"taskId":"task_1","conversationId":"conv_1","workflowId":"wf_1",
                "externalAgent":{"displayName":"Atlas","source":"principal"},
                "workflow":{"name":"Atlas research","purpose":"Compare routes."},
                "question":"When?","status":"released","outcome":"shared",
                "createdAt":1000,"resolvedAt":1100,"sharedAt":1200,
                "sharedAnswer":"Friday.","pendingCandidate":null,
                "reductions":[],"approval":null,"userDecision":null,
                "review":null,"failure":null,
                "agentTraces":[
                {"attempt":1,"provider":"anthropic","model":"m","sessionId":"s",
                "messages":[{"role":"assistant","parts":[]}],
                "terminalStopReason":"end_turn","createdAt":1000,
                "truncated":true,"omittedParts":2},
                {"provider":"incomplete"}],
                "agentTraceOmittedAttempts":1}
                """.utf8
            )
        )
        XCTAssertEqual(exchange.agentTraces.count, 1)
        XCTAssertEqual(exchange.agentTraces[0].attempt, 1)
        XCTAssertEqual(exchange.agentTraceOmittedAttempts, 1)
    }

    // MARK: - Titles and notes

    func testAttemptTitleNamesAttemptProviderModelAndStopReason() {
        let trace = PrivacyAgentTrace(
            attempt: 2,
            provider: "anthropic",
            model: "claude-preview-large",
            sessionId: "s",
            messages: [],
            terminalStopReason: "end_turn",
            createdAt: 1000
        )
        XCTAssertEqual(
            agentTraceAttemptTitle(trace),
            "Attempt 2 · anthropic / claude-preview-large · end_turn"
        )
    }

    func testAttemptTitleWithoutStopReason() {
        let trace = PrivacyAgentTrace(
            attempt: 1,
            provider: "anthropic",
            model: "claude-preview-large",
            sessionId: "s",
            messages: [],
            createdAt: 1000
        )
        XCTAssertEqual(agentTraceAttemptTitle(trace), "Attempt 1 · anthropic / claude-preview-large")
    }

    func testOmittedAttemptsNoteSingularAndPlural() {
        XCTAssertEqual(
            agentTraceOmittedAttemptsNote(1),
            "1 additional stored attempt could not be shown in this bounded view."
        )
        XCTAssertEqual(
            agentTraceOmittedAttemptsNote(3),
            "3 additional stored attempts could not be shown in this bounded view."
        )
    }

    func testTruncatedNoteCountsOmittedParts() {
        let counted = PrivacyAgentTrace(
            attempt: 1,
            provider: "p",
            model: "m",
            sessionId: "s",
            messages: [],
            createdAt: 1000,
            truncated: true,
            omittedParts: 2
        )
        XCTAssertEqual(
            agentTraceTruncatedNote(counted),
            "2 observable transcript parts were omitted from this stored transcript."
        )
        let single = PrivacyAgentTrace(
            attempt: 1,
            provider: "p",
            model: "m",
            sessionId: "s",
            messages: [],
            createdAt: 1000,
            truncated: true,
            omittedParts: 1
        )
        XCTAssertEqual(
            agentTraceTruncatedNote(single),
            "1 observable transcript part was omitted from this stored transcript."
        )
        let uncounted = PrivacyAgentTrace(
            attempt: 1,
            provider: "p",
            model: "m",
            sessionId: "s",
            messages: [],
            createdAt: 1000,
            truncated: true
        )
        XCTAssertEqual(
            agentTraceTruncatedNote(uncounted),
            "This stored transcript is incomplete; some activity could not be shown."
        )
        let complete = PrivacyAgentTrace(
            attempt: 1,
            provider: "p",
            model: "m",
            sessionId: "s",
            messages: [],
            createdAt: 1000
        )
        XCTAssertNil(agentTraceTruncatedNote(complete))
    }
}

/// The trace half of the Answer boundary: the detail screen asks for the open
/// task's transcripts, and a gateway from before the trace boundary decodes
/// to no transcript at all rather than failing.
final class PrivacyAgentTraceClientTests: PrivacyClientTestCase {
    func testListExchangesRequestsAgentTracesForTheOpenTask() async throws {
        let session = MockSession()
        session.responder = { [weak self] request in
            self!.response(
                request,
                body: """
                {"exchanges":[{"taskId":"task-1","conversationId":"conversation-1",
                "workflowId":"workflow-1","externalAgent":{"displayName":"Atlas","source":"principal"},
                "workflow":{"name":"Atlas research","purpose":"Compare routes."},
                "question":"When?","status":"released","outcome":"shared",
                "createdAt":100,"resolvedAt":110,"sharedAt":111,
                "sharedAnswer":"Friday.","pendingCandidate":null,
                "reductions":[],"approval":null,"userDecision":null,
                "review":null,"failure":null,
                "agentTraces":[{"attempt":1,"provider":"anthropic","model":"m","sessionId":"s",
                "messages":[],"terminalStopReason":"end_turn","createdAt":100,
                "truncated":false,"omittedParts":null}],
                "agentTraceOmittedAttempts":0}],
                "previousCursor":null}
                """
            )
        }
        let client = PrivacyClient(baseURL: baseURL, token: "omn_test", session: session)

        let page = try await client.listExchanges(
            conversationId: "conversation-1",
            limit: 50,
            includeAgentTracesTaskId: "task-1"
        )

        XCTAssertEqual(page.exchanges.count, 1)
        XCTAssertEqual(page.exchanges.first?.agentTraces.count, 1)
        XCTAssertEqual(page.exchanges.first?.agentTraces.first?.attempt, 1)
        XCTAssertEqual(
            session.requests.first?.url?.absoluteString,
            "http://gateway.example:7600/admin/privacy/conversations/conversation-1/exchanges?limit=50&includeAgentTracesTaskId=task-1"
        )
    }

    func testListExchangesWithoutTraceKeysReadsAsNoTranscript() async throws {
        let session = MockSession()
        session.responder = { [weak self] request in
            self!.response(
                request,
                body: """
                {"exchanges":[{"taskId":"task-1","conversationId":"conversation-1",
                "workflowId":"workflow-1","externalAgent":{"displayName":"Atlas","source":"principal"},
                "workflow":{"name":"Atlas research","purpose":"Compare routes."},
                "question":"When?","status":"released","outcome":"shared",
                "createdAt":100,"resolvedAt":110,"sharedAt":111,
                "sharedAnswer":"Friday.","pendingCandidate":null,
                "reductions":[],"approval":null,"userDecision":null,
                "review":null,"failure":null}],
                "previousCursor":null}
                """
            )
        }
        let client = PrivacyClient(baseURL: baseURL, token: "omn_test", session: session)

        let page = try await client.listExchanges(conversationId: "conversation-1", limit: 50)

        XCTAssertEqual(page.exchanges.first?.agentTraces, [])
        XCTAssertEqual(page.exchanges.first?.agentTraceOmittedAttempts, 0)
        XCTAssertEqual(
            session.requests.first?.url?.absoluteString,
            "http://gateway.example:7600/admin/privacy/conversations/conversation-1/exchanges?limit=50"
        )
    }
}
