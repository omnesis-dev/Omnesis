// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

@MainActor
final class RealtimeConversationHandoffTests: XCTestCase {
    override func tearDown() {
        RoutingStubProtocol.reset()
        super.tearDown()
    }

    private func coordinator() -> AgentCoordinator {
        RoutingStubProtocol.reset()
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [RoutingStubProtocol.self]
        let client = AgentClient(
            baseURL: URL(string: "https://gateway.example.com")!,
            token: "test-token",
            session: URLSession(configuration: configuration)
        )
        let coordinator = AgentCoordinator()
        coordinator.attachForTesting(client: client, sessionId: "conversation")
        return coordinator
    }

    private func snapshot(messages: [ChatMessage], id: String = "conversation") throws -> Data {
        let wireMessages = try JSONSerialization.jsonObject(with: JSONEncoder().encode(messages))
        return try JSONSerialization.data(withJSONObject: [
            "sessionId": id, "model": "test-model", "backend": "test-backend", "title": "Workshop planning",
            "messages": wireMessages, "messageCount": messages.count, "eventCursor": 100,
            "futureField": "ignored",
        ])
    }

    private func waitForSessionRequest() async throws {
        for _ in 0 ..< 100 {
            if RoutingStubProtocol.sessionRequestCount > 0 { return }
            try await Task.sleep(for: .milliseconds(20))
        }
        XCTFail("The scripted snapshot request never started")
        throw URLError(.timedOut)
    }

    func testRepeatedTextVoiceTextModesKeepOneConversationAndItsCitations() async throws {
        let coordinator = coordinator()
        defer { coordinator.stopForTesting() }
        let draftKey = coordinator.composerDraftKey
        defer {
            coordinator.saveDraft("", for: draftKey)
            coordinator.saveDraftResearch(false, for: draftKey)
        }
        coordinator.updateComposerDraft("An unsent follow-up", for: draftKey)
        coordinator.saveDraftResearch(true, for: draftKey)
        let ref = AgentDocRef(documentId: "fictional-doc", sourceType: "notes", sourceId: "fictional-notes", title: "Workshop")
        let record = AgentTrailRecord(
            recordKey: "fictional-row",
            table: "events",
            tableDisplayName: "Events",
            title: "Workshop",
            keyFields: [],
            semanticTime: "2026-04-12T10:00:00Z",
            sourceId: "fictional-notes",
            sourceType: "notes",
            boundDocumentId: nil
        )
        let messages: [ChatMessage] = [
            .user(parts: [.text("Find the workshop notes.")]),
            .assistant(parts: [
                .toolUse(toolCallId: "cite-doc", tool: "annotate", args: JSONAny(value: ["documentId": ref.documentId])),
                .toolUse(toolCallId: "cite-row", tool: "cite_record", args: JSONAny(value: ["recordKey": record.recordKey])),
            ]),
            .user(parts: [
                .toolResult(toolCallId: "cite-doc", result: .annotateRecorded(
                    documentId: ref.documentId,
                    ref: ref,
                    quote: "Bring the checklist.",
                    note: "Preparation",
                    quoteAuthor: nil,
                    quoteIsSelf: false
                )),
                .toolResult(toolCallId: "cite-row", result: .citeRecordRecorded(record: record)),
            ]),
            .assistant(parts: [.text("The workshop starts at ten.")]),
        ]
        RoutingStubProtocol.jsonBody = try snapshot(messages: messages)
        var initialTurns: [AgentTurn]?
        for _ in 0 ..< 3 {
            try await RealtimeConversationHandoff.attach(id: "conversation", to: coordinator)
            XCTAssertEqual(coordinator.sessionId, "conversation")
            if let initialTurns { XCTAssertEqual(coordinator.turns, initialTurns) } else { initialTurns = coordinator.turns }
            XCTAssertEqual(coordinator.trailAnnotations, AgentTurnBuilder.trailAnnotations(from: messages))
            XCTAssertEqual(coordinator.recordCitations, [record])
            XCTAssertEqual(coordinator.trailAnnotations.byDoc[ref.documentId]?.quotes.count, 1)
        }
        XCTAssertEqual(RoutingStubProtocol.sessionRequestCount, 3)
        XCTAssertEqual(coordinator.composerDraft, "An unsent follow-up")
        XCTAssertEqual(coordinator.draft(for: draftKey), "An unsent follow-up")
        XCTAssertTrue(coordinator.draftResearch(for: draftKey))
        XCTAssertEqual(RoutingStubProtocol.sendRequestCount, 0, "Switching modes must never resend a user message")
        for body in RoutingStubProtocol.sessionRequestBodies {
            let request = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
            XCTAssertEqual(request["resumeFromId"] as? String, "conversation")
        }
    }

