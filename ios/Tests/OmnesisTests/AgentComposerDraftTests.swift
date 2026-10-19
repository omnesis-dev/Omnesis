// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

/// The composer's unsent words belong to the conversation they were written
/// in: sending empties the composer, a refused send puts the words back, and
/// a new conversation always starts with an empty composer.
///
/// All fixture data is invented.
@available(iOS 17.0, *)
@MainActor
final class AgentComposerDraftTests: XCTestCase {
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

    /// A fresh coordinator on a stub gateway that mints a session and
    /// accepts a message.
    private func freshCoordinator() -> AgentCoordinator {
        RoutingStubProtocol.reset()
        RoutingStubProtocol.sessionResponses = [
            (delay: 0, body: Data(#"{"sessionId":"s_minted","model":"m","backend":"b","messages":[]}"#.utf8)),
        ]
        RoutingStubProtocol.jsonBody = Data(#"{"messageId":"a1","userMessageId":"u1"}"#.utf8)
        let coord = AgentCoordinator()
        coord.attachForTesting(client: makeClient(), sessionId: "placeholder")
        coord.newConversation()
        return coord
    }

    /// Send "Hi" in a new chat, then start another: the composer is empty,
    /// not "Hi" again.
    func testANewConversationStartsWithAnEmptyComposer() async {
        let coord = freshCoordinator()
        defer { coord.stopForTesting() }

        coord.composerDraft = "Hi"
        let sent = await coord.sendComposerDraft("Hi")
        XCTAssertTrue(sent)
        XCTAssertEqual(coord.composerDraft, "", "sending empties the composer")
        XCTAssertEqual(coord.sessionId, "s_minted")

        coord.newConversation()
        XCTAssertEqual(coord.composerDraft, "")
        XCTAssertNil(coord.sessionId)
    }

    /// Words typed after the answer do not follow into the next conversation either.
    func testWordsTypedInOneConversationDoNotFollowIntoTheNext() async {
        let coord = freshCoordinator()
        defer { coord.stopForTesting() }

        await coord.sendComposerDraft("Hi")
        coord.composerDraft = "And another thing"
        coord.newConversation()
        XCTAssertEqual(coord.composerDraft, "")
    }

    /// A send the gateway refused puts the words back for another try —
    /// and a new conversation still starts empty.
    func testARefusedSendPutsTheWordsBackUntilANewConversation() async {
        let coord = freshCoordinator()
        defer { coord.stopForTesting() }
        RoutingStubProtocol.sendResponses = [
            ScriptedMessageResponse(delay: 0, status: 503, body: Data(#"{"error":"temporarily unavailable"}"#.utf8)),
        ]

        let sent = await coord.sendComposerDraft("Hi")
        XCTAssertFalse(sent)
        XCTAssertEqual(coord.composerDraft, "Hi", "the refused words come back")

        coord.newConversation()
        XCTAssertEqual(coord.composerDraft, "")
    }

    /// Newer words typed while a refused send was in flight are kept, not
    /// overwritten by the refused ones.
    func testARefusedSendNeverOverwritesNewerWords() async {
        let coord = freshCoordinator()
        defer { coord.stopForTesting() }
        RoutingStubProtocol.sendResponses = [
            ScriptedMessageResponse(delay: 0.3, status: 503, body: Data(#"{"error":"temporarily unavailable"}"#.utf8)),
        ]

        let sending = Task { await coord.sendComposerDraft("Hi") }
        try? await Task.sleep(nanoseconds: 50_000_000)
        XCTAssertEqual(coord.composerDraft, "", "the composer empties at once")
        coord.composerDraft = "Second thought"
        let sent = await sending.value
        XCTAssertFalse(sent)
        XCTAssertEqual(coord.composerDraft, "Second thought")
    }
}
