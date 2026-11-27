// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import AppIntents
import AppKit
import DesktopCore
import Foundation
@testable import OmnesisDesktop
import SwiftUI
import XCTest

/// Calls production intents directly; this does not exercise OS Spotlight registration or donation.
@MainActor
final class DesktopIntentsTests: XCTestCase {
    func testAskBeforeMountPreparesExactQuestionAndSendsOnlyAfterRealSend() async throws {
        try await withHarness { harness in
            let fixture = try await harness.startFixture()
            let question = "Compare the fictional café outline with its draft.\nKeep https://example.org/plan?scope=local&item=2#review as text."
            try await Self.ask(question)
            try await harness.mount()
            XCTAssertNotNil(DesktopActionRouter.shared.pending, "A missing API must not consume the question")
            try harness.bind(fixture)
            try await harness.waitForQuestion(question)
            let before = try await fixture.status()
            XCTAssertEqual(before.creates, 0)
            XCTAssertEqual(before.sends, 0)
            XCTAssertEqual(before.documentReads, 0)
            XCTAssertTrue(before.messages.isEmpty, "Preparing an intent must not change conversation messages")
            XCTAssertEqual(before.unauthorized, 0)
            XCTAssertNil(DesktopActionRouter.shared.pending)
            try await harness.capture("intent-prefilled-cold")
            try DesktopAccessibilityDriver.press("chat-send", in: harness.host)
            try await harness.wait {
                let status = try await fixture.status()
                return status.sends == 1 && status.messages.contains {
                    $0.role == "user" && $0.parts.contains { $0.text == question }
                }
            }
            let after = try await fixture.status()
            XCTAssertEqual(after.creates, 1)
            XCTAssertEqual(after.sends, 1)
            XCTAssertEqual(after.documentReads, 0)
        }
    }

    func testMountedIntentRoutesToAskAndNewConversationClearsVisiblePreparedQuestion() async throws {
        try await withHarness { harness in
            let fixture = try await harness.startFixture()
            try harness.bind(fixture)
            harness.store.destination = .setup
            try await harness.mount()
            XCTAssertEqual(harness.store.destination, .setup)
            let question = "Which fictional outline needs review?"
            try await Self.ask(question)
            try await harness.waitForQuestion(question)
            XCTAssertEqual(harness.store.destination, .ask)
            let prepared = try await fixture.status()
            XCTAssertEqual(prepared.creates, 0)
            XCTAssertEqual(prepared.sends, 0)
            XCTAssertTrue(prepared.messages.isEmpty)
            let result = try await NewOmnesisConversationIntent().perform()
            XCTAssertNil(result.value, "The system action must not return library content")
            try await harness.wait {
                let status = try await fixture.status()
                return status.creates == prepared.creates && harness.composerValue == "" && DesktopActionRouter.shared.pending == nil
            }
            XCTAssertNil(DesktopActionRouter.shared.pending)
            let fresh = try await fixture.status()
            XCTAssertEqual(fresh.creates, 0)
            XCTAssertEqual(fresh.sends, 0)
            XCTAssertEqual(fresh.documentReads, 0)
            XCTAssertTrue(fresh.messages.isEmpty)
            try await harness.capture("intent-new-blank")
        }
    }

    func testPendingIntentRoutesRecreatedRootFromRetainedNonAskDestination() async throws {
        try await withHarness { harness in
            let fixture = try await harness.startFixture()
            try harness.bind(fixture)
            harness.store.destination = .setup
            try await harness.mount()
            weak var previousHost: NSView? = try harness.host
            harness.unmount()
            try await harness.wait { previousHost == nil }
            XCTAssertEqual(harness.store.destination, .setup)
            let before = try await fixture.status()
            let question = "Prepare the fictional project summary after reopening."
            try await Self.ask(question)
            try await harness.mount()
            try await harness.waitForQuestion(question)
            XCTAssertEqual(harness.store.destination, .ask)
            let after = try await fixture.status()
            XCTAssertEqual(after.creates, before.creates)
            XCTAssertEqual(after.sends, before.sends)
            XCTAssertEqual(after.documentReads, before.documentReads)
            XCTAssertTrue(after.messages.isEmpty)
            XCTAssertNil(DesktopActionRouter.shared.pending)
            try await harness.capture("intent-remounted-query")
        }
    }

