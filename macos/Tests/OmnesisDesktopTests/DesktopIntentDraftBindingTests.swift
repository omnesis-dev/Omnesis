// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import DesktopCore
import Foundation
@testable import OmnesisDesktop
import XCTest

@MainActor
final class DesktopIntentDraftBindingTests: XCTestCase {
    func testAnOlderContextCallbackCannotConsumeOrAdoptTheSuccessorDraft() async throws {
        try await withFixture { fixture in
            let first = try fixture.bind()
            fixture.chat.attach(first.api, context: first)
            fixture.chat.prepareLocalDraft(question: "Keep the original invented draft.")
            fixture.router.enqueue(question: "An older observed request.")
            let observation = fixture.observation(first)
            let successor = try fixture.bind()
            fixture.router.enqueue(question: "Keep the successor invented request pending.")
            let pending = fixture.router.pending
            var prepared = 0
            let applied = observation.apply(
                to: fixture.chat,
                context: first,
                currentContext: fixture.store.apiContext,
                router: fixture.router
            ) { prepared += 1 }
            XCTAssertFalse(applied)
            XCTAssertFalse(first.isCurrent)
            XCTAssertTrue(fixture.store.apiContext === successor)
            XCTAssertEqual(fixture.router.pending, pending)
            XCTAssertEqual(fixture.chat.input, "Keep the original invented draft.")
            XCTAssertEqual(prepared, 0)
            let accidentalAdoption = fixture.chat.requestModelCheck(in: successor)
            XCTAssertNil(accidentalAdoption, "The retired view's chat must not adopt the successor binding")
            accidentalAdoption?.cancel()
        }
    }

    func testNilContextObservationCannotAdoptTheCurrentLibraryOrConsumeItsRequest() async throws {
        try await withFixture { fixture in
            let observation = DesktopDraftObservation(context: nil, request: nil)
            fixture.chat.prepareLocalDraft(question: "Keep the unbound invented draft.")
            let current = try fixture.bind()
            fixture.router.enqueue(question: "The current library's pending request.")
            let pending = fixture.router.pending
            XCTAssertFalse(observation.apply(
                to: fixture.chat,
                context: nil,
                currentContext: fixture.store.apiContext,
                router: fixture.router
            ) { XCTFail("An unbound old callback must not reset presentation") })
            XCTAssertEqual(fixture.router.pending, pending)
            XCTAssertEqual(fixture.chat.input, "Keep the unbound invented draft.")
            let accidentalAdoption = fixture.chat.requestModelCheck(in: current)
            XCTAssertNil(accidentalAdoption)
            accidentalAdoption?.cancel()
        }
    }

    func testAnOlderRequestCallbackCannotConsumeItsSameContextReplacement() async throws {
        try await withFixture { fixture in
            let context = try fixture.bind()
            fixture.chat.attach(context.api, context: context)
            fixture.chat.prepareLocalDraft(question: "Preserve this existing local draft.")
            fixture.router.enqueue(question: "The older observed request.")
            let older = fixture.observation(context)
            fixture.router.enqueue(question: "The newer pending request.")
            let pending = fixture.router.pending
            var prepared = 0
            XCTAssertFalse(older.apply(
                to: fixture.chat,
                context: context,
                currentContext: fixture.store.apiContext,
                router: fixture.router
            ) { prepared += 1 })
            XCTAssertEqual(fixture.router.pending, pending)
            XCTAssertEqual(fixture.chat.input, "Preserve this existing local draft.")
            XCTAssertEqual(prepared, 0)
            XCTAssertTrue(fixture.observation(context).apply(
                to: fixture.chat,
                context: context,
                currentContext: fixture.store.apiContext,
                router: fixture.router
            ) { prepared += 1 })
            XCTAssertNil(fixture.router.pending)
            XCTAssertEqual(fixture.chat.input, "The newer pending request.")
            XCTAssertEqual(prepared, 1)
        }
    }

    func testReusingTheApiObjectDoesNotReviveAnOlderObservation() async throws {
        try await withFixture { fixture in
            let first = try fixture.bind()
            fixture.router.enqueue(question: "An observed request before replacement.")
            let observation = fixture.observation(first)
            _ = try fixture.bind()
            let current = try fixture.bind(api: first.api)
            fixture.router.enqueue(question: "The new incarnation's pending request.")
            let pending = fixture.router.pending
            XCTAssertFalse(observation.apply(
                to: fixture.chat,
                context: first,
                currentContext: fixture.store.apiContext,
                router: fixture.router
            ) { XCTFail("A retired observation must not reset presentation") })
            XCTAssertTrue(current.api === first.api)
            XCTAssertFalse(current === first)
            XCTAssertEqual(fixture.router.pending, pending)
        }
    }

