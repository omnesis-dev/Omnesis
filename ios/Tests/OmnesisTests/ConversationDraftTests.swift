// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

final class ConversationDraftTests: XCTestCase {
    func testDraftSurvivesRecreationAndKeepsIdempotencyIdentity() throws {
        let suite = "draft-test-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let store = ConversationDraftStore(defaults: defaults)
        store.write("Compare this month", key: "gateway:conversation")
        let original = store.read("gateway:conversation")
        let reopened = ConversationDraftStore(defaults: defaults)
        XCTAssertEqual(reopened.read("gateway:conversation"), original)
        reopened.write("Compare this month", key: "gateway:conversation")
        XCTAssertEqual(reopened.read("gateway:conversation")?.clientMessageId, original?.clientMessageId)
        reopened.write("Compare this year", key: "gateway:conversation")
        XCTAssertNotEqual(reopened.read("gateway:conversation")?.clientMessageId, original?.clientMessageId)
        XCTAssertNil(reopened.read("gateway:other"))
    }

    func testEditingAndChoicesPreserveOriginalDraftAcrossRelaunch() throws {
        let suite = "draft-test-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let store = ConversationDraftStore(defaults: defaults)
        store.write("My unsent question", key: "conversation")
        store.setResearch(true, key: "conversation")
        let original = store.prepare(key: "conversation", submission: .init(
            interrupt: false, deepResearch: true, clarificationId: "question-example"
        ))
        store.beginReplacement("My unsent question", key: "conversation")
        XCTAssertNotEqual(store.read("conversation")?.clientMessageId, original?.clientMessageId)
        XCTAssertNil(store.read("conversation")?.submission)
        store.beginReplacement("An edited prompt", key: "conversation")
        XCTAssertFalse(store.research("conversation"))
        store.beginReplacement("A clarification choice", key: "conversation")
        let reopened = ConversationDraftStore(defaults: defaults)
        XCTAssertTrue(reopened.hasBackup("conversation"))
        reopened.restoreBackup("conversation")
        XCTAssertEqual(reopened.read("conversation"), original)
        XCTAssertTrue(reopened.research("conversation"))
        XCTAssertFalse(reopened.hasBackup("conversation"))
    }

    func testFailedResearchReplacementPreservesIntentWhileEditing() throws {
        let suite = "draft-test-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let store = ConversationDraftStore(defaults: defaults)
        store.beginReplacement("Compare totals", key: "conversation", deepResearch: true, answerCurrentQuestion: false)
        store.write("Compare annual totals", key: "conversation")
        XCTAssertTrue(store.research("conversation"))
        XCTAssertEqual(store.read("conversation")?.answerCurrentQuestion, false)
        store.restoreBackup("conversation")
        XCTAssertNil(store.read("conversation")?.answerCurrentQuestion)
    }

    func testRetryPreservesQuestionAndModeAfterControlsRefresh() throws {
        let suite = "draft-test-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let store = ConversationDraftStore(defaults: defaults)
        store.write("This year", key: "conversation")
        let first = store.prepare(key: "conversation", submission: .init(
            interrupt: true, deepResearch: true, clarificationId: "question-example"
        ))
        let retry = store.prepare(key: "conversation", submission: .init(
            interrupt: false, deepResearch: false, clarificationId: nil
        ))
        XCTAssertEqual(first, retry)
        XCTAssertEqual(retry?.submission?.clarificationId, "question-example")
    }

    func testFirstSessionTransfersDraftAndRetryIdentity() throws {
        let suite = "draft-test-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let store = ConversationDraftStore(defaults: defaults)
        store.setResearch(true, key: "gateway:new")
        store.write("A new question", key: "gateway:new")
        let original = store.read("gateway:new")
        store.move(from: "gateway:new", to: "gateway:created")
        XCTAssertEqual(store.read("gateway:created"), original)
        XCTAssertNil(store.read("gateway:new"))
        XCTAssertTrue(store.research("gateway:created"))
        XCTAssertFalse(store.research("gateway:new"))
        store.write("", key: "gateway:created")
        XCTAssertNil(store.read("gateway:created"))
    }

    func testPairingsHaveIndependentPrivateDraftScopes() throws {
        let url = try XCTUnwrap(URL(string: "https://gateway.example"))
        let first = ConversationDraftStore.scope(url: url, token: "fictional-first-token")
        XCTAssertFalse(first.contains("fictional"))
        XCTAssertNotEqual(first, ConversationDraftStore.scope(url: url, token: "fictional-second-token"))
    }