    func testHeldOlderIntentCompletionCannotOverwriteNewerVisibleQuestion() async throws {
        try await withHarness { harness in
            let fixture = try await harness.startFixture(controlled: true)
            try await harness.configure(fixture, session: "older-session", held: true)
            try harness.bind(fixture)
            let older = "The older fictional question must not replace its successor."
            try await Self.ask(older)
            try await harness.mount()
            try await harness.waitForQuestion(older)
            let localOnly = try await harness.sessionRequests(fixture)
            XCTAssertTrue(localOnly.isEmpty)
            try DesktopAccessibilityDriver.press("chat-send", in: harness.host)
            try await harness.wait { try await harness.sessionRequests(fixture).count == 1 }
            let oldRequest = try await harness.heldSessionTask()
            try await harness.configure(fixture, session: "newer-session", held: false)
            let question = "Keep this newer fictional question ready to send."
            try await Self.ask(question)
            try await harness.waitForQuestion(question)
            let prepared = try await harness.sessionRequests(fixture)
            XCTAssertEqual(prepared.count, 1, "The successor intent must remain a local draft")
            try await harness.release(fixture)
            try await harness.wait { oldRequest.state == .completed }
            try await harness.assertQuestionRemains(question)
            try await harness.assertNoSubmission(fixture)
            XCTAssertNil(DesktopActionRouter.shared.pending)
        }
    }

    func testIntentAfterApiRetirementCannotPublishOldQuestionIntoCurrentComposer() async throws {
        try await withHarness { harness in
            let first = try await harness.startFixture(controlled: true)
            let second = try await harness.startFixture(controlled: true)
            try await harness.configure(first, session: "retired-session", held: true)
            try await harness.configure(second, session: "current-session", held: false)
            try harness.bind(first)
            let retired = try XCTUnwrap(harness.store.apiContext)
            let older = "The retired library question must not become current."
            try await Self.ask(older)
            try await harness.mount()
            try await harness.waitForQuestion(older)
            try DesktopAccessibilityDriver.press("chat-send", in: harness.host)
            try await harness.wait { try await harness.sessionRequests(first).count == 1 }
            let oldRequest = try await harness.heldSessionTask()
            try harness.bind(second)
            XCTAssertFalse(retired.isCurrent)
            let current = try XCTUnwrap(harness.store.apiContext)
            XCTAssertFalse(current === retired)
            let question = "Prepare only this current library question."
            try await Self.ask(question)
            try await harness.waitForQuestion(question)
            let currentSessions = try await harness.sessionRequests(second)
            XCTAssertTrue(currentSessions.isEmpty)
            try await harness.release(first)
            await retired.drain()
            try await harness.wait { oldRequest.state == .completed }
            try await harness.assertQuestionRemains(question)
            XCTAssertTrue(harness.store.apiContext === current)
            XCTAssertTrue(current.isCurrent)
            try await harness.assertNoSubmission(first)
            try await harness.assertNoSubmission(second)
            XCTAssertNil(DesktopActionRouter.shared.pending)
        }
    }

