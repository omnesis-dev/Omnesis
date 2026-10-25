// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

/// Where a conversation opens after a load: at the top of the latest reply the
/// reader has not been shown, or at the bottom.
///
/// All fixture data is invented.
@available(iOS 17.0, *)
@MainActor
final class TranscriptReadingAnchorTests: XCTestCase {
    private func reply(_ id: String) -> AgentTurn {
        .assistant(AgentAssistantTurn(id: id, parts: [.text("Here is the plan.")], stopReason: "end_turn"))
    }

    // MARK: - The rule

    func testAnIdleTranscriptEndingOnAReplyOpensAtThatReply() {
        let decision = TranscriptReadingAnchor.decide(
            sessionId: "s1",
            busy: false,
            turns: [.user(id: "u-0", text: "Plan my week"), reply("a-1")],
            messageCount: 2,
            seen: nil
        )
        XCTAssertEqual(decision.turnId, "a-1")
        XCTAssertEqual(decision.seen, .reply("s1#2"))
    }

    func testAPendingReplyFollowsTheBottom() {
        let decision = TranscriptReadingAnchor.decide(
            sessionId: "s1",
            busy: false,
            turns: [reply("a-0"), .user(id: "u-1", text: "And next week?")],
            messageCount: 2,
            seen: nil
        )
        XCTAssertNil(decision.turnId)
    }

    func testABusyAgentFollowsTheBottom() {
        let decision = TranscriptReadingAnchor.decide(
            sessionId: "s1",
            busy: true,
            turns: [.user(id: "u-0", text: "Plan my week"), reply("a-1")],
            messageCount: 2,
            seen: nil
        )
        XCTAssertNil(decision.turnId)
    }

    func testAReplyAlreadyOpenedOnIsNotOpenedOnAgain() {
        let decision = TranscriptReadingAnchor.decide(
            sessionId: "s1",
            busy: false,
            turns: [.user(id: "u-0", text: "Plan my week"), reply("a-1")],
            messageCount: 2,
            seen: .reply("s1#2")
        )
        XCTAssertNil(decision.turnId)
        XCTAssertEqual(decision.seen, .reply("s1#2"))
    }

    func testANewerReplyInTheSameConversationOpensAgain() {
        let decision = TranscriptReadingAnchor.decide(
            sessionId: "s1",
            busy: false,
            turns: [.user(id: "u-2", text: "And next week?"), reply("a-3")],
            messageCount: 4,
            seen: .reply("s1#2")
        )
        XCTAssertEqual(decision.turnId, "a-3")
        XCTAssertEqual(decision.seen, .reply("s1#4"))
    }

    func testAReplyWatchedLiveFollowsTheBottomAndIsNamed() {
        let decision = TranscriptReadingAnchor.decide(
            sessionId: "s1",
            busy: false,
            turns: [.user(id: "u-0", text: "Plan my week"), reply("a-1")],
            messageCount: 2,
            seen: .watched(sessionId: "s1")
        )
        XCTAssertNil(decision.turnId)
        XCTAssertEqual(decision.seen, .reply("s1#2"))
    }

    func testAReplyWatchedInAnotherConversationDoesNotCount() {
        let decision = TranscriptReadingAnchor.decide(
            sessionId: "s2",
            busy: false,
            turns: [reply("a-0")],
            messageCount: 1,
            seen: .watched(sessionId: "s1")
        )
        XCTAssertEqual(decision.turnId, "a-0")
    }

    func testAReplyEndingUnwatchedLeavesNothingSeen() {
        XCTAssertEqual(
            TranscriptReadingAnchor.replyEnded(sessionId: "s1", watching: true),
            .watched(sessionId: "s1")
        )
        XCTAssertNil(TranscriptReadingAnchor.replyEnded(sessionId: "s1", watching: false))
    }

    // MARK: - The coordinator's loads