    func testControlsDecodePendingQuestionAndFailedQueue() throws {
        let data = Data(
            #"""
            {"busy":false,
             "pendingClarification":{"id":"q1","question":"Which period?","choices":[{"label":"This month"}]},
             "queuedMessages":[{"id":"m1","text":"Include totals","status":"failed","error":"Try again"}]}
            """#
            .utf8
        )
        let controls = try JSONDecoder().decode(ConversationControls.self, from: data)
        XCTAssertEqual(controls.pendingClarification?.choices.first?.label, "This month")
        XCTAssertEqual(controls.queuedMessages.first?.error, "Try again")
    }
}

@available(iOS 17.0, *)
@MainActor
final class ConversationControlsCompatibilityTests: XCTestCase {
    override func tearDown() {
        ConversationControlsStub.responses = [:]
        ConversationControlsStub.requests = []
        super.tearDown()
    }

    private func coordinator() -> AgentCoordinator {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ConversationControlsStub.self]
        let coordinator = AgentCoordinator()
        coordinator.attachForTesting(
            client: AgentClient(
                baseURL: URL(string: "https://conversation.example")!,
                token: UUID().uuidString,
                session: URLSession(configuration: configuration)
            ), sessionId: "conversation-example"
        )
        coordinator.stopForTesting()
        return coordinator
    }

    func testOlderGatewayUsesExistingSendPathAndKeepsDraftOnFailure() async {
        let coordinator = coordinator()
        ConversationControlsStub.responses["controls"] = (404, "{}")
        ConversationControlsStub.responses["messages"] = (503, "Unavailable")
        await coordinator.refreshConversationControls()
        XCTAssertFalse(coordinator.conversationControlsSupported)
        let sent = await coordinator.submitDraft(text: "Compare the totals")
        XCTAssertFalse(sent)
        XCTAssertEqual(coordinator.draft(for: coordinator.composerDraftKey), "Compare the totals")
        XCTAssertTrue(ConversationControlsStub.requests.contains { $0.url?.lastPathComponent == "messages" })
        XCTAssertFalse(ConversationControlsStub.requests.contains { $0.url?.lastPathComponent == "submissions" })
        coordinator.saveDraft("", for: coordinator.composerDraftKey)
    }

    func testLegacyRetryKeepsOriginalResearchRequest() async throws {
        let coordinator = coordinator()
        ConversationControlsStub.responses["messages"] = (503, "Unavailable")
        _ = await coordinator.submitDraft(text: "Compare totals", deepResearch: true)
        _ = await coordinator.submitDraft(text: "Compare totals", deepResearch: false)
        let bodies = try ConversationControlsStub.requests
            .filter { $0.url?.lastPathComponent == "messages" }
            .map { try XCTUnwrap(try JSONSerialization.jsonObject(with: $0.httpBody ?? Data()) as? [String: Any]) }
        XCTAssertEqual(bodies.count, 2)
        XCTAssertEqual(bodies.last?["deepResearch"] as? Bool, true)
        coordinator.saveDraft("", for: coordinator.composerDraftKey)
    }

    func testFailedReplacementDoesNotAnswerUnrelatedQuestion() async throws {
        let coordinator = coordinator()
        ConversationControlsStub.responses["controls"] = (
            200,
            #"{"busy":false,"pendingClarification":{"id":"other","question":"Which?","choices":[]},"queuedMessages":[]}"#
        )
        ConversationControlsStub.responses["submissions"] = (503, "Unavailable")
        await coordinator.refreshConversationControls()
        coordinator.replaceDraft("Compare totals", for: coordinator.composerDraftKey, deepResearch: true, answerCurrentQuestion: false)
        coordinator.saveDraft("Compare annual totals", for: coordinator.composerDraftKey)
        _ = await coordinator.submitDraft(text: "Compare annual totals", deepResearch: true)
        let request = try XCTUnwrap(ConversationControlsStub.requests.first { $0.url?.lastPathComponent == "submissions" })
        let body = try XCTUnwrap(try JSONSerialization.jsonObject(with: request.httpBody ?? Data()) as? [String: Any])
        XCTAssertNil(body["clarificationId"])
        XCTAssertEqual(body["deepResearch"] as? Bool, true)
        coordinator.cancelDraftReplacement(for: coordinator.composerDraftKey)
        coordinator.saveDraft("", for: coordinator.composerDraftKey)
    }

    func testNewGatewayKeepsRetryIdentityAfterAmbiguousFailure() async throws {
        let coordinator = coordinator()
        ConversationControlsStub.responses["controls"] = (200, #"{"busy":true,"queuedMessages":[],"futureField":42}"#)
        ConversationControlsStub.responses["submissions"] = (503, "Unavailable")
        await coordinator.refreshConversationControls()
        XCTAssertTrue(coordinator.conversationControlsSupported)
        _ = await coordinator.submitDraft(text: "Include the totals")
        _ = await coordinator.submitDraft(text: "Include the totals")
        let bodies = try ConversationControlsStub.requests
            .filter { $0.url?.lastPathComponent == "submissions" }
            .map { try XCTUnwrap(try JSONSerialization.jsonObject(with: $0.httpBody ?? Data()) as? [String: Any]) }
        XCTAssertEqual(bodies.count, 2)
        XCTAssertEqual(bodies.first?["clientMessageId"] as? String, bodies.last?["clientMessageId"] as? String)
        XCTAssertEqual(coordinator.draft(for: coordinator.composerDraftKey), "Include the totals")
        coordinator.saveDraft("", for: coordinator.composerDraftKey)
    }

    func testDefiniteConflictAllowsFreshIntentWithUnchangedText() async throws {
        let coordinator = coordinator()
        ConversationControlsStub.responses["controls"] = (200, #"{"busy":false,"queuedMessages":[]}"#)
        ConversationControlsStub.responses["submissions"] = (409, "Question already answered")
        await coordinator.refreshConversationControls()
        _ = await coordinator.submitDraft(text: "This year")
        _ = await coordinator.submitDraft(text: "This year")
        let bodies = try ConversationControlsStub.requests
            .filter { $0.url?.lastPathComponent == "submissions" }
            .map { try XCTUnwrap(try JSONSerialization.jsonObject(with: $0.httpBody ?? Data()) as? [String: Any]) }
        XCTAssertEqual(bodies.count, 2)
        XCTAssertNotEqual(bodies.first?["clientMessageId"] as? String, bodies.last?["clientMessageId"] as? String)
        XCTAssertEqual(coordinator.draft(for: coordinator.composerDraftKey), "This year")
        coordinator.saveDraft("", for: coordinator.composerDraftKey)
    }

    func testGatewayDowngradeClearsPreviouslyAdvertisedControls() async {
        let coordinator = coordinator()
        ConversationControlsStub.responses["controls"] = (200, #"{"busy":false,"queuedMessages":[]}"#)
        await coordinator.refreshConversationControls()
        XCTAssertTrue(coordinator.conversationControlsSupported)
        ConversationControlsStub.responses["controls"] = (404, "{}")
        await coordinator.refreshConversationControls()
        XCTAssertFalse(coordinator.conversationControlsSupported)
        XCTAssertNil(coordinator.conversationControls)
    }

    func testForwardCompatibleUnknownQueueStatusStillDecodes() throws {
        let data = Data(
            #"{"busy":false,"queuedMessages":[{"id":"m1","text":"A follow-up","status":"awaiting_review","future":true}],"future":{}}"#
                .utf8
        )
        let controls = try JSONDecoder().decode(ConversationControls.self, from: data)
        XCTAssertNil(controls.pendingClarification)
        XCTAssertEqual(controls.queuedMessages.first?.status, "awaiting_review")
    }
}

private final class ConversationControlsStub: URLProtocol {
    nonisolated(unsafe) static var responses: [String: (Int, String)] = [:]
    nonisolated(unsafe) static var requests: [URLRequest] = []
    // URLProtocol requires a class override.
    // swiftlint:disable:next static_over_final_class
    override class func canInit(with request: URLRequest) -> Bool {
        true
    }

    // URLProtocol requires a class override.
    // swiftlint:disable:next static_over_final_class
    override class func canonicalRequest(for request: URLRequest) -> URLRequest {
        request
    }

    override func startLoading() {
        var captured = request
        if captured.httpBody == nil, let stream = captured.httpBodyStream {
            stream.open()
            defer { stream.close() }
            var data = Data()
            var buffer = [UInt8](repeating: 0, count: 1024)
            while stream.hasBytesAvailable {
                let count = stream.read(&buffer, maxLength: buffer.count)
                if count <= 0 { break }
                data.append(buffer, count: count)
            }
            captured.httpBody = data
        }
        Self.requests.append(captured)
        let response = Self.responses[request.url!.lastPathComponent] ?? (200, "{}")
        client?.urlProtocol(
            self,
            didReceive: HTTPURLResponse(
                url: request.url!,
                statusCode: response.0,
                httpVersion: nil,
                headerFields: ["Content-Type": "application/json"]
            )!,
            cacheStoragePolicy: .notAllowed
        )
        client?.urlProtocol(self, didLoad: Data(response.1.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}