    func testHeldSendCannotPostItsQuestionIntoASuccessorHistorySession() async throws {
        try await withHarness { harness in
            let fixture = try await harness.startFixture(controlled: true)
            try await harness.configure(fixture, session: "older-session", held: true)
            try harness.bind(fixture)
            let api = try XCTUnwrap(harness.store.api)
            let context = try XCTUnwrap(harness.store.apiContext)
            let chat = harness.makeChat()
            chat.attach(api, context: context)
            await chat.checkModel(api)
            chat.prepareLocalDraft(question: "The older send must not enter the successor history.")
            let sending = Task { await chat.send() }
            do {
                try await harness.wait { try await harness.sessionRequests(fixture).count == 1 }
                try await harness.configure(fixture, session: "history-session", held: false)
                let question = "Keep the successor draft while reviewing existing history."
                chat.prepareLocalDraft(question: question)
                let accepted = await chat.open("fictional-existing-history")
                XCTAssertEqual(accepted?.sessionId, "history-session")
                XCTAssertEqual(chat.sessionId, "history-session")
                XCTAssertFalse(chat.busy, "The successor must not mask a stale send with a busy guard")
                try await harness.release(fixture)
                await sending.value
                XCTAssertTrue(chat.input == question)
                XCTAssertEqual(chat.sessionId, "history-session")
                XCTAssertFalse(chat.busy)
                try await harness.assertNoSubmission(fixture, allowingHistoryOpen: true)
            } catch {
                sending.cancel()
                await sending.value
                throw error
            }
        }
    }

    func testNewLocalDraftWorksWithoutAnAvailableModelOrAServerSession() async throws {
        try await withHarness { harness in
            let fixture = try await harness.startFixture(controlled: true)
            try await harness.configure(fixture, session: "unused-session", held: false, configured: false)
            try harness.bind(fixture)
            let question = "Keep an invented draft even before answers are configured."
            try await Self.ask(question)
            try await harness.mount()
            try await harness.waitForQuestion(question, sendEnabled: false)
            _ = try await NewOmnesisConversationIntent().perform()
            try await harness.wait { harness.composerValue == "" && DesktopActionRouter.shared.pending == nil }
            let sessions = try await harness.sessionRequests(fixture)
            XCTAssertTrue(sessions.isEmpty)
            try await harness.assertNoSubmission(fixture)
        }
    }

    func testReusedApiObjectCannotReviveAnOldChatBindingAndOrdinaryReattachPreservesDraft() async throws {
        try await withHarness { harness in
            let first = try await harness.startFixture(controlled: true)
            let second = try await harness.startFixture(controlled: true)
            try await harness.configure(first, session: "retired-session", held: true)
            try await harness.configure(second, session: "unused-session", held: false)
            try harness.bind(first)
            let api = try XCTUnwrap(harness.store.api)
            let retired = try XCTUnwrap(harness.store.apiContext)
            let chat = harness.makeChat()
            chat.attach(api, context: retired)
            await chat.checkModel(api)
            chat.prepareLocalDraft(question: "The original binding must remain retired.")
            let sending = Task { await chat.send() }
            do {
                try await harness.wait { try await harness.sessionRequests(first).count == 1 }
                try harness.bind(second)
                try harness.bind(first, reusing: api)
                let current = try XCTUnwrap(harness.store.apiContext)
                XCTAssertFalse(current === retired)
                XCTAssertFalse(retired.isCurrent)
                chat.attach(api, context: current)
                await chat.checkModel(api)
                let question = "This draft belongs to the new incarnation of the same API object."
                chat.prepareLocalDraft(question: question)
                chat.detach()
                chat.attach(api, context: current)
                XCTAssertTrue(chat.input == question, "Reattaching without a pending action must preserve the local draft")
                try await harness.release(first)
                await sending.value
                XCTAssertTrue(chat.input == question)
                XCTAssertNil(chat.sessionId)
                XCTAssertFalse(chat.busy)
                try await harness.assertNoSubmission(first)
                try await harness.assertNoSubmission(second)
            } catch {
                sending.cancel()
                await sending.value
                throw error
            }
        }
    }