    private func snapshot(messageCount: Int, busy: Bool = false, endsOnReply: Bool = true) -> CreateSessionResponse {
        var messages: [ChatMessage] = [.user(parts: [.text("Summarise the Q4 budget review")])]
        if endsOnReply {
            messages.append(.assistant(parts: [.text("The review covered three areas.")]))
        }
        return CreateSessionResponse(
            sessionId: "s1",
            model: "m",
            backend: "b",
            messageCount: messageCount,
            busy: busy,
            messages: messages
        )
    }

    func testOpeningAConversationOnAFinishedReplyAnchorsOnce() async throws {
        let coord = AgentCoordinator()
        await coord.applySnapshotForTesting(snapshot(messageCount: 2), buffered: [])
        let lastId = try XCTUnwrap(coord.turns.last?.id)

        XCTAssertEqual(coord.takeReadingAnchor(), lastId)
        XCTAssertNil(coord.takeReadingAnchor(), "the transcript takes the anchor once")

        // A refresh that brings nothing new leaves the reader where they are.
        await coord.applySnapshotForTesting(snapshot(messageCount: 2), buffered: [])
        XCTAssertNil(coord.pendingReadingAnchor)
    }

    func testOpeningMidTurnOrOnAPendingReplyFollowsTheBottom() async {
        let coord = AgentCoordinator()
        await coord.applySnapshotForTesting(snapshot(messageCount: 2, busy: true), buffered: [])
        XCTAssertNil(coord.pendingReadingAnchor, "a turn in flight follows the bottom")

        let pending = AgentCoordinator()
        await pending.applySnapshotForTesting(snapshot(messageCount: 1, endsOnReply: false), buffered: [])
        XCTAssertNil(pending.pendingReadingAnchor, "a reply still to come follows the bottom")
    }

    func testAReplyThatFinishedWhileAwayAnchorsOnReturn() async throws {
        let coord = AgentCoordinator()
        coord.agentSurfaceVisibilityChanged(true)
        coord.appActiveChanged(true)
        await coord.applySnapshotForTesting(snapshot(messageCount: 1, endsOnReply: false), buffered: [])
        await coord.applyEventForTesting(.messageStart(sessionId: "s1", messageId: "m1"))
        XCTAssertNil(coord.pendingReadingAnchor, "the reader watches the reply stream in")

        // The app goes to the background before the reply ends; the reload on
        // return carries the finished reply.
        coord.appActiveChanged(false)
        await coord.applyEventForTesting(.messageEnd(sessionId: "s1", messageId: "m1", stopReason: "end_turn"))
        coord.appActiveChanged(true)
        await coord.applySnapshotForTesting(snapshot(messageCount: 2), buffered: [])

        XCTAssertEqual(coord.takeReadingAnchor(), try XCTUnwrap(coord.turns.last?.id))
    }

    func testAReplyWatchedToTheEndDoesNotAnchorOnALaterRefresh() async {
        let coord = AgentCoordinator()
        coord.agentSurfaceVisibilityChanged(true)
        coord.appActiveChanged(true)
        await coord.applySnapshotForTesting(snapshot(messageCount: 1, endsOnReply: false), buffered: [])
        await coord.applyEventForTesting(.messageStart(sessionId: "s1", messageId: "m1"))
        await coord.applyEventForTesting(.textDelta(sessionId: "s1", messageId: "m1", delta: "The review covered three areas."))
        await coord.applyEventForTesting(.messageEnd(sessionId: "s1", messageId: "m1", stopReason: "end_turn"))

        await coord.applySnapshotForTesting(snapshot(messageCount: 2), buffered: [])
        XCTAssertNil(coord.pendingReadingAnchor)
    }

    func testANewConversationDropsAnUntakenAnchor() async {
        let coord = AgentCoordinator()
        await coord.applySnapshotForTesting(snapshot(messageCount: 2), buffered: [])
        XCTAssertNotNil(coord.pendingReadingAnchor)
        coord.newConversation()
        XCTAssertNil(coord.pendingReadingAnchor)
    }
}
