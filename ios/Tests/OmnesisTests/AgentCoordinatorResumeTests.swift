// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

/// End-to-end exercise of the SSE resume/recovery path in
/// `AgentCoordinator`, driving the *real* `AgentClient.events()` byte loop
/// against an in-process routing `URLSession` stub (no live gateway).
///
/// Covers the iOS half of the two reported failure modes:
///   - a live turn that streamed while the client was disconnected is
///     recovered (here via the gateway's `agent.resync` → reconcile path,
///     which reloads the persisted transcript).
///   - the supervisor applies replayed events through the same reducer, so
///     a reconnect that catches up incrementally lands the assistant text.
///
/// The gateway-side wire contract (Last-Event-ID replay, id: emission,
/// resync on buffer gap) is covered by the TypeScript route + service
/// suites; this asserts the client reacts correctly to it.
@available(iOS 17.0, *)
@MainActor
final class AgentCoordinatorResumeTests: XCTestCase {
    override func tearDown() {
        RoutingStubProtocol.reset()
        super.tearDown()
    }

    private func makeClient() -> AgentClient {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [RoutingStubProtocol.self]
        let session = URLSession(configuration: config)
        return AgentClient(
            baseURL: URL(string: "https://stub.local")!,
            token: "test-token",
            session: session
        )
    }