    func testQueuedSendBeforeNewCannotBorrowTheReplacementDraft() async throws {
        try await withHarness { harness in
            let fixture = try await harness.startFixture(controlled: true)
            try await harness.configure(fixture, session: "current-session", held: false)
            try harness.bind(fixture)
            let context = try XCTUnwrap(harness.store.apiContext)
            let chat = harness.makeChat()
            chat.attach(context.api, context: context)
            await chat.checkModel(context.api)
            chat.prepareLocalDraft(question: "The queued question belongs to the old draft.")
            // No actor suspension between the real UI action wrapper and New: its task cannot start first.
            let queued = try XCTUnwrap(chat.requestSend(in: context))
            let question = "Only an explicit new Send may submit this replacement draft."
            chat.prepareLocalDraft(question: question)
            await queued.value
            let sessions = try await harness.sessionRequests(fixture)
            XCTAssertTrue(sessions.isEmpty)
            XCTAssertTrue(chat.input == question)
            XCTAssertNil(chat.sessionId)
            try await harness.assertNoSubmission(fixture)
            let current = try XCTUnwrap(chat.requestSend(in: context))
            await current.value
            XCTAssertEqual(chat.sessionId, "current-session")
            XCTAssertTrue(chat.input.isEmpty)
            try await harness.assertMessages(fixture, session: "current-session", texts: [question])
        }
    }

    func testQueuedHistoryAndCancelBeforeNewCannotAffectItsReplacement() async throws {
        try await withHarness { harness in
            let fixture = try await harness.startFixture(controlled: true)
            try await harness.configure(fixture, session: "history-session", held: false)
            try harness.bind(fixture)
            let context = try XCTUnwrap(harness.store.apiContext)
            let chat = harness.makeChat()
            chat.attach(context.api, context: context)
            await chat.checkModel(context.api)
            let queued = try XCTUnwrap(chat.requestOpen("obsolete-history", in: context))
            chat.prepareLocalDraft(question: "The new draft must not reopen old history.")
            await queued.value
            let obsolete = try await harness.sessionRequests(fixture)
            XCTAssertTrue(obsolete.isEmpty)
            XCTAssertNil(chat.sessionId)
            XCTAssertFalse(chat.opening)
            let opening = try XCTUnwrap(chat.requestOpen("accepted-history", in: context))
            await opening.value
            XCTAssertEqual(chat.sessionId, "history-session")
            let canceled = try XCTUnwrap(chat.requestCancel(in: context))
            chat.prepareLocalDraft(question: "New must not cancel already accepted server work.")
            await canceled.value
            try await harness.assertCancelCount(fixture, session: "history-session", expected: 0)
            XCTAssertNil(chat.sessionId)
            let reopening = try XCTUnwrap(chat.requestOpen("accepted-history", in: context))
            await reopening.value
            let currentCancel = try XCTUnwrap(chat.requestCancel(in: context))
            await currentCancel.value
            try await harness.assertCancelCount(fixture, session: "history-session", expected: 1)
            try await harness.assertMessages(fixture, session: "history-session", texts: [])
            XCTAssertNil(chat.failure)
        }
    }

    func testQueuedUiSendCannotReviveAcrossApiObjectABA() async throws {
        try await withHarness { harness in
            let first = try await harness.startFixture(controlled: true)
            let second = try await harness.startFixture(controlled: true)
            try await harness.configure(first, session: "current-session", held: false)
            try await harness.configure(second, session: "unused-session", held: false)
            try harness.bind(first)
            let original = try XCTUnwrap(harness.store.apiContext)
            let chat = harness.makeChat()
            chat.attach(original.api, context: original)
            await chat.checkModel(original.api)
            chat.prepareLocalDraft(question: "This queued send belongs to a permanently retired context.")
            let queued = try XCTUnwrap(chat.requestSend(in: original))
            // Context retirement and reuse happen before yielding to the queued operation.
            try harness.bind(second)
            try harness.bind(first, reusing: original.api)
            let current = try XCTUnwrap(harness.store.apiContext)
            chat.attach(current.api, context: current)
            chat.prepareLocalDraft(question: "The new incarnation must remain a local draft.")
            await queued.value
            await original.drain()
            XCTAssertFalse(original.isCurrent)
            XCTAssertFalse(current === original)
            XCTAssertTrue(current.isCurrent)
            XCTAssertNil(chat.sessionId)
            XCTAssertTrue(chat.input == "The new incarnation must remain a local draft.")
            let firstSessions = try await harness.sessionRequests(first)
            let secondSessions = try await harness.sessionRequests(second)
            XCTAssertTrue(firstSessions.isEmpty)
            XCTAssertTrue(secondSessions.isEmpty)
            try await harness.assertNoSubmission(first)
            try await harness.assertNoSubmission(second)
        }
    }