    func testObservedContextMustMatchTheCapturedContextEvenWhenItIsCurrent() async throws {
        try await withFixture { fixture in
            let older = try fixture.bind(), current = try fixture.bind()
            fixture.router.enqueue(question: "A current pending request.")
            let pending = fixture.router.pending
            for mismatched in [
                DesktopDraftObservation(context: ObjectIdentifier(older), request: pending?.id),
                DesktopDraftObservation(context: nil, request: nil),
                DesktopDraftObservation(context: ObjectIdentifier(current), request: nil),
            ] {
                XCTAssertFalse(mismatched.apply(
                    to: fixture.chat,
                    context: current,
                    currentContext: fixture.store.apiContext,
                    router: fixture.router
                ) { XCTFail("The changed value must identify this callback") })
                XCTAssertEqual(fixture.router.pending, pending)
            }
        }
    }

    func testNoApiLeavesTheExactUnclaimedRequestPending() async {
        await withFixture { fixture in
            fixture.router.enqueue(question: "Wait for a verified library.")
            let pending = fixture.router.pending
            let observation = DesktopDraftObservation(context: nil, request: pending?.id)
            XCTAssertFalse(observation
                .apply(to: fixture.chat, context: nil, currentContext: nil, router: fixture.router) {
                    XCTFail("A missing library cannot prepare a draft")
                })
            XCTAssertEqual(fixture.router.pending, pending)
        }
    }

    func testCurrentNoRequestStillAttachesWithoutPreparingPresentationOrErasingASameBindingDraft() async throws {
        try await withFixture { fixture in
            let context = try fixture.bind()
            fixture.chat.prepareLocalDraft(question: "A draft from before binding.")
            var prepared = 0
            XCTAssertFalse(fixture.observation(context).apply(
                to: fixture.chat,
                context: context,
                currentContext: fixture.store.apiContext,
                router: fixture.router
            ) { prepared += 1 })
            XCTAssertEqual(fixture.chat.input, "", "A genuinely new API binding retains its original reset behavior")
            let attached = fixture.chat.requestModelCheck(in: context)
            XCTAssertNotNil(attached)
            attached?.cancel()
            fixture.chat.prepareLocalDraft(question: "Keep the same binding's local draft.")
            XCTAssertFalse(fixture.observation(context).apply(
                to: fixture.chat,
                context: context,
                currentContext: fixture.store.apiContext,
                router: fixture.router
            ) { prepared += 1 })
            XCTAssertEqual(fixture.chat.input, "Keep the same binding's local draft.")
            XCTAssertEqual(prepared, 0)
        }
    }

    func testCurrentNewClearsTheDraftAndPreparesPresentationBeforeConditionalConsume() async throws {
        try await withFixture { fixture in
            let context = try fixture.bind()
            fixture.chat.attach(context.api, context: context)
            fixture.chat.prepareLocalDraft(question: "An existing invented draft.")
            fixture.router.enqueue(question: nil)
            let pending = fixture.router.pending
            var prepared = 0
            XCTAssertTrue(fixture.observation(context).apply(
                to: fixture.chat,
                context: context,
                currentContext: fixture.store.apiContext,
                router: fixture.router
            ) {
                prepared += 1
                XCTAssertEqual(fixture.router.pending, pending, "Preserve the original preparation then consumption ordering")
                XCTAssertEqual(fixture.chat.input, "")
            })
            XCTAssertNil(fixture.router.pending)
            XCTAssertEqual(prepared, 1)
            XCTAssertFalse(fixture.chat.busy)
            XCTAssertNil(fixture.chat.sessionId)
        }
    }

    private func withFixture(_ operation: @MainActor (DraftBindingFixture) throws -> Void) async rethrows {
        let fixture = DraftBindingFixture()
        defer { fixture.session.invalidateAndCancel() }
        do { try operation(fixture) }
        catch { await fixture.close()
            throw error
        }
        await fixture.close()
    }
}

private final class DraftBindingRefusalProtocol: URLProtocol, @unchecked Sendable {
    override class func canInit(with request: URLRequest) -> Bool {
        true
    }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest {
        request
    }

    override func startLoading() {
        client?.urlProtocol(self, didFailWithError: URLError(.cancelled))
    }

    override func stopLoading() {}
}

@MainActor
private final class DraftBindingFixture {
    let store = DesktopStore(startRuntime: false, monitorPrerequisites: false)
    let router = DesktopActionRouter()
    let chat = DesktopChat()
    let session: URLSession
    private var contexts: [DesktopAPIContext] = []

    init() {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [DraftBindingRefusalProtocol.self]
        session = URLSession(configuration: configuration)
    }

    func bind(api: DesktopAPI? = nil) throws -> DesktopAPIContext {
        let connection = try JSONDecoder().decode(
            DesktopConnection.self,
            from: Data(#"{"url":"http://localhost:17681","token":"fixture-token"}"#.utf8)
        )
        store.api = try api ?? DesktopAPI(connection: connection, sessionOverride: session)
        let context = try XCTUnwrap(store.apiContext)
        contexts.append(context)
        return context
    }

    func observation(_ context: DesktopAPIContext) -> DesktopDraftObservation {
        DesktopDraftObservation(context: ObjectIdentifier(context), request: router.pending?.id)
    }

    func close() async {
        store.api = nil
        await chat.stopAndJoin()
        for context in contexts {
            await context.drain()
        }
    }
}
