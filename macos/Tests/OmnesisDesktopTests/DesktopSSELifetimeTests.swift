// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import DesktopCore
import Foundation
@testable import OmnesisDesktop
import XCTest

/// Real owned loopback HTTP proves fixture stream retirement, not private Foundation socket closure.
@MainActor
final class DesktopSSELifetimeTests: XCTestCase {
    func testContextReplacementDrainsOwnedConsumersAndRetiresRealHTTPStreams() async throws {
        let first = try await ScriptedAgentFixture.start()
        let second: ScriptedAgentFixture
        do { second = try await ScriptedAgentFixture.start() }
        catch { first.stop()
            throw error
        }
        let chat = DesktopChat()
        var contexts: [DesktopAPIContext] = []
        let previous = DesktopActionRouter.shared.pending
        DesktopActionRouter.shared.pending = nil
        var failure: Error?
        do {
            let old = try context(first, id: 1)
            contexts.append(old)
            chat.attach(old.api, context: old)
            try await wait { try await first.status().streams == 1 }
            old.invalidate()
            let current = try context(second, id: 2, predecessor: old)
            contexts.append(current)
            chat.attach(current.api, context: current)
            chat.prepareLocalDraft(question: "Keep this invented local draft.")
            try await wait { try await second.status().streams == 1 }
            await old.drain()
            // Server close notification can follow the joined application iterator.
            try await wait { try await first.status().streams == 0 }
            let retired = try await first.status()
            XCTAssertEqual(retired.streams, 0)
            XCTAssertFalse(old.isCurrent)
            XCTAssertTrue(current.isCurrent)
            XCTAssertEqual(chat.input, "Keep this invented local draft.")
            XCTAssertTrue(chat.rows.isEmpty)
            await chat.stopAndJoin()
            try await wait { try await second.status().streams == 0 }
            for fixture in [first, second] {
                let status = try await fixture.status()
                XCTAssertEqual(status.creates, 0)
                XCTAssertEqual(status.sends, 0)
                XCTAssertEqual(status.cancels, 0)
                XCTAssertEqual(status.documentReads, 0)
                XCTAssertEqual(status.unauthorized, 0)
                XCTAssertTrue(status.messages.isEmpty)
            }
        } catch { failure = error }
        contexts.forEach { $0.invalidate() }
        await chat.stopAndJoin()
        for context in contexts {
            await context.drain()
        }
        first.writeEvidence(name: "sse-retired-context-status")
        second.writeEvidence(name: "sse-current-context-status")
        first.stop()
        second.stop()
        DesktopActionRouter.shared.pending = previous
        if let failure { throw failure }
    }

    func testRepeatedStopJoinsActualOpenHTTPStreamWithoutCreatingConversation() async throws {
        let fixture = try await ScriptedAgentFixture.start()
        let chat = DesktopChat()
        var owned: DesktopAPIContext?
        let previous = DesktopActionRouter.shared.pending
        DesktopActionRouter.shared.pending = nil
        var failure: Error?
        do {
            let context = try context(fixture, id: 1)
            owned = context
            chat.attach(context.api, context: context)
            try await wait { try await fixture.status().streams == 1 }
            await chat.stopAndJoin()
            await chat.stopAndJoin()
            try await wait { try await fixture.status().streams == 0 }
            let status = try await fixture.status()
            XCTAssertEqual(status.creates, 0)
            XCTAssertEqual(status.sends, 0)
            XCTAssertEqual(status.cancels, 0)
            XCTAssertEqual(status.documentReads, 0)
            XCTAssertEqual(status.unauthorized, 0)
        } catch { failure = error }
        owned?.invalidate()
        await chat.stopAndJoin()
        await owned?.drain()
        fixture.writeEvidence(name: "sse-repeated-stop-status")
        fixture.stop()
        DesktopActionRouter.shared.pending = previous
        if let failure { throw failure }
    }

    private func context(_ fixture: ScriptedAgentFixture, id: UInt64, predecessor: DesktopAPIContext? = nil) throws -> DesktopAPIContext {
        let connection = try JSONDecoder().decode(DesktopConnection.self, from: JSONSerialization.data(withJSONObject: [
            "url": fixture.url.absoluteString, "token": "gui-fixture-token",
        ]))
        return try DesktopAPIContext(api: DesktopAPI(connection: connection), id: id, predecessor: predecessor)
    }

    private func wait(_ predicate: () async throws -> Bool) async throws {
        let deadline = ContinuousClock.now + .seconds(5)
        while ContinuousClock.now < deadline {
            let ready = try await predicate()
            guard ContinuousClock.now < deadline else { throw URLError(.timedOut) }
            if ready { return }
            try await Task.sleep(for: .milliseconds(25))
        }
        throw URLError(.timedOut)
    }
}