    func testEnqueuedNewBlocksQueuedConversationActionsBeforeTheViewObserverAppliesIt() async throws {
        try await withHarness { harness in
            let fixture = try await harness.startFixture(controlled: true)
            try await harness.configure(fixture, session: "history-session", held: false)
            try harness.bind(fixture)
            let context = try XCTUnwrap(harness.store.apiContext)
            let chat = harness.makeChat()
            chat.attach(context.api, context: context)
            await chat.checkModel(context.api)
            chat.prepareLocalDraft(question: "A queued Send must stop at the pending New boundary.")
            let send = try XCTUnwrap(chat.requestSend(in: context))
            // This synchronous producer is shared by toolbar New and Cmd-N. No mounted observer consumes it here.
            DesktopActionRouter.shared.enqueue(question: nil)
            await send.value
            let sessions = try await harness.sessionRequests(fixture)
            XCTAssertTrue(sessions.isEmpty)
            XCTAssertNil(chat.requestSend(in: context))
            let request = try XCTUnwrap(DesktopActionRouter.shared.pending)
            chat.prepareLocalDraft(question: request.question)
            XCTAssertTrue(DesktopActionRouter.shared.consume(request))
            let history = try XCTUnwrap(chat.requestOpen("obsolete-history", in: context))
            DesktopActionRouter.shared.enqueue(question: nil)
            await history.value
            let obsoleteHistory = try await harness.sessionRequests(fixture)
            XCTAssertTrue(obsoleteHistory.isEmpty)
            let next = try XCTUnwrap(DesktopActionRouter.shared.pending)
            chat.prepareLocalDraft(question: next.question)
            XCTAssertTrue(DesktopActionRouter.shared.consume(next))
            let accepted = try XCTUnwrap(chat.requestOpen("accepted-history", in: context))
            await accepted.value
            XCTAssertEqual(chat.sessionId, "history-session")
            let cancel = try XCTUnwrap(chat.requestCancel(in: context))
            DesktopActionRouter.shared.enqueue(question: nil)
            await cancel.value
            try await harness.assertCancelCount(fixture, session: "history-session", expected: 0)
            try await harness.assertMessages(fixture, session: "history-session", texts: [])
            XCTAssertNotNil(DesktopActionRouter.shared.pending)
        }
    }

    func testPendingNewBlocksHeldSessionPublicationBeforeTheViewObserverRuns() async throws {
        try await withHarness { harness in
            let fixture = try await harness.startFixture(controlled: true)
            try await harness.configure(fixture, session: "obsolete-session", held: true)
            try harness.bind(fixture)
            let context = try XCTUnwrap(harness.store.apiContext)
            let chat = harness.makeChat()
            chat.attach(context.api, context: context)
            let question = "Keep the old draft untouched until the pending action is applied."
            chat.prepareLocalDraft(question: question)
            let opening = try XCTUnwrap(chat.requestOpen("obsolete-history", in: context))
            do {
                try await harness.wait { try await harness.sessionRequests(fixture).count == 1 }
                DesktopActionRouter.shared.enqueue(question: nil)
                try await harness.release(fixture)
                await opening.value
                XCTAssertNil(chat.sessionId)
                XCTAssertNil(chat.conversationId)
                XCTAssertTrue(chat.rows.isEmpty)
                XCTAssertTrue(chat.input == question)
                XCTAssertFalse(chat.opening)
                XCTAssertNotNil(DesktopActionRouter.shared.pending)
                try await harness.assertNoSubmission(fixture, allowingHistoryOpen: true)
            } catch {
                opening.cancel()
                await opening.value
                throw error
            }
        }
    }

