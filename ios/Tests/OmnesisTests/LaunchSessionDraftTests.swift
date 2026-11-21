// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

/// What a person types into the blank Ask screen while the app is still
/// choosing its launch session. The session request is held open, the words
/// are typed while it is, and only then does the session arrive, which is the
/// ordering a quick typist on a cold launch produces.
@available(iOS 17.0, *)
@MainActor
final class LaunchSessionDraftTests: XCTestCase {
    private var coordinator: AgentCoordinator!
    private var blankKey = ""

    override func setUp() {
        super.setUp()
        LaunchSessionStub.reset()
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [LaunchSessionStub.self]
        coordinator = AgentCoordinator()
        coordinator.attachForTesting(
            client: AgentClient(
                baseURL: URL(string: "https://launch.example")!,
                token: UUID().uuidString,
                session: URLSession(configuration: configuration)
            ),
            sessionId: "previous-example"
        )
        coordinator.stopForTesting()
        coordinator.newConversation()
        blankKey = coordinator.composerDraftKey
    }

    override func tearDown() {
        for key in [blankKey, sessionKey("launch-example"), sessionKey("stored-example"), sessionKey("other-example")] {
            coordinator.saveDraft("", for: key)
            coordinator.saveDraftResearch(false, for: key)
        }
        LaunchSessionStub.reset()
        coordinator = nil
        super.tearDown()
    }

    private func sessionKey(_ id: String) -> String {
        String(blankKey.dropLast("new".count)) + id
    }

    /// Types into the composer the way `AgentView` does, filing the words
    /// under the draft key the view loaded.
    private func type(_ text: String, into key: String) {
        coordinator.updateComposerDraft(text, for: key)
    }

