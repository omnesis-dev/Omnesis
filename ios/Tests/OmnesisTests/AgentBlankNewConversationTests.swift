// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

/// The new-conversation button is hidden exactly when pressing it would land on the state the
/// surface is already in.
///
/// The Swift twin of `BlankNewConversationTest` on Android.
///
/// All fixture data is invented.
@available(iOS 17.0, *)
@MainActor
final class AgentBlankNewConversationTests: XCTestCase {
    func testAFreshSurfaceIsAlreadyANewConversation() {
        XCTAssertTrue(AgentCoordinator().isBlankNewConversation)
    }

    func testAConversationThatHasBeenSpokenInIsNotBlank() async {
        let coord = AgentCoordinator()

        await coord.applySnapshotForTesting(
            CreateSessionResponse(
                sessionId: "s_live",
                model: "m",
                backend: "b",
                messages: [.assistant(parts: [.text("Something answered")])]
            ),
            buffered: []
        )

        XCTAssertFalse(coord.isBlankNewConversation)
    }

    /// And starting a new one puts it back, which is what makes hiding the button safe.
    func testStartingANewConversationReturnsToBlank() async {
        let coord = AgentCoordinator()
        await coord.applySnapshotForTesting(
            CreateSessionResponse(
                sessionId: "s_live",
                model: "m",
                backend: "b",
                messages: [.assistant(parts: [.text("Something answered")])]
            ),
            buffered: []
        )
        XCTAssertFalse(coord.isBlankNewConversation)

        coord.newConversation()

        XCTAssertTrue(coord.isBlankNewConversation)
    }

    /// A minted session with nothing said in it yet is still a conversation, not the landing.
    func testAMintedSessionIsNotBlank() async {
        let coord = AgentCoordinator()

        await coord.applySnapshotForTesting(
            CreateSessionResponse(sessionId: "s_live", model: "m", backend: "b", messages: []),
            buffered: []
        )

        XCTAssertFalse(coord.isBlankNewConversation)
    }
}
