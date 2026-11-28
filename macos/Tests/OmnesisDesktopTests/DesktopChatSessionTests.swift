// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import DesktopCore
@testable import OmnesisDesktop
import XCTest

@MainActor
final class DesktopChatSessionTests: XCTestCase {
    private func makeAPI(_ fixture: ScriptedAgentFixture) throws -> DesktopAPI {
        let data = try JSONSerialization.data(withJSONObject: ["url": fixture.url.absoluteString, "token": "gui-fixture-token"])
        return try DesktopAPI(connection: JSONDecoder().decode(DesktopConnection.self, from: data))
    }

    private func wait(_ predicate: () async throws -> Bool) async throws {
        let deadline = ContinuousClock.now + .seconds(5)
        while ContinuousClock.now < deadline {
            if try await predicate() { return }
            try await Task.sleep(for: .milliseconds(20))
        }
        throw URLError(.timedOut)
    }

    func testPersistedConversationIdentityAndCitationsSurviveReloadWithoutRepeatedAnnouncement() async throws {
        let fixture = try await ScriptedAgentFixture.start()
        defer { fixture.stop() }
        let chat = DesktopChat(), api = try makeAPI(fixture)
        chat.attach(api)
        defer { chat.detach() }
        await chat.checkModel(api)
        try await wait { try await fixture.status().streams == 1 }
        chat.input = "A fictional question"
        await chat.send()
        try await wait { chat.rows.last?.text == "The fictional" }
        try await fixture.complete()
        try await wait { !chat.busy && chat.references.count == 1 && chat.rows.last?.text.contains("saved answer") == true }
        XCTAssertEqual(chat.sessionId, "fixture-session")
        XCTAssertEqual(chat.conversationId, "fixture-conversation")
        XCTAssertEqual(chat.references.first?.documentId, "fictional-document")
        XCTAssertEqual(chat.announcementRevision, 1)
        await chat.open(chat.conversationId)
        XCTAssertEqual(chat.references.count, 1)
        XCTAssertEqual(chat.announcementRevision, 1, "Reading saved history must not re-announce a completed turn")
        await chat.cancel()
        XCTAssertFalse(chat.lastAnswerStopped, "An idle cancel acknowledgment does not prove a completed answer was interrupted")
    }

    func testAStoppedAnswerRemainsMarkedIncompleteWhenReopenedInAnotherChat() async throws {
        let fixture = try await ScriptedAgentFixture.start()
        defer { fixture.stop() }
        let api = try makeAPI(fixture), first = DesktopChat()
        first.attach(api)
        defer { first.detach() }
        await first.checkModel(api)
        try await wait { try await fixture.status().streams == 1 }
        first.input = "A fictional question"
        await first.send()
        try await wait { first.rows.last?.text == "The fictional" }
        await first.cancel()
        try await wait { !first.busy && first.lastAnswerStopped }
        let id = try XCTUnwrap(first.conversationId)
        first.detach()
        let reopened = DesktopChat()
        reopened.attach(api)
        defer { reopened.detach() }
        await reopened.open(id)
        XCTAssertTrue(reopened.lastAnswerStopped)
        XCTAssertEqual(reopened.rows.last?.text, "The fictional")
        XCTAssertNil(reopened.terminalFailure, "A stopped answer must not permanently lock the conversation")
        XCTAssertEqual(reopened.announcementRevision, 0)
    }
}
