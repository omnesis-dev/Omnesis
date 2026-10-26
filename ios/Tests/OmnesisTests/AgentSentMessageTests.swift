// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

/// A sent message is on screen from the moment Send is tapped: a transcript
/// bubble when it starts a turn, the queued bubble while a turn is running.
/// The gateway's user-message event names the submission it accepted, so the
/// early bubble is renamed rather than repeated; a refused send withdraws it.
///
/// All fixture data is invented.
@available(iOS 17.0, *)
@MainActor
final class AgentSentMessageTests: XCTestCase {
    override func tearDown() {
        RoutingStubProtocol.reset()
        super.tearDown()
    }

    private func makeClient() -> AgentClient {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [RoutingStubProtocol.self]
        return AgentClient(
            baseURL: URL(string: "https://stub.local")!,
            token: "test-token",
            session: URLSession(configuration: config)
        )
    }

    /// A coordinator on a live session of a gateway that offers queue controls.
    private func coordinator(sessionId: String) async -> AgentCoordinator {
        RoutingStubProtocol.reset()
        RoutingStubProtocol.controlsBody = Data(
            #"{"busy":false,"queuedMessages":[],"capabilities":{"coalescedQueue":true,"queueSendNow":true}}"#.utf8
        )
        let coord = AgentCoordinator()
        coord.attachForTesting(client: makeClient(), sessionId: sessionId)
        _ = await coord.refreshConversationControls()
        XCTAssertTrue(coord.conversationControlsSupported)
        return coord
    }

    private func userTurns(_ coord: AgentCoordinator) -> [(id: String, text: String)] {
        coord.turns.compactMap { turn in
            if case .user(let id, let text) = turn { return (id: id, text: text) }
            return nil
        }
    }

    /// Polls the main actor until `condition` holds or two seconds pass.
    private func settle(_ condition: @MainActor () -> Bool) async {
        for _ in 0 ..< 200 where !condition() {
            try? await Task.sleep(nanoseconds: 10_000_000)
        }
    }

    private func holdSubmission(status: Int = 202) -> ScriptedResponseGate {
        let gate = ScriptedResponseGate()
        RoutingStubProtocol.submissionResponses = [
            ScriptedMessageResponse(delay: 0, status: status, body: Data("{}".utf8), gate: gate),
        ]
        return gate
    }

    func testATurnStartingSendIsATranscriptBubbleBeforeTheGatewayAnswers() async {
        let coord = await coordinator(sessionId: "s-idle")
        defer { coord.stopForTesting() }
        let gate = holdSubmission()

        let send = Task { await coord.submitDraft(text: "hi") }
        await settle { !self.userTurns(coord).isEmpty }
        XCTAssertEqual(userTurns(coord).map(\.text), ["hi"], "the bubble is there while the request is held")
        XCTAssertTrue(coord.busy, "the bubble claims the turn")
        let placeholderId = userTurns(coord)[0].id

        gate.release()
        let accepted = await send.value
        XCTAssertTrue(accepted)
        XCTAssertEqual(userTurns(coord).map(\.text), ["hi"], "confirmation adds nothing")

        await coord.applyEventForTesting(
            .userMessage(sessionId: "s-idle", userMessageId: "u-1", text: "hi", submissionIds: [placeholderId])
        )
        XCTAssertEqual(userTurns(coord).map(\.id), ["u-1"], "the gateway's copy renames the bubble")
        XCTAssertEqual(userTurns(coord).map(\.text), ["hi"])
    }

    func testARefusedSendWithdrawsItsBubbleAndReleasesTheTurn() async {
        let coord = await coordinator(sessionId: "s-refused")
        defer { coord.stopForTesting() }
        let gate = holdSubmission(status: 500)

        let send = Task { await coord.submitDraft(text: "hi") }
        await settle { !self.userTurns(coord).isEmpty }
        XCTAssertEqual(userTurns(coord).map(\.text), ["hi"])

        gate.release()
        let accepted = await send.value
        XCTAssertFalse(accepted)
        XCTAssertTrue(userTurns(coord).isEmpty, "the placeholder is gone; the draft owns the retry")
        XCTAssertFalse(coord.busy)
        XCTAssertNotNil(coord.submissionError)
    }

    func testAFollowUpWhileATurnRunsJoinsTheQueuedBubbleAtOnce() async {
        let coord = await coordinator(sessionId: "s-busy")
        defer { coord.stopForTesting() }
        await coord.applyEventForTesting(.messageStart(sessionId: "s-busy", messageId: "m-1"))
        XCTAssertTrue(coord.busy)
        let gate = holdSubmission()

        let send = Task { await coord.submitDraft(text: "more") }
        await settle { coord.presentedConversationControls?.queued.contains { $0.text == "more" } == true }
        XCTAssertEqual(coord.presentedConversationControls?.queued.map(\.text), ["more"], "queued while the request is held")
        XCTAssertTrue(userTurns(coord).isEmpty, "a follow-up is not a transcript bubble")

        gate.release()
        let accepted = await send.value
        XCTAssertTrue(accepted)
        XCTAssertTrue(userTurns(coord).isEmpty)
    }
}