    private static func ask(_ question: String) async throws {
        var intent = AskOmnesisDesktopIntent()
        intent.question = question
        let result = try await intent.perform()
        XCTAssertNil(result.value, "The system action must not return library content")
        XCTAssertTrue(AskOmnesisDesktopIntent.isDiscoverable)
        XCTAssertTrue(AskOmnesisDesktopIntent.openAppWhenRun)
    }

    private func withHarness(_ operation: @MainActor (IntentHarness) async throws -> Void) async throws {
        let previousRequest = DesktopActionRouter.shared.pending
        DesktopActionRouter.shared.pending = nil
        let harness = IntentHarness()
        do {
            try await operation(harness)
        } catch {
            await harness.close()
            DesktopActionRouter.shared.pending = previousRequest
            throw error
        }
        await harness.close()
        DesktopActionRouter.shared.pending = previousRequest
    }
}

@MainActor
private final class IntentHarness {
    let store = DesktopStore(startRuntime: false)
    private var window: NSWindow?
    private var hosting: NSHostingView<IntentRoot>?
    private var fixtures: [ScriptedAgentFixture] = []
    private var contexts: [DesktopAPIContext] = []
    private var apis: [DesktopAPI] = []
    private var chats: [DesktopChat] = []

    func makeChat() -> DesktopChat {
        let chat = DesktopChat()
        chats.append(chat)
        return chat
    }