    func testVoiceFirstConversationAttachesToGatewayCreatedIdAndReturnsToSameTextHistory() async throws {
        let coordinator = coordinator()
        defer { coordinator.stopForTesting() }
        coordinator.installPreviewState(
            sessionId: nil,
            model: "test",
            backend: "test",
            title: "",
            turns: [],
            citations: [],
            conversations: []
        )
        let freshDraftKey = coordinator.composerDraftKey
        defer {
            for key in [freshDraftKey, coordinator.composerDraftKey] {
                coordinator.saveDraft("", for: key)
                coordinator.saveDraftResearch(false, for: key)
            }
        }
        coordinator.updateComposerDraft("A dictated draft, not yet sent", for: freshDraftKey)
        coordinator.saveDraftResearch(true, for: freshDraftKey)
        let spoken: [ChatMessage] = [
            .user(parts: [.text("Hello from voice.")]),
            .assistant(parts: [.text("Hello there.")]),
        ]
        RoutingStubProtocol.jsonBody = try snapshot(messages: spoken, id: "voice-first")
        try await RealtimeConversationHandoff.attach(id: "voice-first", to: coordinator)
        XCTAssertEqual(coordinator.sessionId, "voice-first")
        XCTAssertEqual(coordinator.composerDraft, "A dictated draft, not yet sent")
        XCTAssertEqual(coordinator.draft(for: coordinator.composerDraftKey), "A dictated draft, not yet sent")
        XCTAssertTrue(coordinator.draftResearch(for: coordinator.composerDraftKey))
        XCTAssertEqual(coordinator.draft(for: freshDraftKey), "")
        let voiceTurns = coordinator.turns
        await coordinator.resumeConversation(id: "voice-first")
        XCTAssertEqual(coordinator.turns, voiceTurns)
        XCTAssertEqual(RoutingStubProtocol.sessionRequestCount, 1, "Returning to text reuses the same live coordinator")
        try await RealtimeConversationHandoff.attach(id: "voice-first", to: coordinator)
        XCTAssertEqual(coordinator.turns, voiceTurns)
        XCTAssertEqual(coordinator.sessionId, "voice-first")
        XCTAssertEqual(RoutingStubProtocol.sendRequestCount, 0)
    }

    func testEndingVoiceDuringReadOnlyHandoffDoesNotPoisonTextWithCancellation() async throws {
        let coordinator = coordinator()
        defer { coordinator.stopForTesting() }
        RoutingStubProtocol.sessionResponses = try [(delay: 0.1, body: snapshot(messages: []))]
        let attachment = Task { try await RealtimeConversationHandoff.attach(id: "conversation", to: coordinator) }
        try await waitForSessionRequest()
        attachment.cancel()
        do {
            try await attachment.value
            XCTFail("A cancelled caller must not proceed to microphone capture")
        } catch is CancellationError {}
        XCTAssertEqual(coordinator.sessionId, "conversation")
        XCTAssertNil(coordinator.fatalError)
        XCTAssertFalse(coordinator.transcriptLoading)
    }

    func testVoiceAttachmentUsesCanonicalQueuedSubmissionReceiptWithoutDuplicatingText() async throws {
        let coordinator = coordinator()
        defer { coordinator.stopForTesting() }
        RoutingStubProtocol.jsonBody = try snapshot(messages: [])
        try await RealtimeConversationHandoff.attach(id: "conversation", to: coordinator)
        let controls = try JSONDecoder().decode(ConversationControls.self, from: Data(#"""
        {"busy":true,"capabilities":{"queueSendNow":true},"queuedMessages":[
          {"id":"queued-receipt","text":"Include the totals","status":"queued"}]}
        """#.utf8))
        coordinator.installPreviewConversationControls(controls)
        let accepted = AgentEvent.userMessage(
            sessionId: "conversation",
            userMessageId: "canonical-user",
            text: "Include the totals",
            submissionIds: ["queued-receipt"]
        )
        await coordinator.applyEventForTesting(accepted)
        await coordinator.applyEventForTesting(accepted)
        XCTAssertTrue(coordinator.presentedConversationControls?.queued.isEmpty == true)
        XCTAssertEqual(coordinator.turns.filter {
            if case .user = $0 { return true }
            return false
        }.count, 1)
        XCTAssertEqual(RoutingStubProtocol.sendRequestCount, 0)
    }

    func testSelectingAnotherTextThreadSupersedesPendingVoiceHandoff() async throws {
        let coordinator = coordinator()
        defer { coordinator.stopForTesting() }
        RoutingStubProtocol.sessionResponses = try [
            (delay: 0.1, body: snapshot(messages: [], id: "voice-thread")),
            (delay: 0, body: snapshot(messages: [], id: "text-thread")),
        ]
        let attachment = Task { try await RealtimeConversationHandoff.attach(id: "voice-thread", to: coordinator) }
        try await waitForSessionRequest()
        await coordinator.resumeConversation(id: "text-thread")
        do {
            try await attachment.value
            XCTFail("A superseded voice presentation must not capture into the newly selected thread")
        } catch let error as URLError { XCTAssertEqual(error.code, .cancelled) }
        XCTAssertEqual(coordinator.sessionId, "text-thread")
        XCTAssertNil(coordinator.fatalError)
    }
}