    func testLaunchSessionKeepsWordsTypedBeforeItArrived() async {
        LaunchSessionStub.responses["sessions"] = (200, #"{"sessionId":"launch-example","model":"m","backend":"b"}"#)
        LaunchSessionStub.beforeResponse = { request in
            if request.url?.lastPathComponent == "sessions" {
                self.type("Where was I", into: self.blankKey)
                self.coordinator.saveDraftResearch(true, for: self.blankKey)
            }
        }
        let identity = coordinator.composerIdentity

        await coordinator.retry()

        XCTAssertEqual(coordinator.sessionId, "launch-example")
        XCTAssertEqual(coordinator.composerDraftKey, sessionKey("launch-example"))
        XCTAssertEqual(coordinator.draft(for: coordinator.composerDraftKey), "Where was I")
        XCTAssertTrue(coordinator.draftResearch(for: coordinator.composerDraftKey))
        XCTAssertEqual(coordinator.draft(for: blankKey), "", "the words moved with the conversation")
        XCTAssertEqual(coordinator.composerDraft, "Where was I")
        XCTAssertEqual(coordinator.composerIdentity, identity, "the field, and its keyboard focus, were kept")

        // A keystroke the view still files under the blank key lands in the
        // conversation it became.
        type("Where was I on", into: blankKey)
        XCTAssertEqual(coordinator.draft(for: coordinator.composerDraftKey), "Where was I on")
        XCTAssertEqual(coordinator.draft(for: blankKey), "")
    }

    func testDraftsStillBelongToTheirConversationsAfterTheLaunchSession() async {
        LaunchSessionStub.responses["sessions"] = (200, #"{"sessionId":"launch-example","model":"m","backend":"b"}"#)
        LaunchSessionStub.beforeResponse = { request in
            if request.url?.lastPathComponent == "sessions" { self.type("Where was I", into: self.blankKey) }
        }
        await coordinator.retry()
        let adopted = coordinator.composerDraftKey
        let identity = coordinator.composerIdentity
        LaunchSessionStub.beforeResponse = nil

        coordinator.newConversation()
        XCTAssertNotEqual(coordinator.composerIdentity, identity, "a new conversation gets a fresh field")
        XCTAssertEqual(coordinator.composerDraft, "")
        XCTAssertEqual(coordinator.draft(for: blankKey), "")
        type("Where was I", into: adopted)
        XCTAssertEqual(coordinator.draft(for: blankKey), "", "a stale edit for the launch conversation stays out of this one")
        type("Something else", into: blankKey)

        coordinator.saveDraft("An unsent follow-up", for: sessionKey("other-example"))
        LaunchSessionStub.responses["sessions"] = (200, #"{"sessionId":"other-example","model":"m","backend":"b"}"#)
        let blankIdentity = coordinator.composerIdentity
        await coordinator.resumeConversation(id: "other-example")
        XCTAssertNotEqual(coordinator.composerIdentity, blankIdentity, "opening a stored conversation swaps the field")
        XCTAssertEqual(coordinator.draft(for: coordinator.composerDraftKey), "An unsent follow-up")
        XCTAssertEqual(coordinator.draft(for: blankKey), "Something else")
        XCTAssertEqual(coordinator.draft(for: adopted), "Where was I")
    }

    func testTypingDuringTheLaunchResumeKeepsTheNewConversation() async {
        LaunchSessionStub.responses["conversations"] = (200, Self.storedConversationList)
        LaunchSessionStub.responses["sessions"] = (200, #"{"sessionId":"stored-example","model":"m","backend":"b"}"#)
        coordinator.saveDraft("The stored conversation's own draft", for: sessionKey("stored-example"))
        LaunchSessionStub.beforeResponse = { request in
            if request.url?.lastPathComponent == "sessions" { self.type("Where was I", into: self.blankKey) }
        }
        let identity = coordinator.composerIdentity

        await coordinator.retry()

        XCTAssertNil(coordinator.sessionId, "the conversation being written in stays on screen")
        XCTAssertEqual(coordinator.composerDraft, "Where was I")
        XCTAssertEqual(coordinator.draft(for: blankKey), "Where was I")
        XCTAssertEqual(coordinator.composerIdentity, identity)
        XCTAssertEqual(
            coordinator.draft(for: sessionKey("stored-example")),
            "The stored conversation's own draft"
        )
        XCTAssertNil(coordinator.fatalError)
    }

    func testLaunchResumeWithoutTypingOpensTheStoredConversationWithItsOwnDraft() async {
        LaunchSessionStub.responses["conversations"] = (200, Self.storedConversationList)
        LaunchSessionStub.responses["sessions"] = (200, #"{"sessionId":"stored-example","model":"m","backend":"b"}"#)
        coordinator.saveDraft("The stored conversation's own draft", for: sessionKey("stored-example"))
        // Left in a new conversation on an earlier launch; nothing typed now.
        coordinator.saveDraft("An earlier unsent question", for: blankKey)

        await coordinator.retry()

        XCTAssertEqual(coordinator.sessionId, "stored-example")
        XCTAssertEqual(coordinator.draft(for: coordinator.composerDraftKey), "The stored conversation's own draft")
        XCTAssertEqual(coordinator.draft(for: blankKey), "An earlier unsent question")
    }

    private static let storedConversationList = #"""
    {"conversations":[{"id":"stored-example","title":"An invented chat","model":"m","backend":"b",
     "createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z","messageCount":2,"pinned":false}],
     "nextCursor":null}
    """#
}

/// Answers by the request's last path component and can run a step on the
/// main actor before answering, while the request is still in flight.
private final class LaunchSessionStub: URLProtocol {
    nonisolated(unsafe) static var responses: [String: (Int, String)] = [:]
    nonisolated(unsafe) static var beforeResponse: (@MainActor @Sendable (URLRequest) async -> Void)?

    static func reset() {
        responses = ["conversations": (200, #"{"conversations":[],"nextCursor":null}"#)]
        beforeResponse = nil
    }

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
        let request = request
        let response = Self.responses[request.url!.lastPathComponent] ?? (200, "{}")
        Task {
            await Self.beforeResponse?(request)
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
    }

    override func stopLoading() {}
}