    private let control: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 3
        configuration.timeoutIntervalForResource = 3
        return URLSession(configuration: configuration)
    }()

    var host: NSView {
        get throws { try XCTUnwrap(hosting) }
    }

    var composerValue: String? {
        guard let hosting else { return nil }
        return (try? DesktopAccessibilityDriver.element("chat-input", in: hosting))?.accessibilityTextValue()
    }

    func startFixture(controlled: Bool = false) async throws -> ScriptedAgentFixture {
        let fixture = try await ScriptedAgentFixture.start(scriptName: controlled ? "api-context-fixture.mjs" : "scripted-agent.mjs")
        fixtures.append(fixture)
        return fixture
    }

    func bind(_ fixture: ScriptedAgentFixture, reusing api: DesktopAPI? = nil) throws {
        let data = try JSONSerialization.data(withJSONObject: [
            "phase": "ready", "mode": "home", "encrypted": true,
            "connection": ["url": fixture.url.absoluteString, "token": "gui-fixture-token"],
        ])
        store.state = try JSONDecoder().decode(DesktopState.self, from: data)
        store.api = try api ?? DesktopAPI(connection: JSONDecoder().decode(
            DesktopConnection.self,
            from: JSONSerialization.data(withJSONObject: [
                "url": fixture.url.absoluteString, "token": "gui-fixture-token",
            ])
        ))
        if let context = store.apiContext { contexts.append(context) }
        if let api = store.api, !apis.contains(where: { $0 === api }) { apis.append(api) }
    }

    func mount() async throws {
        XCTAssertNil(window, "Only one test-owned root may be mounted")
        let host = NSHostingView(rootView: IntentRoot(store: store))
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 860, height: 600),
            styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false
        )
        window.isReleasedWhenClosed = false
        window.appearance = NSAppearance(named: .aqua)
        window.contentView = host
        self.window = window
        hosting = host
        window.center()
        window.makeKeyAndOrderFront(nil)
        try await DesktopAccessibilityDriver.materializeOwnedApplication()
    }

    func unmount() {
        window?.contentView = nil
        window?.close()
        hosting = nil
        window = nil
    }

    func capture(_ name: String) async throws {
        let window = try XCTUnwrap(window)
        let screen = try XCTUnwrap(window.screen)
        XCTAssertTrue(screen.visibleFrame.insetBy(dx: -1, dy: -1).contains(window.frame))
        DesktopSnapshotRenderer.assertOwnedWindowChrome(window)
        let output = URL(fileURLWithPath: "/tmp/omnesis-macos-snapshots", isDirectory: true)
        try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
        try await DesktopSnapshotRenderer.captureOwnedWindow(window, output: output, name: name, appearance: .aqua, requireActive: true)
    }

    func wait(_ condition: @MainActor () async throws -> Bool) async throws {
        let deadline = ContinuousClock.now + .seconds(5)
        while ContinuousClock.now < deadline {
            let ready = try await condition()
            guard ContinuousClock.now < deadline else { throw URLError(.timedOut) }
            if ready { return }
            try await Task.sleep(for: .milliseconds(25))
        }
        throw URLError(.timedOut)
    }

    func waitForQuestion(_ expected: String, sendEnabled: Bool = true) async throws {
        try await wait {
            guard let hosting = self.hosting, self.composerValue == expected,
                  let input = try? DesktopAccessibilityDriver.element("chat-input", in: hosting),
                  let send = try? DesktopAccessibilityDriver.element("chat-send", in: hosting) else { return false }
            return input.isAccessibilityEnabled() && send.isAccessibilityEnabled() == sendEnabled
        }
        let input = try DesktopAccessibilityDriver.element("chat-input", in: host)
        let window = try XCTUnwrap(window)
        let frame = input.accessibilityFrame()
        XCTAssertGreaterThan(frame.width, 0)
        XCTAssertGreaterThan(frame.height, 0)
        XCTAssertTrue(window.frame.contains(frame))
        XCTAssertTrue(window.firstResponder is NSTextView, "The real composer must receive focus")
    }

    func configure(_ fixture: ScriptedAgentFixture, session: String, held: Bool, configured: Bool = true) async throws {
        let model: [String: Any] = [
            "providerId": "fixture", "providerLabel": "Scripted provider", "modelName": "Fictional model",
            "configured": configured, "available": configured,
        ]
        let routes: [String: Any] = [
            "GET /agent/model": ["body": model],
            "GET /agent/conversations": ["body": ["conversations": [], "nextCursor": NSNull()]],
            "POST /agent/sessions/\(session)/messages": ["body": ["messageId": "fictional-answer"]],
            "POST /agent/sessions/\(session)/cancel": ["body": [:]],
            "POST /agent/sessions": ["hold": held, "body": [
                "sessionId": session, "conversationId": session, "model": "fictional-scripted", "backend": "fixture",
                "title": "Fictional conversation", "busy": false, "eventCursor": 0, "messages": [],
            ]],
        ]
        _ = try await request(fixture, "fixture-config", method: "POST", body: ["routes": routes])
    }

    func release(_ fixture: ScriptedAgentFixture) async throws {
        _ = try await request(fixture, "fixture-release", method: "POST")
    }

    private struct Request: Decodable {
        let method: String
        let path: String
        let body: [String: BridgeValue]?
    }

    private func requests(_ fixture: ScriptedAgentFixture) async throws -> [Request] {
        struct Reply: Decodable { let requests: [Request] }
        return try await JSONDecoder().decode(Reply.self, from: request(fixture, "fixture-context-status")).requests
    }

    func sessionRequests(_ fixture: ScriptedAgentFixture) async throws -> [String] {
        try await requests(fixture).filter { $0.method == "POST" && $0.path == "/agent/sessions" }.map(\.path)
    }

    func heldSessionTask() async throws -> URLSessionTask {
        let api = try XCTUnwrap(store.api)
        let tasks = await tasks(in: api.session)
        let sessions = tasks.filter {
            $0.originalRequest?.httpMethod == "POST" && $0.originalRequest?.url?.path == "/agent/sessions"
        }
        XCTAssertEqual(sessions.count, 1, "The controlled fixture must hold exactly one actual session request")
        let task = try XCTUnwrap(sessions.first)
        XCTAssertEqual(task.state, .running)
        return task
    }

    func assertQuestionRemains(_ expected: String) async throws {
        // The exact retained transport task has completed; yield actor turns without replaying an intent.
        for _ in 0 ..< 8 {
            await Task.yield()
            XCTAssertTrue(composerValue == expected, "A retired completion must not overwrite the current question")
        }
        try await waitForQuestion(expected)
    }

    private func tasks(in session: URLSession) async -> [URLSessionTask] {
        await withCheckedContinuation { continuation in
            session.getAllTasks { continuation.resume(returning: $0) }
        }
    }

    func assertMessages(_ fixture: ScriptedAgentFixture, session: String, texts: [String]) async throws {
        let observed = try await requests(fixture)
        let messages = observed.filter { $0.method == "POST" && $0.path.hasSuffix("/messages") }
        XCTAssertEqual(messages.count, texts.count)
        for (message, text) in zip(messages, texts) {
            XCTAssertEqual(message.path, "/agent/sessions/\(session)/messages")
            XCTAssertEqual(message.body?["text"], .string(text))
        }
    }

    func assertCancelCount(_ fixture: ScriptedAgentFixture, session: String, expected: Int) async throws {
        let observed = try await requests(fixture)
        let cancels = observed.filter { $0.method == "POST" && $0.path.hasSuffix("/cancel") }
        XCTAssertEqual(cancels.count, expected)
        XCTAssertTrue(cancels.allSatisfy { $0.path == "/agent/sessions/\(session)/cancel" })
    }

    func assertNoSubmission(_ fixture: ScriptedAgentFixture, allowingHistoryOpen: Bool = false) async throws {
        let observed = try await requests(fixture)
        XCTAssertFalse(observed.contains { $0.path.hasPrefix("/documents/") })
        XCTAssertFalse(observed.contains { $0.path.contains("/messages") })
        XCTAssertTrue(observed.allSatisfy { $0.method == "GET" || ($0.method == "POST" && $0.path == "/agent/sessions") })
        if !allowingHistoryOpen {
            XCTAssertTrue(observed.filter { $0.path == "/agent/sessions" }.allSatisfy { $0.body?["resumeFromId"] == nil })
        }
    }

    private func request(
        _ fixture: ScriptedAgentFixture,
        _ path: String,
        method: String = "GET",
        body: [String: Any]? = nil
    ) async throws
        -> Data {
        var request = URLRequest(url: fixture.url.appendingPathComponent(path))
        request.httpMethod = method
        request.setValue("Bearer gui-fixture-token", forHTTPHeaderField: "Authorization")
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        let (data, response) = try await control.data(for: request)
        guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw URLError(.badServerResponse) }
        return data
    }

    func close() async {
        unmount()
        chats.forEach { $0.detach() }
        store.api = nil
        for context in contexts {
            context.invalidate()
        }
        var pending: [URLSessionTask] = []
        for api in apis {
            pending += await tasks(in: api.session)
            api.session.invalidateAndCancel()
        }
        control.invalidateAndCancel()
        fixtures.forEach { $0.stop() }
        do {
            try await wait { pending.allSatisfy { $0.state == .completed } }
        } catch {
            XCTFail("Owned intent HTTP tasks did not finish after cancellation and fixture shutdown")
        }
        for chat in chats {
            await chat.stopAndJoin()
        }
        await store.stopPrerequisiteMonitoring()
        for context in contexts {
            await context.drain()
        }
        await Task.yield()
    }

    private struct IntentRoot: View {
        let store: DesktopStore
        var body: some View {
            DesktopRootView().environment(store).id(store.apiContextEpoch)
        }
    }
}