    /// Poll the main-actor coordinator until `predicate` holds or a short
    /// deadline elapses. Returns whether it became true.
    private func waitFor(
        timeout: TimeInterval = 2.0,
        _ predicate: @escaping () -> Bool
    ) async
        -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if predicate() { return true }
            try? await Task.sleep(nanoseconds: 20_000_000) // 20ms
        }
        return predicate()
    }

    /// A `resync` arriving on the live stream reloads the active
    /// conversation's persisted transcript — the recovery for a turn that
    /// completed while the client couldn't be caught up incrementally.
    func testResyncReloadsPersistedTranscript() async {
        RoutingStubProtocol.reset()
        // The live stream immediately tells us to resync.
        RoutingStubProtocol.sseBody = Data(
            "data: {\"type\":\"agent.resync\",\"payload\":{}}\n\n".utf8
        )
        // The reconcile POST /agent/sessions returns the full persisted turn.
        RoutingStubProtocol.jsonBody = Data(#"""
        {
          "sessionId": "s1",
          "model": "m",
          "backend": "b",
          "title": "Q4 expenses",
          "messageCount": 2,
          "messages": [
            {"role":"user","parts":[{"kind":"text","text":"list my Q4 expenses"}]},
            {"role":"assistant","parts":[{"kind":"text","text":"Here they are."}]}
          ]
        }
        """#.utf8)

        let coord = AgentCoordinator()
        coord.attachForTesting(client: makeClient(), sessionId: "s1")
        defer { coord.stopForTesting() }

        let recovered = await waitFor {
            coord.turns.contains { turn in
                guard case .assistant(let assistant) = turn else { return false }
                return assistant.parts.contains { part in
                    if case .text(let text) = part { return text == "Here they are." }
                    return false
                }
            }
        }
        XCTAssertTrue(recovered, "resync should reload the persisted transcript")
        XCTAssertFalse(coord.busy, "reconcile clears the busy flag")
    }

    /// Events delivered on the live stream (the same path a Last-Event-ID
    /// replay uses) flow through the reducer and materialise the assistant
    /// turn — i.e. a resumed/streamed turn actually renders.
    func testStreamedTurnMaterialisesAssistantText() async {
        RoutingStubProtocol.reset()
        RoutingStubProtocol.sseBody = Data([
            "id: 1",
            "data: {\"type\":\"agent.message.start\",\"payload\":{\"sessionId\":\"s1\",\"messageId\":\"m1\"}}",
            "",
            "id: 2",
            "data: {\"type\":\"agent.text.delta\",\"payload\":{\"sessionId\":\"s1\",\"messageId\":\"m1\",\"delta\":\"Hello \"}}",
            "",
            "id: 3",
            "data: {\"type\":\"agent.text.delta\",\"payload\":{\"sessionId\":\"s1\",\"messageId\":\"m1\",\"delta\":\"world\"}}",
            "",
            "id: 4",
            "data: {\"type\":\"agent.message.end\",\"payload\":{\"sessionId\":\"s1\",\"messageId\":\"m1\",\"stopReason\":\"end_turn\"}}",
            "",
            "",
        ].joined(separator: "\n").utf8)

        let coord = AgentCoordinator()
        coord.attachForTesting(client: makeClient(), sessionId: "s1")
        defer { coord.stopForTesting() }

        let landed = await waitFor {
            coord.turns.contains { turn in
                guard case .assistant(let assistant) = turn else { return false }
                return assistant.parts.contains { part in
                    if case .text(let text) = part { return text == "Hello world" }
                    return false
                }
            }
        }
        XCTAssertTrue(landed, "streamed deltas should aggregate into the assistant turn")
        XCTAssertFalse(coord.busy, "message.end clears busy")
    }

    func testSnapshotHandoffAppliesOnlyEventsNewerThanCursor() async {
        let coord = AgentCoordinator()
        let snapshot = CreateSessionResponse(
            sessionId: "s1",
            model: "m",
            backend: "b",
            busy: true,
            messages: [.assistant(parts: [.text("Snapshot ")])],
            replayEvents: [
                .toolResult(
                    sessionId: "s1", messageId: "m1", toolCallId: "plan",
                    result: .planUpdated(items: [AgentPlanItem(
                        id: "p1", label: "Inspect sources", status: .inProgress
                    )]),
                    durationMs: 0
                ),
                .toolStart(
                    sessionId: "s1", messageId: "m1", toolCallId: "batch",
                    tool: "search_many", args: JSONAny(value: [:]), argsSummary: nil
                ),
                .toolChildStart(
                    sessionId: "s1", messageId: "m1", toolCallId: "batch",
                    childIndex: 0, tool: "search_documents", argsSummary: "first branch"
                ),
                .subagentSpawned(
                    sessionId: "s1",
                    subagentId: "s1.sub.generic",
                    specialist: "generic",
                    task: "Inspect an independent branch",
                    parentToolCallId: nil
                ),
            ],
            eventCursor: 12
        )
        await coord.applySnapshotForTesting(snapshot, buffered: [
            AgentStreamItem(id: "12", event: .textDelta(
                sessionId: "s1", messageId: "m1", delta: "duplicate "
            )),
            AgentStreamItem(id: "13", event: .textDelta(
                sessionId: "s1", messageId: "m1", delta: "after"
            )),
        ])

        guard case .assistant(let assistant) = coord.turns.last else {
            return XCTFail("expected resumed assistant turn")
        }
        XCTAssertEqual(assistant.parts.compactMap { part in
            if case .text(let text) = part { return text }
            return nil
        }.joined(), "Snapshot after")
        XCTAssertEqual(coord.planItems.map(\.id), ["p1"])
        XCTAssertTrue(assistant.parts.contains { part in
            guard case .tool(let call) = part else { return false }
            return call.tool == "search_many" && call.children.count == 1
        })
        XCTAssertEqual(assistant.parts.compactMap { part -> AgentSubagentCard? in
            guard case .subagent(let card) = part else { return nil }
            return card
        }.map(\.subagentId), ["s1.sub.generic"])
        XCTAssertFalse(coord.deepResearch, "generic replay must not arm Deep Research")
    }

    func testOverlappingSnapshotFailureDrainsCarriedSameSessionBuffer() async {
        let coord = AgentCoordinator()
        await coord.applySnapshotForTesting(CreateSessionResponse(
            sessionId: "s1",
            model: "m",
            backend: "b",
            busy: true,
            messages: [.assistant(parts: [.text("Snapshot ")])]
        ), buffered: [])
        _ = coord.beginSnapshotHandoffForTesting(targetSessionId: "s1")
        await coord.bufferSnapshotEventForTesting(AgentStreamItem(
            id: "11",
            event: .textDelta(sessionId: "s1", messageId: "m1", delta: "first ")
        ))
        let superseding = coord.beginSnapshotHandoffForTesting(targetSessionId: "s1")
        await coord.bufferSnapshotEventForTesting(AgentStreamItem(
            id: "99",
            event: .textDelta(sessionId: "other", messageId: "m2", delta: "wrong ")
        ))
        await coord.bufferSnapshotEventForTesting(AgentStreamItem(
            id: "12",
            event: .textDelta(sessionId: "s1", messageId: "m1", delta: "second")
        ))

        await coord.failSnapshotHandoffForTesting(superseding, targetSessionId: "s1")

        guard case .assistant(let assistant) = coord.turns.last else {
            return XCTFail("expected resumed assistant turn")
        }
        XCTAssertEqual(assistant.parts.compactMap { part in
            if case .text(let text) = part { return text }
            return nil
        }.joined(), "Snapshot first second")
    }

    func testSnapshotHandoffOverflowRequiresFreshBoundedSnapshot() async {
        let coord = AgentCoordinator()
        let original = coord.beginSnapshotHandoffForTesting(targetSessionId: "s1")
        for id in 1 ... (AgentCoordinator.snapshotHandoffCapacityForTesting + 1) {
            await coord.bufferSnapshotEventForTesting(AgentStreamItem(
                id: String(id),
                event: .textDelta(sessionId: "s1", messageId: "m1", delta: "x")
            ))
        }

        guard let overflow = coord.snapshotHandoffStateForTesting() else {
            return XCTFail("expected overflow recovery handoff")
        }
        XCTAssertNotEqual(overflow.generation, original)
        XCTAssertTrue(overflow.requiresSnapshot)
        XCTAssertLessThanOrEqual(
            overflow.bufferedCount,
            AgentCoordinator.snapshotHandoffCapacityForTesting
        )

        await coord.applySnapshotForTesting(CreateSessionResponse(
            sessionId: "s1",
            model: "m",
            backend: "b",
            busy: true,
            messages: [.assistant(parts: [.text("Recovered")])],
            eventCursor: AgentCoordinator.snapshotHandoffCapacityForTesting + 1
        ), generation: overflow.generation)
        guard case .assistant(let assistant) = coord.turns.last else {
            return XCTFail("expected recovered assistant turn")
        }
        XCTAssertEqual(assistant.parts, [.text("Recovered")])
        XCTAssertNil(coord.snapshotHandoffStateForTesting())
    }

    /// Returning to the foreground re-fetches the conversation list, so a
    /// conversation created or advanced on another device appears without a
    /// relaunch. The agent SSE feed is scoped to the active session's
    /// transcript, so nothing else on the foreground path would surface it —
    /// this refresh is the client-side pickup of cross-device activity.
    func testForegroundRefreshesConversationList() async {
        RoutingStubProtocol.reset()
        RoutingStubProtocol.conversationsBody = Data(#"""
        {"conversations":[
          {"id":"s_remote","title":"Created elsewhere","model":"m","backend":"b","createdAt":"t1","updatedAt":"t1","messageCount":1}
        ],"nextCursor":null}
        """#.utf8)
        let coord = AgentCoordinator()
        coord.attachForTesting(client: makeClient(), sessionId: "s_local")
        defer { coord.stopForTesting() }
        XCTAssertTrue(coord.conversations.isEmpty, "the list starts empty before any refresh")

        coord.onForeground()

        let appeared = await waitFor {
            coord.conversations.contains { $0.sessionId == "s_remote" }
        }
        XCTAssertTrue(
            appeared,
            "onForeground should re-fetch the conversation list so a cross-device conversation appears"
        )
        let reconciled = await waitFor {
            !RoutingStubProtocol.recordedSessionRequestBodies().isEmpty
        }
        XCTAssertTrue(reconciled, "the active visual conversation should reconcile on foreground")
        let body = RoutingStubProtocol.recordedSessionRequestBodies().first
        let json = try? body.flatMap {
            try JSONSerialization.jsonObject(with: $0) as? [String: Any]
        }
        XCTAssertEqual(
            json?["profile"] as? String,
            "interactive",
            "foreground reconcile must switch a Watch voice session back to interactive"
        )
    }

    /// A first-page refresh owns a new server snapshot. If an older page from
    /// the previous snapshot lands afterwards, it must not append rows or
    /// replace the fresh cursor (doing either can skip a page boundary).
    func testConversationRefreshSupersedesInFlightLoadMore() async {
        RoutingStubProtocol.reset()
        RoutingStubProtocol.conversationResponses = [
            ScriptedConversationResponse(
                delay: 0.3,
                status: 200,
                body: Data(#"""
                {"conversations":[
                  {"id":"s_stale_page","title":"Stale page","model":"m","backend":"b","createdAt":"t1","updatedAt":"t1","messageCount":1}
                ],"nextCursor":"stale-next"}
                """#.utf8)
            ),
            ScriptedConversationResponse(
                delay: 0,
                status: 200,
                body: Data(#"""
                {"conversations":[
                  {"id":"s_fresh","title":"Fresh first page","model":"m","backend":"b","createdAt":"t2","updatedAt":"t2","messageCount":1}
                ],"nextCursor":"fresh-next"}
                """#.utf8)
            ),
        ]
        let coord = AgentCoordinator()
        coord.attachForTesting(client: makeClient(), sessionId: "s_live")
        defer { coord.stopForTesting() }
        coord.installPreviewState(
            sessionId: "s_live",
            model: "m",
            backend: "b",
            title: "Live",
            turns: [],
            citations: [],
            conversations: [
                ConversationSummary(
                    sessionId: "s_old_first",
                    title: "Old first page",
                    model: "m",
                    backend: "b",
                    createdAt: "t0",
                    updatedAt: "t0",
                    messageCount: 1
                ),
            ],
            conversationsNextCursor: "old-next"
        )

        let oldPage = Task { await coord.loadMoreConversations() }
        let oldPageStarted = await waitFor {
            RoutingStubProtocol.seenConversationRequests() == 1
        }
        XCTAssertTrue(
            oldPageStarted,
            "the old snapshot page should be in flight"
        )

        await coord.refreshConversations()
        XCTAssertEqual(coord.conversations.map(\.sessionId), ["s_fresh"])
        XCTAssertEqual(coord.conversationsNextCursor, "fresh-next")

        await oldPage.value
        XCTAssertEqual(
            coord.conversations.map(\.sessionId),
            ["s_fresh"],
            "the stale page must not append into the refreshed snapshot"
        )
        XCTAssertEqual(
            coord.conversationsNextCursor,
            "fresh-next",
            "the stale page must not replace the refreshed cursor"
        )
        XCTAssertFalse(coord.conversationsLoadingMore)
    }

    func testConversationLoadMoreStopsANonAdvancingCursorAsPartial() async {
        RoutingStubProtocol.reset()
        RoutingStubProtocol.conversationResponses = [
            ScriptedConversationResponse(
                delay: 0,
                status: 200,
                body: Data(#"""
                {"conversations":[
                  {"id":"s_next","title":"Next page","model":"m","backend":"b","createdAt":"t1","updatedAt":"t1","messageCount":1}
                ],"nextCursor":"same-cursor"}
                """#.utf8)
            ),
        ]
        let coord = AgentCoordinator()
        coord.attachForTesting(client: makeClient(), sessionId: "s_live")
        defer { coord.stopForTesting() }
        coord.installPreviewState(
            sessionId: "s_live",
            model: "m",
            backend: "b",
            title: "Live",
            turns: [],
            citations: [],
            conversations: [],
            conversationsNextCursor: "same-cursor"
        )

        await coord.loadMoreConversations()

        XCTAssertEqual(coord.conversations.map(\.sessionId), ["s_next"])
        XCTAssertNil(
            coord.conversationsNextCursor,
            "a non-advancing cursor must not keep an automatic boundary alive forever"
        )
        XCTAssertTrue(
            coord.conversationsPagingTruncated,
            "a stalled cursor is not proof that every conversation was loaded"
        )
    }

    func testConversationLoadMoreStopsAnAdvancingDuplicateOnlyPageAsPartial() async {
        RoutingStubProtocol.reset()
        RoutingStubProtocol.conversationResponses = [
            ScriptedConversationResponse(
                delay: 0,
                status: 200,
                body: Data(#"""
                {"conversations":[
                  {"id":"s_known","title":"Known","model":"m","backend":"b","createdAt":"t1","updatedAt":"t1","messageCount":1}
                ],"nextCursor":"cursor-2"}
                """#.utf8)
            ),
        ]
        let coord = AgentCoordinator()
        coord.attachForTesting(client: makeClient(), sessionId: "s_live")
        defer { coord.stopForTesting() }
        coord.installPreviewState(
            sessionId: "s_live",
            model: "m",
            backend: "b",
            title: "Live",
            turns: [],
            citations: [],
            conversations: [
                ConversationSummary(
                    sessionId: "s_known",
                    title: "Known",
                    model: "m",
                    backend: "b",
                    createdAt: "t1",
                    updatedAt: "t1",
                    messageCount: 1
                ),
            ],
            conversationsNextCursor: "cursor-1"
        )

        await coord.loadMoreConversations()

        XCTAssertEqual(coord.conversations.map(\.sessionId), ["s_known"])
        XCTAssertNil(coord.conversationsNextCursor)
        XCTAssertTrue(
            coord.conversationsPagingTruncated,
            "an advancing cursor without a new visible row must not auto-drain forever"
        )
    }

    func testConversationRefreshPreservesTypedInitialFailureForRetryUI() async {
        RoutingStubProtocol.reset()
        RoutingStubProtocol.conversationResponses = [
            ScriptedConversationResponse(
                delay: 0,
                status: 500,
                body: Data(#"{"error":"temporary"}"#.utf8)
            ),
        ]
        let coord = AgentCoordinator()
        coord.attachForTesting(client: makeClient(), sessionId: "s_live")
        defer { coord.stopForTesting() }

        await coord.refreshConversations()

        XCTAssertTrue(coord.conversations.isEmpty)
        XCTAssertNotNil(coord.conversationsError)
        XCTAssertFalse(coord.conversationsLoading)
    }

    /// Pairing teardown invalidates requests already issued to the old
    /// gateway. A delayed response must not restore private conversation
    /// titles, cursors, loading flags, or errors after the coordinator clears.
    func testTeardownInvalidatesConversationListResponse() async {
        RoutingStubProtocol.reset()
        RoutingStubProtocol.conversationResponses = [
            ScriptedConversationResponse(
                delay: 0.3,
                status: 200,
                body: Data(#"""
                {"conversations":[
                  {"id":"s_old_gateway","title":"Old gateway conversation",
                   "model":"m","backend":"b","createdAt":"t1",
                   "updatedAt":"t1","messageCount":1}
                ],"nextCursor":"old-gateway-next"}
                """#.utf8)
            ),
        ]
        let coord = AgentCoordinator()
        coord.attachForTesting(client: makeClient(), sessionId: "s_live")
        defer { coord.stopForTesting() }

        let refresh = Task { await coord.refreshConversations() }
        let refreshStarted = await waitFor {
            RoutingStubProtocol.seenConversationRequests() == 1
        }
        XCTAssertTrue(
            refreshStarted,
            "the previous pairing's conversation request should be in flight"
        )

        coord.teardown()
        await refresh.value

        XCTAssertTrue(coord.conversations.isEmpty)
        XCTAssertNil(coord.conversationsNextCursor)
        XCTAssertFalse(coord.conversationsLoading)
        XCTAssertFalse(coord.conversationsLoadingMore)
        XCTAssertNil(coord.conversationsError)
    }

    /// An explicit conversation open (a push deep-open, a list tap) that
    /// lands while `bootstrap()`'s default resume-most-recent is still in
    /// flight must win deterministically: the default resume's slower
    /// response arrives afterwards and is discarded rather than clobbering
    /// the explicitly opened conversation.
    func testExplicitOpenSupersedesInFlightDefaultResume() async {
        RoutingStubProtocol.reset()
        RoutingStubProtocol.conversationsBody = Data(#"""
        {"conversations":[
          {"id":"s_default","title":"Old","model":"m","backend":"b","createdAt":"t1","updatedAt":"t1","messageCount":1}
        ],"nextCursor":null}
        """#.utf8)
        func sessionBody(_ id: String) -> Data {
            Data(#"{"sessionId":"\#(id)","model":"m","backend":"b","messages":[]}"#.utf8)
        }
        // First `/agent/sessions` call is the bootstrap's default resume —
        // held in flight; the second is the explicit open — instant.
        RoutingStubProtocol.sessionResponses = [
            (delay: 0.5, body: sessionBody("s_default")),
            (delay: 0, body: sessionBody("s_explicit")),
        ]
        let coord = AgentCoordinator()
        coord.attachForTesting(client: makeClient(), sessionId: "s_boot")
        defer { coord.stopForTesting() }

        // `retry()` re-runs the bootstrap path (refresh + default resume).
        let boot = Task { await coord.retry() }
        let defaultResumeStarted = await waitFor { RoutingStubProtocol.seenSessionRequests() == 1 }
        XCTAssertTrue(defaultResumeStarted, "the default resume request should be in flight")

        await coord.resumeConversation(id: "s_explicit")
        XCTAssertEqual(coord.sessionId, "s_explicit")

        // Let the default resume's delayed response land — it must be
        // discarded, not applied over the explicit open.
        await boot.value
        XCTAssertEqual(
            coord.sessionId,
            "s_explicit",
            "an in-flight default resume must not clobber an explicit open"
        )
    }

    func testResumeRestoresDurableOutputTruncationMarkerWithoutFreezing() async {
        RoutingStubProtocol.reset()
        RoutingStubProtocol.sessionResponses = [(delay: 0, body: Data(#"""
        {
          "sessionId": "s-truncated",
          "model": "fictional-model",
          "backend": "openai-compatible",
          "messageCount": 2,
          "messages": [
            {"role":"user","parts":[{"kind":"text","text":"Explain the constraints."}]},
            {"role":"assistant","parts":[{"kind":"text","text":"The first constraint is"}]}
          ],
          "lastTurnFailure": {
            "code": "output_truncated",
            "message": "The model reached its output limit before completing this response.",
            "retryable": false,
            "backend": "openai-compatible",
            "model": "fictional-model"
          }
        }
        """#.utf8))]
        let coord = AgentCoordinator()
        coord.attachForTesting(client: makeClient(), sessionId: "s-old")
        defer { coord.stopForTesting() }
        await coord.resumeConversation(id: "s-truncated")

        guard case .assistant(let assistant) = coord.turns.last else {
            return XCTFail("expected resumed assistant turn")
        }
        XCTAssertEqual(
            assistant.failure?.message,
            "The model reached its output limit before completing this response."
        )
        XCTAssertEqual(assistant.failure?.code, "output_truncated")
        XCTAssertEqual(assistant.stopReason, "max_tokens")
        XCTAssertNil(coord.terminalFailure)
        XCTAssertTrue(coord.canComposeMessage)
    }

    /// `pinned` decodes from the wire when present and defaults to false
    /// when an older gateway omits it.
    func testConversationSummaryDecodesPinnedWithBackCompat() throws {
        let decoder = JSONDecoder()
        let pinned = try decoder.decode(
            ConversationSummary.self,
            from: Data(#"{"id":"s1","title":"t","model":"m","backend":"b","createdAt":"x","updatedAt":"y","messageCount":2,"pinned":true}"#
                .utf8)
        )
        XCTAssertTrue(pinned.pinned)
        let legacy = try decoder.decode(
            ConversationSummary.self,
            from: Data(#"{"id":"s1","title":"t","model":"m","backend":"b","createdAt":"x","updatedAt":"y","messageCount":2}"#.utf8)
        )
        XCTAssertFalse(legacy.pinned, "a gateway omitting pinned decodes as unpinned")
    }

    /// Pinned conversations float to the top while the server's order is
    /// preserved within each pin group (stable partition).
    func testSortedPinnedFirstIsStable() {
        func sum(_ id: String, pinned: Bool) -> ConversationSummary {
            ConversationSummary(
                sessionId: id,
                title: id,
                model: "m",
                backend: "b",
                createdAt: "c",
                updatedAt: "u",
                messageCount: 1,
                pinned: pinned
            )
        }
        let input = [
            sum("a", pinned: false),
            sum("b", pinned: true),
            sum("c", pinned: false),
            sum("d", pinned: true),
        ]
        let sorted = AgentCoordinator.sortedPinnedFirst(input).map(\.sessionId)
        XCTAssertEqual(sorted, ["b", "d", "a", "c"])
    }

    /// Toggling a pin re-sorts the in-memory list pinned-first immediately
    /// (optimistic), without waiting for a refetch.
    func testTogglePinReordersOptimistically() async {
        RoutingStubProtocol.reset()
        RoutingStubProtocol.jsonBody = Data(#"""
        {"conversations":[
          {"id":"s_new","title":"Newer","model":"m","backend":"b","createdAt":"t2","updatedAt":"t2","messageCount":1},
          {"id":"s_old","title":"Older","model":"m","backend":"b","createdAt":"t1","updatedAt":"t1","messageCount":1}
        ],"nextCursor":null}
        """#.utf8)
        let coord = AgentCoordinator()
        coord.attachForTesting(client: makeClient(), sessionId: "s_new")
        defer { coord.stopForTesting() }

        await coord.refreshConversations()
        XCTAssertEqual(coord.conversations.map(\.sessionId), ["s_new", "s_old"])

        await coord.togglePin(id: "s_old", pinned: true)
        XCTAssertEqual(coord.conversations.map(\.sessionId), ["s_old", "s_new"])
        XCTAssertEqual(coord.conversations.first?.pinned, true)
        let action = try? XCTUnwrap(RoutingStubProtocol.recordedConversationActions().last)
        XCTAssertEqual(action?.method, "PATCH")
        XCTAssertEqual(action?.path, "/agent/conversations/s_old")
        XCTAssertEqual(action?.body, #"{"pinned":true}"#)
    }

    func testTogglePinUpdatesActiveStateWhenSummaryIsNotLoaded() async {
        RoutingStubProtocol.reset()
        let coord = AgentCoordinator()
        coord.installPreviewState(
            sessionId: "s_active",
            model: "m",
            backend: "b",
            title: "Invented chat",
            turns: [],
            citations: [],
            conversations: []
        )
        coord.attachForTesting(client: makeClient(), sessionId: "s_active")
        defer { coord.stopForTesting() }

        await coord.togglePin(id: "s_active", pinned: true)

        XCTAssertTrue(coord.activeConversationPinned)
        XCTAssertTrue(coord.conversations.isEmpty)
    }

    func testAppliedDefaultSessionAdoptsPinnedStateFromLoadedSummary() async {
        let coord = AgentCoordinator()
        coord.installPreviewState(
            sessionId: nil,
            model: "m",
            backend: "b",
            title: "",
            turns: [],
            citations: [],
            conversations: [
                ConversationSummary(
                    sessionId: "s_pinned",
                    title: "Invented pinned chat",
                    model: "m",
                    backend: "b",
                    createdAt: "c",
                    updatedAt: "u",
                    messageCount: 1,
                    pinned: true
                ),
            ]
        )
        let generation = coord.beginSnapshotHandoffForTesting(targetSessionId: "s_pinned")

        await coord.applySnapshotForTesting(
            CreateSessionResponse(
                sessionId: "s_pinned",
                model: "m",
                backend: "b",
                messages: []
            ),
            generation: generation
        )

        XCTAssertTrue(coord.activeConversationPinned)
    }

    func testStaleConversationRefreshCannotUndoSuccessfulPin() async {
        RoutingStubProtocol.reset()
        RoutingStubProtocol.conversationResponses = [
            ScriptedConversationResponse(
                delay: 0.3,
                status: 200,
                body: Data(
                    #"{"conversations":[{"id":"s_active","title":"Invented chat","model":"m","backend":"b","createdAt":"c","updatedAt":"u","messageCount":1,"pinned":false}],"nextCursor":null}"#
                        .utf8
                )
            ),
        ]
        let coord = AgentCoordinator()
        coord.installPreviewState(
            sessionId: "s_active",
            model: "m",
            backend: "b",
            title: "Invented chat",
            turns: [],
            citations: [],
            conversations: [
                ConversationSummary(
                    sessionId: "s_active",
                    title: "Invented chat",
                    model: "m",
                    backend: "b",
                    createdAt: "c",
                    updatedAt: "u",
                    messageCount: 1
                ),
            ]
        )
        coord.attachForTesting(client: makeClient(), sessionId: "s_active")
        defer { coord.stopForTesting() }

        let refresh = Task { await coord.refreshConversations() }
        let refreshStarted = await waitFor { RoutingStubProtocol.conversationRequestCount == 1 }
        XCTAssertTrue(refreshStarted)
        await coord.togglePin(id: "s_active", pinned: true)
        await refresh.value

        XCTAssertTrue(coord.activeConversationPinned)
        XCTAssertEqual(coord.conversations.first?.pinned, true)
    }

    func testConversationRefreshCannotEraseActionFailure() async {
        RoutingStubProtocol.reset()
        RoutingStubProtocol.conversationResponses = [
            ScriptedConversationResponse(
                delay: 0.3,
                status: 200,
                body: Data(#"{"conversations":[],"nextCursor":null}"#.utf8)
            ),
        ]
        RoutingStubProtocol.conversationActionResponses = [
            ScriptedMessageResponse(
                delay: 0,
                status: 503,
                body: Data(#"{"error":"temporarily unavailable"}"#.utf8)
            ),
        ]
        let coord = AgentCoordinator()
        coord.attachForTesting(client: makeClient(), sessionId: "s_active")
        defer { coord.stopForTesting() }

        let refresh = Task { await coord.refreshConversations() }
        let refreshStarted = await waitFor { RoutingStubProtocol.conversationRequestCount == 1 }
        XCTAssertTrue(refreshStarted)
        await coord.togglePin(id: "s_active", pinned: true)
        await refresh.value

        XCTAssertNotNil(coord.conversationActionError)
        XCTAssertEqual(coord.conversationActionErrorSessionId, "s_active")
    }

    /// Deleting the conversation on screen lands on a fresh chat immediately,
    /// then removes the sidebar row once the server confirms.
    func testDeleteActiveConversationClearsBeforeSuccess() async {
        RoutingStubProtocol.reset()
        let gate = ScriptedResponseGate()
        RoutingStubProtocol.conversationActionResponses = [
            ScriptedMessageResponse(
                delay: 0,
                status: 200,
                body: Data(#"{"ok":true}"#.utf8),
                gate: gate
            ),
        ]
        let coord = AgentCoordinator()
        coord.installPreviewState(
            sessionId: "s_active",
            model: "m",
            backend: "b",
            title: "Quarterly planning notes",
            turns: [.user(id: "u_active", text: "Summarize the agenda.")],
            citations: [],
            conversations: [
                ConversationSummary(
                    sessionId: "s_active",
                    title: "Quarterly planning notes",
                    model: "m",
                    backend: "b",
                    createdAt: "c",
                    updatedAt: "u",
                    messageCount: 1
                ),
            ]
        )
        coord.attachForTesting(client: makeClient(), sessionId: "s_active")
        defer { coord.stopForTesting() }

        let deletion = Task { await coord.deleteConversation(id: "s_active") }
        let requested = await waitFor {
            !RoutingStubProtocol.recordedConversationActions().isEmpty
        }
        XCTAssertTrue(requested)
        XCTAssertNil(coord.sessionId, "the active surface clears without waiting for DELETE")
        XCTAssertTrue(coord.turns.isEmpty)
        XCTAssertEqual(coord.conversations.map(\.sessionId), ["s_active"])

        gate.release()
        await deletion.value
        XCTAssertNil(coord.sessionId)
        XCTAssertTrue(coord.turns.isEmpty)
        XCTAssertTrue(coord.conversations.isEmpty)
        XCTAssertNil(coord.conversationActionError)
        let action = try? XCTUnwrap(RoutingStubProtocol.recordedConversationActions().last)
        XCTAssertEqual(action?.method, "DELETE")
        XCTAssertEqual(action?.path, "/agent/conversations/s_active")
    }

    func testDuplicateDeleteIsSuppressedAndSuccessReconcilesAfterNavigation() async {
        RoutingStubProtocol.reset()
        let gate = ScriptedResponseGate()
        RoutingStubProtocol.conversationActionResponses = [
            ScriptedMessageResponse(
                delay: 0,
                status: 200,
                body: Data(#"{"ok":true}"#.utf8),
                gate: gate
            ),
        ]
        let coord = AgentCoordinator()
        coord.installPreviewState(
            sessionId: "s_active",
            model: "m",
            backend: "b",
            title: "Invented chat",
            turns: [.user(id: "u_active", text: "Summarize the agenda.")],
            citations: [],
            conversations: [
                ConversationSummary(
                    sessionId: "s_active",
                    title: "Invented chat",
                    model: "m",
                    backend: "b",
                    createdAt: "c",
                    updatedAt: "u",
                    messageCount: 1
                ),
            ]
        )
        coord.attachForTesting(client: makeClient(), sessionId: "s_active")
        defer { coord.stopForTesting() }

        let first = Task { await coord.deleteConversation(id: "s_active") }
        let requestStarted = await waitFor {
            !RoutingStubProtocol.recordedConversationActions().isEmpty
        }
        XCTAssertTrue(requestStarted)
        await coord.deleteConversation(id: "s_active")
        coord.newConversation()
        gate.release()
        await first.value

        XCTAssertEqual(RoutingStubProtocol.recordedConversationActions().count, 1)
        XCTAssertTrue(coord.conversations.isEmpty)
        XCTAssertNil(coord.conversationActionError)
    }

    /// A rejected delete keeps the user on the new-chat surface, restores no
    /// stale transcript, and retains the sidebar row so deletion can be retried.
    func testDeleteActiveConversationFailureKeepsFreshSurfaceAndListEntry() async {
        RoutingStubProtocol.reset()
        RoutingStubProtocol.conversationActionResponses = [
            ScriptedMessageResponse(
                delay: 0,
                status: 503,
                body: Data(#"{"error":"temporarily unavailable"}"#.utf8)
            ),
        ]
        let coord = AgentCoordinator()
        coord.installPreviewState(
            sessionId: "s_active",
            model: "m",
            backend: "b",
            title: "Quarterly planning notes",
            turns: [.user(id: "u_active", text: "Summarize the agenda.")],
            citations: [],
            conversations: [
                ConversationSummary(
                    sessionId: "s_active",
                    title: "Quarterly planning notes",
                    model: "m",
                    backend: "b",
                    createdAt: "c",
                    updatedAt: "u",
                    messageCount: 1
                ),
            ]
        )
        coord.attachForTesting(client: makeClient(), sessionId: "s_active")
        defer { coord.stopForTesting() }

        await coord.deleteConversation(id: "s_active")

        XCTAssertNil(coord.sessionId)
        XCTAssertTrue(coord.turns.isEmpty)
        XCTAssertEqual(coord.conversations.map(\.sessionId), ["s_active"])
        XCTAssertNotNil(coord.conversationActionError)
        XCTAssertNil(coord.conversationActionErrorSessionId)
    }

    // MARK: - Snappy navigation (instant new / switch-then-load resume)

    /// Starting a new conversation is purely local: it clears the surface
    /// synchronously and mints NO session over the network (the session is
    /// created lazily on the first send). This is what makes the
    /// new-conversation button snappy.
    func testNewConversationClearsInstantlyWithoutNetwork() {
        RoutingStubProtocol.reset()
        let coord = AgentCoordinator()
        coord.attachForTesting(client: makeClient(), sessionId: "s_live")
        defer { coord.stopForTesting() }
        // Seed a populated transcript so we can prove it clears.
        coord.installPreviewState(
            sessionId: "s_live",
            model: "m",
            backend: "b",
            title: "Prior chat",
            turns: [.user(id: "u1", text: "hi")],
            citations: [],
            conversations: []
        )
        XCTAssertFalse(coord.turns.isEmpty)

        let before = RoutingStubProtocol.seenSessionRequests()
        coord.newConversation()

        XCTAssertNil(coord.sessionId, "a fresh conversation carries no session id")
        XCTAssertTrue(coord.turns.isEmpty, "the transcript clears immediately")
        XCTAssertEqual(coord.title, "")
        XCTAssertFalse(coord.transcriptLoading)
        XCTAssertEqual(
            RoutingStubProtocol.seenSessionRequests(),
            before,
            "new conversation must not hit the network"
        )
        XCTAssertTrue(coord.canComposeMessage, "a fresh conversation is typable immediately")
    }

    /// The first send in a fresh conversation shows its user bubble and the
    /// existing working state before the lazy session mint returns, then posts
    /// the message without disturbing that optimistic presentation.
    func testSendLazilyMintsSessionForFreshConversation() async {
        RoutingStubProtocol.reset()
        RoutingStubProtocol.sessionResponses = [
            (delay: 0.4, body: Data(#"{"sessionId":"s_minted","model":"m","backend":"b","messages":[]}"#.utf8)),
        ]
        // The message POST (`/messages`, not `/agent/sessions`) returns ids.
        RoutingStubProtocol.jsonBody = Data(#"{"messageId":"a1","userMessageId":"u1"}"#.utf8)
        let coord = AgentCoordinator()
        coord.attachForTesting(client: makeClient(), sessionId: "placeholder")
        defer { coord.stopForTesting() }
        coord.newConversation()
        XCTAssertNil(coord.sessionId)

        let sendTask = Task { await coord.send(text: "hello") }
        let minting = await waitFor { RoutingStubProtocol.seenSessionRequests() == 1 }
        XCTAssertTrue(minting, "the lazy session mint should be held in flight")
        XCTAssertNil(coord.sessionId, "the delayed mint has not supplied an identity yet")
        XCTAssertTrue(coord.busy, "the existing working indicator starts before the mint returns")
        XCTAssertTrue(
            coord.workingIndicatorActive,
            "the user-tail state is eligible for the existing three-dot indicator"
        )
        XCTAssertTrue(
            coord.turns.contains { turn in
                if case .user(_, let text) = turn { return text == "hello" }
                return false
            },
            "the first prompt immediately replaces the landing with the transcript"
        )
        XCTAssertEqual(
            RoutingStubProtocol.seenSendRequests(),
            0,
            "the message POST waits for the session identity"
        )

        let sent = await sendTask.value

        XCTAssertTrue(sent)
        XCTAssertEqual(coord.sessionId, "s_minted", "send mints a session when none exists")
        XCTAssertEqual(
            coord.turns.compactMap { turn -> String? in
                if case .user(_, let text) = turn { return text }
                return nil
            },
            ["hello"],
            "the lazy mint preserves exactly one optimistic user bubble"
        )
        XCTAssertEqual(
            RoutingStubProtocol.seenSessionRequests(),
            1,
            "exactly one session is minted"
        )
        XCTAssertEqual(
            RoutingStubProtocol.seenSendRequests(),
            1,
            "the first prompt is posted exactly once after minting"
        )
        let mintBody = RoutingStubProtocol.recordedSessionRequestBodies().first
        let mintJSON = try? mintBody.flatMap {
            try JSONSerialization.jsonObject(with: $0) as? [String: Any]
        }
        XCTAssertEqual(
            mintJSON?["profile"] as? String,
            "interactive",
            "a visual app send must explicitly select the interactive tool profile"
        )
    }

    /// Opening a stored conversation switches the surface to the target
    /// immediately — its id, its known title, and a loading flag — BEFORE the
    /// transcript round-trip lands, then reconciles once the messages arrive.
    func testResumeSwitchesSurfaceImmediatelyThenLoadsTranscript() async {
        RoutingStubProtocol.reset()
        RoutingStubProtocol.conversationsBody = Data(#"""
        {"conversations":[
          {"id":"s_target","title":"Trip planning","model":"m","backend":"b","createdAt":"t1","updatedAt":"t1","messageCount":2}
        ],"nextCursor":null}
        """#.utf8)
        // Hold the transcript fetch in flight so the loading state is observable.
        RoutingStubProtocol.sessionResponses = [
            (delay: 0.4, body: Data(#"""
            {"sessionId":"s_target","model":"m","backend":"b","title":"Trip planning","messageCount":2,
             "messages":[
               {"role":"user","parts":[{"kind":"text","text":"plan my trip"}]},
               {"role":"assistant","parts":[{"kind":"text","text":"Sure!"}]}
             ]}
            """#.utf8)),
        ]
        let coord = AgentCoordinator()
        coord.attachForTesting(client: makeClient(), sessionId: "s_other")
        defer { coord.stopForTesting() }
        await coord.refreshConversations()

        let resume = Task { await coord.resumeConversation(id: "s_target") }
        let switched = await waitFor { coord.sessionId == "s_target" && coord.transcriptLoading }
        XCTAssertTrue(switched, "resume flips to the target with a loading skeleton immediately")
        XCTAssertEqual(coord.title, "Trip planning", "the known title shows during load")
        XCTAssertTrue(coord.turns.isEmpty, "no transcript yet while loading")
        XCTAssertFalse(coord.canComposeMessage, "the composer is disabled until the transcript lands")

        await resume.value
        let resumeBody = RoutingStubProtocol.recordedSessionRequestBodies().last
        let resumeJSON = try? resumeBody.flatMap {
            try JSONSerialization.jsonObject(with: $0) as? [String: Any]
        }
        XCTAssertEqual(
            resumeJSON?["profile"] as? String,
            "interactive",
            "opening a voice-created conversation must restore Timeline annotation tools"
        )
        XCTAssertFalse(coord.transcriptLoading, "loading clears once the transcript lands")
        XCTAssertTrue(
            coord.turns.contains { turn in
                guard case .assistant(let assistant) = turn else { return false }
                return assistant.parts.contains { part in
                    if case .text(let text) = part { return text == "Sure!" }
                    return false
                }
            },
            "the resumed transcript renders after the load"
        )
    }

    /// Re-tapping the conversation already on screen is a no-op — no skeleton
    /// flash, no redundant network request.
    func testResumeIgnoresReTapOnActiveConversation() async {
        RoutingStubProtocol.reset()
        let coord = AgentCoordinator()
        coord.attachForTesting(client: makeClient(), sessionId: "s_active")
        defer { coord.stopForTesting() }

        let before = RoutingStubProtocol.seenSessionRequests()
        await coord.resumeConversation(id: "s_active")

        XCTAssertEqual(
            RoutingStubProtocol.seenSessionRequests(),
            before,
            "re-opening the active conversation makes no request"
        )
        XCTAssertFalse(coord.transcriptLoading)
    }

    /// A resume whose transcript fetch fails clears the loading skeleton and
    /// surfaces a fatal error. The target id stays adopted (the error screen
    /// owns the surface), but the composer stays disabled — sending would post
    /// into a thread that never loaded.
    func testResumeFailureSurfacesFatalErrorAndKeepsComposerDisabled() async {
        RoutingStubProtocol.reset()
        // The default `{}` body is not a valid CreateSessionResponse, so the
        // resume's createSession decode throws — the failure path.
        let coord = AgentCoordinator()
        coord.attachForTesting(client: makeClient(), sessionId: "s_other")
        defer { coord.stopForTesting() }

        await coord.resumeConversation(id: "s_target")

        XCTAssertNotNil(coord.fatalError, "a failed resume surfaces a fatal error")
        XCTAssertFalse(coord.transcriptLoading, "the loading skeleton clears on failure")
        XCTAssertEqual(coord.sessionId, "s_target", "the target id stays adopted")
        XCTAssertFalse(
            coord.canComposeMessage,
            "the composer stays disabled under a fatal error"
        )
    }
}

extension AgentCoordinatorResumeTests {
    /// Return-key submission can race the stop request on iOS. The
    /// coordinator is the final guard: it must not POST or disturb the active
    /// turn until the gateway emits its terminal event. Once that event lands,
    /// the drafted follow-up is accepted normally.
    func testBusyTurnRejectsSendUntilCanceledTerminalThenAcceptsFollowUp() async {
        RoutingStubProtocol.reset()
        RoutingStubProtocol.jsonBody = Data(
            #"{"messageId":"a-follow-up","userMessageId":"u-follow-up"}"#.utf8
        )
        let coord = AgentCoordinator()
        coord.attachForTesting(client: makeClient(), sessionId: "s1")
        defer { coord.stopForTesting() }
        coord.installPreviewState(
            sessionId: "s1",
            model: "fictional-model",
            backend: "replay",
            title: "Canceled turn",
            turns: [
                .assistant(
                    AgentAssistantTurn(id: "a-active", parts: [.text("Partial answer")])
                ),
            ],
            citations: [],
            conversations: [],
            busy: true
        )

        let rejected = await coord.send(text: "drafted follow-up")

        XCTAssertFalse(rejected)
        XCTAssertTrue(coord.busy, "a local busy rejection must not finish the active turn")
        XCTAssertEqual(RoutingStubProtocol.seenSendRequests(), 0)
        XCTAssertEqual(coord.turns.count, 1, "no optimistic bubble is appended while busy")

        await coord.cancelTurn()
        XCTAssertEqual(RoutingStubProtocol.seenCancelRequests(), 1)
        XCTAssertTrue(coord.busy, "cancel acceptance still waits for the terminal event")

        await coord.applyEventForTesting(
            .messageEnd(
                sessionId: "s1",
                messageId: "a-active",
                stopReason: "canceled"
            )
        )
        XCTAssertFalse(coord.busy)

        let accepted = await coord.send(text: "drafted follow-up")

        XCTAssertTrue(accepted)
        XCTAssertEqual(RoutingStubProtocol.seenSendRequests(), 1)
        XCTAssertTrue(coord.busy, "the accepted follow-up owns the new active turn")
    }

    /// A failed cancel request is actionable client feedback, not evidence
    /// that the server-side turn ended. Preserve busy until an SSE terminal
    /// event and expose the underlying error for the scoped retry alert.
    func testCancelFailureIsVisibleWithoutClearingBusy() async {
        RoutingStubProtocol.reset()
        RoutingStubProtocol.cancelResponses = [
            ScriptedMessageResponse(
                delay: 0,
                status: 503,
                body: Data("Gateway temporarily unavailable".utf8)
            ),
        ]
        let coord = AgentCoordinator()
        coord.attachForTesting(client: makeClient(), sessionId: "s1")
        defer { coord.stopForTesting() }
        coord.installPreviewState(
            sessionId: "s1",
            model: "fictional-model",
            backend: "replay",
            title: "Active turn",
            turns: [],
            citations: [],
            conversations: [],
            busy: true
        )

        await coord.cancelTurn()

        XCTAssertEqual(RoutingStubProtocol.seenCancelRequests(), 1)
        XCTAssertTrue(coord.busy, "cancel transport failure cannot finish the turn")
        guard let cancelError = coord.cancelError else {
            return XCTFail("expected the cancel failure to remain available to the UI")
        }
        guard case GatewayClient.Error.serverError(let status, let body) = cancelError else {
            return XCTFail("expected the cancel failure to remain available to the UI")
        }
        XCTAssertEqual(status, 503)
        XCTAssertEqual(body, "Gateway temporarily unavailable")

        coord.dismissCancelError()
        XCTAssertNil(coord.cancelError)
    }

    func testLateCancelFailureDoesNotStainAnotherConversation() async {
        RoutingStubProtocol.reset()
        let responseGate = ScriptedResponseGate()
        defer { responseGate.release() }
        RoutingStubProtocol.cancelResponses = [
            ScriptedMessageResponse(
                delay: 0,
                status: 503,
                body: Data("Gateway temporarily unavailable".utf8),
                gate: responseGate
            ),
        ]
        let coord = AgentCoordinator()
        coord.attachForTesting(client: makeClient(), sessionId: "s1")
        defer { coord.stopForTesting() }
        coord.installPreviewState(
            sessionId: "s1",
            model: "fictional-model",
            backend: "replay",
            title: "Active turn",
            turns: [],
            citations: [],
            conversations: [],
            busy: true
        )

        let cancelTask = Task { await coord.cancelTurn() }
        for _ in 0 ..< 100 where RoutingStubProtocol.seenCancelRequests() == 0 {
            try? await Task.sleep(nanoseconds: 1_000_000)
        }
        XCTAssertEqual(RoutingStubProtocol.seenCancelRequests(), 1)
        coord.newConversation()
        responseGate.release()
        _ = await cancelTask.value

        XCTAssertNil(coord.cancelError)
        XCTAssertNil(coord.sessionId)
    }

    func testLateCancelFailureDoesNotStainFollowUpInSameConversation() async {
        RoutingStubProtocol.reset()
        let responseGate = ScriptedResponseGate()
        defer { responseGate.release() }
        RoutingStubProtocol.cancelResponses = [
            ScriptedMessageResponse(
                delay: 0,
                status: 503,
                body: Data("Gateway temporarily unavailable".utf8),
                gate: responseGate
            ),
        ]
        RoutingStubProtocol.jsonBody = Data(
            #"{"messageId":"a-follow-up","userMessageId":"u-follow-up"}"#.utf8
        )
        let coord = AgentCoordinator()
        coord.attachForTesting(client: makeClient(), sessionId: "s1")
        defer { coord.stopForTesting() }
        coord.installPreviewState(
            sessionId: "s1",
            model: "fictional-model",
            backend: "replay",
            title: "Active turn",
            turns: [.assistant(AgentAssistantTurn(id: "a-old", parts: []))],
            citations: [],
            conversations: [],
            busy: true
        )

        let cancelTask = Task { await coord.cancelTurn() }
        for _ in 0 ..< 100 where RoutingStubProtocol.seenCancelRequests() == 0 {
            try? await Task.sleep(nanoseconds: 1_000_000)
        }
        await coord.applyEventForTesting(
            .messageEnd(sessionId: "s1", messageId: "a-old", stopReason: "canceled")
        )
        let followUpAccepted = await coord.send(text: "short follow-up")
        responseGate.release()
        _ = await cancelTask.value

        XCTAssertTrue(followUpAccepted)
        XCTAssertTrue(coord.busy, "the follow-up remains the authoritative active turn")
        XCTAssertNil(coord.cancelError, "the old turn's cancel failure is stale")
    }

    func testOlderRepeatedStopFailureCannotOverwriteNewerStopSuccess() async {
        RoutingStubProtocol.reset()
        let olderResponseGate = ScriptedResponseGate()
        defer { olderResponseGate.release() }
        RoutingStubProtocol.cancelResponses = [
            ScriptedMessageResponse(
                delay: 0,
                status: 503,
                body: Data("Older stop failed".utf8),
                gate: olderResponseGate
            ),
            ScriptedMessageResponse(delay: 0, status: 200, body: Data(#"{"ok":true}"#.utf8)),
        ]
        let coord = AgentCoordinator()
        coord.attachForTesting(client: makeClient(), sessionId: "s1")
        defer { coord.stopForTesting() }
        coord.installPreviewState(
            sessionId: "s1",
            model: "fictional-model",
            backend: "replay",
            title: "Active turn",
            turns: [],
            citations: [],
            conversations: [],
            busy: true
        )

        let olderStop = Task { await coord.cancelTurn() }
        for _ in 0 ..< 100 where RoutingStubProtocol.seenCancelRequests() == 0 {
            try? await Task.sleep(nanoseconds: 1_000_000)
        }
        await coord.cancelTurn()
        olderResponseGate.release()
        _ = await olderStop.value

        XCTAssertEqual(RoutingStubProtocol.seenCancelRequests(), 2)
        XCTAssertTrue(coord.busy, "cancel acknowledgements wait for the terminal event")
        XCTAssertNil(coord.cancelError, "an older failure cannot replace the newer success")
    }

    func testLateSendSuccessDoesNotMutateNewConversation() async {
        RoutingStubProtocol.reset()
        let responseGate = ScriptedResponseGate()
        defer { responseGate.release() }
        RoutingStubProtocol.sendResponses = [
            ScriptedMessageResponse(
                delay: 0,
                status: 200,
                body: Data(#"{"messageId":"a-old","userMessageId":"u-old"}"#.utf8),
                gate: responseGate
            ),
        ]
        let coord = AgentCoordinator()
        coord.attachForTesting(client: makeClient(), sessionId: "s1")
        defer { coord.stopForTesting() }

        let oldSend = Task { await coord.send(text: "old conversation message") }
        for _ in 0 ..< 100 where RoutingStubProtocol.seenSendRequests() == 0 {
            try? await Task.sleep(nanoseconds: 1_000_000)
        }
        coord.newConversation()
        responseGate.release()
        let acceptedByOldSession = await oldSend.value

        XCTAssertTrue(acceptedByOldSession)
        XCTAssertNil(coord.sessionId)
        XCTAssertTrue(coord.turns.isEmpty)
        XCTAssertFalse(coord.busy)
        XCTAssertEqual(coord.title, "")
    }

    func testLateSendFailureDoesNotClearNewerSameSessionTurn() async {
        RoutingStubProtocol.reset()
        let olderResponseGate = ScriptedResponseGate()
        defer { olderResponseGate.release() }
        RoutingStubProtocol.sendResponses = [
            ScriptedMessageResponse(
                delay: 0,
                status: 503,
                body: Data("Old request failed".utf8),
                gate: olderResponseGate
            ),
            ScriptedMessageResponse(
                delay: 0,
                status: 200,
                body: Data(#"{"messageId":"a-new","userMessageId":"u-new"}"#.utf8)
            ),
        ]
        let coord = AgentCoordinator()
        coord.attachForTesting(client: makeClient(), sessionId: "s1")
        defer { coord.stopForTesting() }

        let oldSend = Task { await coord.send(text: "first message") }
        for _ in 0 ..< 100 where RoutingStubProtocol.seenSendRequests() < 1 {
            try? await Task.sleep(nanoseconds: 1_000_000)
        }
        await coord.applyEventForTesting(
            .messageEnd(sessionId: "s1", messageId: "a-old", stopReason: "end_turn")
        )
        let newerAccepted = await coord.send(text: "newer message")
        olderResponseGate.release()
        let staleResult = await oldSend.value

        XCTAssertTrue(newerAccepted)
        XCTAssertTrue(staleResult, "a superseded completion must not restore stale composer text")
        XCTAssertTrue(coord.busy, "the newer turn remains active")
        XCTAssertNil(coord.lastTurnError)
        XCTAssertTrue(coord.turns.contains { turn in
            if case .user(_, let text) = turn { return text == "newer message" }
            return false
        })
    }

    // MARK: - Transcript pagination

    private func trailRecord(recordKey: String, title: String) -> AgentTrailRecord {
        AgentTrailRecord(
            recordKey: recordKey,
            table: "demo_activity.sessions",
            tableDisplayName: "Sessions",
            title: title,
            keyFields: [AgentTrailRecordKeyField(label: "Duration", value: "42 min")],
            semanticTime: "2026-07-01T08:00:00Z",
            sourceId: "demo-activity:athlete",
            sourceType: "demo-activity",
            boundDocumentId: nil
        )
    }

    private func installPagedTranscript(_ coord: AgentCoordinator, sessionId: String = "s_old") {
        coord.installPreviewState(
            sessionId: sessionId,
            model: "m",
            backend: "b",
            title: "Training notes",
            turns: [.user(id: "u-current", text: "Current question")],
            citations: [],
            conversations: [],
            transcriptNextCursor: "older-1"
        )
    }

    private func olderMessagePage(
        recordTitle: String = "Earlier activity",
        nextCursor: String? = nil
    )
        -> Data {
        let cursorJSON = nextCursor.map { #""\#($0)""# } ?? "null"
        return Data(#"""
        {
          "messages": [
            {"role":"user","parts":[{"kind":"text","text":"Earlier question"}]},
            {"role":"assistant","parts":[{"kind":"text","text":"Earlier answer"}]},
            {"role":"user","parts":[
              {"kind":"tool_result","toolCallId":"tc-old","result":{
                "kind":"cite_record.recorded",
                "recordKey":"demo_activity.sessions/shared",
                "table":"demo_activity.sessions",
                "tableDisplayName":"Sessions",
                "title":"\#(recordTitle)",
                "keyFields":[{"label":"Duration","value":"38 min"}],
                "semanticTime":"2026-06-30T08:00:00Z",
                "sourceId":"demo-activity:athlete",
                "sourceType":"demo-activity",
                "boundDocumentId":null
              }}
            ]}
          ],
          "messagePageInfo":{"hasMore":\#(nextCursor == nil ? "false" : "true"),"limit":25,"nextCursor":\#(cursorJSON)},
          "messageCount":6,
          "messagesAreVisible":true
        }
        """#.utf8)
    }

    /// One request owns the cursor at a time. A successful prepend reports
    /// that the view has an anchor to restore, and a live/newer record citation
    /// wins over an older duplicate that arrives with the page.
    func testOlderMessagesPrependIsExclusiveAndKeepsNewerRecordCitation() async {
        RoutingStubProtocol.reset()
        RoutingStubProtocol.messageResponses = [
            ScriptedMessageResponse(delay: 0.25, status: 200, body: olderMessagePage()),
        ]
        let coord = AgentCoordinator()
        coord.attachForTesting(client: makeClient(), sessionId: "s_old")
        defer { coord.stopForTesting() }
        installPagedTranscript(coord)

        let load = Task { await coord.loadOlderMessages() }
        let requestStarted = await waitFor {
            RoutingStubProtocol.seenMessageRequests() == 1
        }
        XCTAssertTrue(
            requestStarted,
            "the older-page request should be in flight"
        )
        let duplicateApplied = await coord.loadOlderMessages()
        XCTAssertFalse(
            duplicateApplied,
            "a second tap cannot acquire an in-flight cursor"
        )

        let current = trailRecord(
            recordKey: "demo_activity.sessions/shared",
            title: "Current activity"
        )
        await coord.applyEventForTesting(.toolResult(
            sessionId: "s_old",
            messageId: "m-current",
            toolCallId: "tc-current",
            result: .citeRecordRecorded(record: current),
            durationMs: 1
        ))

        let didPrepend = await load.value
        XCTAssertTrue(didPrepend)
        XCTAssertEqual(coord.turns.count, 3)
        XCTAssertEqual(
            coord.turns.compactMap { turn in
                if case .user(_, let text) = turn { return text }
                return nil
            },
            ["Earlier question", "Current question"]
        )
        XCTAssertEqual(coord.recordCitations.map(\.recordKey), ["demo_activity.sessions/shared"])
        XCTAssertEqual(
            coord.recordCitations.first?.title,
            "Current activity",
            "the newer live citation must replace stale metadata from the older page"
        )
        XCTAssertFalse(coord.transcriptPaging.canLoadMore)
        XCTAssertNil(coord.transcriptPaging.paginationError)
    }

    /// A failed next-page request preserves the existing transcript and cursor,
    /// reports no retained-anchor scroll, and remains retryable.
    func testOlderMessagesFailureDoesNotReportPrepend() async {
        RoutingStubProtocol.reset()
        RoutingStubProtocol.messageResponses = [
            ScriptedMessageResponse(
                delay: 0,
                status: 500,
                body: Data(#"{"error":"temporary"}"#.utf8)
            ),
        ]
        let coord = AgentCoordinator()
        coord.attachForTesting(client: makeClient(), sessionId: "s_old")
        defer { coord.stopForTesting() }
        installPagedTranscript(coord)

        let didPrepend = await coord.loadOlderMessages()
        XCTAssertFalse(didPrepend)
        XCTAssertEqual(coord.turns.count, 1)
        XCTAssertEqual(coord.transcriptPaging.nextCursor, "older-1")
        XCTAssertFalse(coord.transcriptPaging.isLoadingMore)
        XCTAssertNotNil(coord.transcriptPaging.paginationError)
    }

    /// Switching conversations invalidates an in-flight older-page response.
    /// The stale request reports no prepend and cannot write turns, citations,
    /// or paging state into the newly selected conversation.
    func testConversationSwitchInvalidatesOlderMessagesResponse() async {
        RoutingStubProtocol.reset()
        RoutingStubProtocol.messageResponses = [
            ScriptedMessageResponse(
                delay: 0.3,
                status: 200,
                body: olderMessagePage(nextCursor: "older-2")
            ),
        ]
        RoutingStubProtocol.sessionResponses = [
            (delay: 0, body: Data(#"""
            {
              "sessionId":"s_new",
              "model":"m",
              "backend":"b",
              "title":"New conversation",
              "messages":[
                {"role":"user","parts":[{"kind":"text","text":"New question"}]}
              ]
            }
            """#.utf8)),
        ]
        let coord = AgentCoordinator()
        coord.attachForTesting(client: makeClient(), sessionId: "s_old")
        defer { coord.stopForTesting() }
        installPagedTranscript(coord)

        let oldLoad = Task { await coord.loadOlderMessages() }
        let requestStarted = await waitFor {
            RoutingStubProtocol.seenMessageRequests() == 1
        }
        XCTAssertTrue(
            requestStarted,
            "the old conversation page should be in flight"
        )
        await coord.resumeConversation(id: "s_new")

        let staleApplied = await oldLoad.value
        XCTAssertFalse(staleApplied)
        XCTAssertEqual(coord.sessionId, "s_new")
        XCTAssertEqual(
            coord.turns.compactMap { turn in
                if case .user(_, let text) = turn { return text }
                return nil
            },
            ["New question"]
        )
        XCTAssertTrue(coord.recordCitations.isEmpty)
        XCTAssertFalse(coord.transcriptPaging.canLoadMore)
        XCTAssertNil(coord.transcriptPaging.paginationError)
    }

    /// Unpairing invalidates an older-page request from the previous gateway.
    /// Its late response must not restore private turns or paging state after
    /// teardown has cleared the coordinator.
    func testTeardownInvalidatesOlderMessagesResponse() async {
        RoutingStubProtocol.reset()
        RoutingStubProtocol.messageResponses = [
            ScriptedMessageResponse(
                delay: 0.3,
                status: 200,
                body: olderMessagePage(nextCursor: "older-2")
            ),
        ]
        let coord = AgentCoordinator()
        coord.attachForTesting(client: makeClient(), sessionId: "s_old")
        defer { coord.stopForTesting() }
        installPagedTranscript(coord)

        let oldLoad = Task { await coord.loadOlderMessages() }
        let requestStarted = await waitFor {
            RoutingStubProtocol.seenMessageRequests() == 1
        }
        XCTAssertTrue(
            requestStarted,
            "the previous pairing's older-page request should be in flight"
        )

        coord.teardown()

        let staleApplied = await oldLoad.value
        XCTAssertFalse(staleApplied)
        XCTAssertNil(coord.sessionId)
        XCTAssertTrue(coord.turns.isEmpty)
        XCTAssertTrue(coord.citations.isEmpty)
        XCTAssertTrue(coord.recordCitations.isEmpty)
        XCTAssertFalse(coord.transcriptPaging.canLoadMore)
        XCTAssertFalse(coord.transcriptPaging.isLoadingMore)
        XCTAssertNil(coord.transcriptPaging.paginationError)
    }
}

extension AgentCoordinatorResumeTests {
    /// A failed lazy mint rolls its immediate optimistic presentation back and
    /// reports rejection so the composer restores the submitted prompt.
    func testSendFailedMintReturnsFalseWithoutStrandedBubble() async {
        RoutingStubProtocol.reset()
        // `{}` fails CreateSessionResponse decode → the lazy mint throws.
        let coord = AgentCoordinator()
        coord.attachForTesting(client: makeClient(), sessionId: "placeholder")
        defer { coord.stopForTesting() }
        coord.newConversation()

        let sent = await coord.send(text: "hello")

        XCTAssertFalse(sent, "a failed mint reports the send as not accepted")
        XCTAssertNil(coord.sessionId, "no session was created")
        XCTAssertTrue(coord.turns.isEmpty, "no stranded optimistic bubble")
        XCTAssertNotNil(coord.lastTurnError)
        XCTAssertFalse(coord.busy)
    }

    /// A lazy mint superseded mid-flight (a new conversation lands before it
    /// returns) abandons the send without restoring stale text into the new
    /// surface or posting into the wrong session.
    func testSupersededLazyMintAbandonsSend() async {
        RoutingStubProtocol.reset()
        // Hold the mint's createSession in flight so a newConversation can
        // supersede it before it returns.
        RoutingStubProtocol.sessionResponses = [
            (delay: 0.3, body: Data(#"{"sessionId":"s_minted","model":"m","backend":"b","messages":[]}"#.utf8)),
        ]
        let coord = AgentCoordinator()
        coord.attachForTesting(client: makeClient(), sessionId: "placeholder")
        defer { coord.stopForTesting() }
        coord.newConversation()

        let sendTask = Task { await coord.send(text: "hello") }
        let minting = await waitFor { RoutingStubProtocol.seenSessionRequests() == 1 }
        XCTAssertTrue(minting, "the mint's createSession should be in flight")
        // Supersede the in-flight mint.
        coord.newConversation()

        let sent = await sendTask.value
        XCTAssertTrue(sent, "navigation supersession must not restore stale composer text")
        XCTAssertNil(coord.sessionId, "the superseding new conversation owns the surface")
        XCTAssertTrue(coord.turns.isEmpty, "no bubble is applied for the abandoned send")
        XCTAssertEqual(RoutingStubProtocol.seenSendRequests(), 0)
    }

    /// Stop during the first session mint is local: there is no server-side
    /// session to cancel yet, so the mint is superseded, the optimistic state
    /// is rolled back, and cancel returns the prompt for immediate restoration.
    func testStopDuringLazyMintRollsBackAndRestoresPrompt() async {
        RoutingStubProtocol.reset()
        RoutingStubProtocol.sessionResponses = [
            (delay: 0.3, body: Data(#"{"sessionId":"s_minted","model":"m","backend":"b","messages":[]}"#.utf8)),
        ]
        let coord = AgentCoordinator()
        coord.attachForTesting(client: makeClient(), sessionId: "placeholder")
        defer { coord.stopForTesting() }
        coord.newConversation()

        let sendTask = Task { await coord.send(text: "hello") }
        let minting = await waitFor {
            RoutingStubProtocol.seenSessionRequests() == 1 && coord.busy
        }
        XCTAssertTrue(minting)

        let restored = await coord.cancelTurn()

        XCTAssertFalse(coord.busy, "local Stop clears the working indicator immediately")
        XCTAssertTrue(coord.turns.isEmpty, "the gateway never accepted the optimistic prompt")
        XCTAssertEqual(coord.title, "")
        XCTAssertEqual(restored, "hello", "Stop restores the prompt without waiting for the mint")
        let sent = await sendTask.value
        XCTAssertTrue(sent, "the retired send must not restore the prompt a second time")
        XCTAssertNil(coord.sessionId, "the canceled mint cannot resurrect a session")
        XCTAssertEqual(RoutingStubProtocol.seenSendRequests(), 0)
        XCTAssertEqual(RoutingStubProtocol.seenCancelRequests(), 0, "there is no session to cancel")
    }

    /// The composer gate: disabled with no client, enabled for a live session
    /// and for a fresh (not-yet-minted) conversation, disabled under a fatal
    /// error.
    func testCanComposeMessageGating() {
        RoutingStubProtocol.reset()
        let coord = AgentCoordinator()
        XCTAssertFalse(coord.canComposeMessage, "no client → cannot compose")

        coord.attachForTesting(client: makeClient(), sessionId: "s1")
        defer { coord.stopForTesting() }
        XCTAssertTrue(coord.canComposeMessage, "client + live session → can compose")

        coord.newConversation()
        XCTAssertTrue(coord.canComposeMessage, "a fresh, not-yet-minted conversation is typable")

        coord.installPreviewState(
            sessionId: "s-exhausted",
            model: "fictional-model",
            backend: "openai-compatible",
            title: "Long conversation",
            turns: [],
            citations: [],
            conversations: [],
            terminalFailure: AgentConversationTerminalFailure(
                code: "context_window_exceeded",
                message:
                "This conversation no longer fits in the selected model's context window. "
                    + "Start a new conversation to continue.",
                retryable: false,
                backend: "openai-compatible",
                model: "fictional-model",
                failedAt: "2026-07-29T12:00:00.000Z"
            )
        )
        XCTAssertFalse(coord.canComposeMessage, "a terminal conversation is read-only")

        coord.newConversation()
        XCTAssertNil(coord.terminalFailure)
        XCTAssertTrue(coord.canComposeMessage, "new conversation clears the terminal state")

        coord.installPreviewFatal(error: URLError(.cannotConnectToHost))
        XCTAssertFalse(coord.canComposeMessage, "a fatal error disables the composer")
    }

    func testContextWindowEndFreezesWithoutAddingTranscriptError() async {
        let coord = AgentCoordinator()
        coord.installPreviewState(
            sessionId: "s-exhausted",
            model: "fictional-model",
            backend: "openai-compatible",
            title: "Long conversation",
            turns: [
                .assistant(
                    AgentAssistantTurn(
                        id: "m1",
                        parts: [.text("Partial answer")]
                    )
                ),
            ],
            citations: [],
            conversations: [],
            busy: true
        )
        let failure = AgentTerminalFailure(
            code: "context_window_exceeded",
            message:
            "This conversation no longer fits in the selected model's context window. "
                + "Start a new conversation to continue.",
            retryable: false,
            backend: "openai-compatible",
            model: "fictional-model"
        )

        await coord.applyEventForTesting(
            .error(
                sessionId: "s-exhausted",
                messageId: "m1",
                code: "context_window_exceeded",
                message: failure.message,
                provider: nil
            )
        )
        XCTAssertNil(coord.terminalFailure, "agent.error is not the durable terminal signal")
        XCTAssertTrue(coord.busy)

        await coord.applyEventForTesting(
            .contextWindowExceeded(
                sessionId: "s-exhausted",
                messageId: "m1",
                stopReason: "error",
                failure: failure,
                context: AgentContextAssessment(
                    inputTokens: 130_000,
                    contextWindowTokens: 128_000,
                    measurement: "provider_reported",
                    limitSource: "provider",
                    requestIteration: 1
                )
            )
        )

        XCTAssertFalse(coord.busy)
        XCTAssertFalse(coord.canComposeMessage)
        XCTAssertEqual(coord.terminalFailure?.context?.inputTokens, 130_000)
        guard case .assistant(let assistant) = coord.turns.last else {
            return XCTFail("expected assistant turn")
        }
        XCTAssertNil(assistant.failure)
    }

    func testOutputTruncationMarksPartialTurnWithoutFreezingComposer() async {
        RoutingStubProtocol.reset()
        let coord = AgentCoordinator()
        coord.attachForTesting(client: makeClient(), sessionId: "s-truncated")
        defer { coord.stopForTesting() }
        coord.installPreviewState(
            sessionId: "s-truncated",
            model: "fictional-model",
            backend: "openai-compatible",
            title: "Long response",
            turns: [
                .assistant(
                    AgentAssistantTurn(
                        id: "m1",
                        parts: [.text("Partial answer")]
                    )
                ),
            ],
            citations: [],
            conversations: [],
            busy: true
        )
        let failure = AgentTerminalFailure(
            code: "output_truncated",
            message: "The model reached its output limit before completing this response.",
            retryable: false,
            backend: "openai-compatible",
            model: "fictional-model"
        )

        await coord.applyEventForTesting(
            .error(
                sessionId: "s-truncated",
                messageId: "m1",
                code: "output_truncated",
                message: failure.message,
                provider: nil
            )
        )
        XCTAssertTrue(coord.busy, "agent.error is not the authoritative terminal signal")

        await coord.applyEventForTesting(
            .outputTruncated(
                sessionId: "s-truncated",
                messageId: "m1",
                stopReason: "max_tokens",
                failure: failure
            )
        )

        XCTAssertFalse(coord.busy)
        XCTAssertNil(coord.terminalFailure)
        XCTAssertTrue(coord.canComposeMessage)
        guard case .assistant(let assistant) = coord.turns.last else {
            return XCTFail("expected assistant turn")
        }
        XCTAssertEqual(assistant.stopReason, "max_tokens")
        XCTAssertEqual(assistant.failure?.message, failure.message)
        XCTAssertEqual(assistant.failure?.code, failure.code)
    }
}
