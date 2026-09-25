// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

/// End-to-end coverage of one ask, driven through a stubbed transport:
/// what the runner asks the gateway for, how it spends its budget across
/// the steps, and what it says when a step never answers.
///
/// These are the properties that decide whether a follow-up works. A
/// follow-up resumes the thread the previous ask left behind, which is
/// the only path where the session-create call returns anything large and
/// the only one where the budget has to survive it.
final class SiriAskRunnerTests: XCTestCase {
    override func setUp() {
        super.setUp()
        StubGatewayProtocol.reset()
    }

    override func tearDown() {
        StubGatewayProtocol.reset()
        super.tearDown()
    }

    // MARK: - Harness

    private func pairingService() throws -> PairingService {
        let store = InMemoryStore()
        try store.set("https://gateway.example.com", forKey: "gateway.url")
        try store.set("test-token", forKey: "gateway.token")
        try store.set("account-1", forKey: "gateway.accountId")
        try store.set("Test Gateway", forKey: "gateway.name")
        return PairingService(store: store)
    }

    /// A continuity store on a throwaway defaults suite, plus the means to
    /// drop that suite when the test ends.
    private struct Continuity {
        let store: SiriAskContinuityStore
        let defaults: UserDefaults
        let suite: String

        func discard() {
            defaults.removePersistentDomain(forName: suite)
        }
    }

    private func continuityStore(
        resuming conversationId: String?,
        now: @escaping @Sendable () -> Date
    ) throws
        -> Continuity {
        let name = "siri-ask-runner-tests-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: name))
        let store = SiriAskContinuityStore(defaults: defaults, now: now)
        if let conversationId { store.record(conversationId: conversationId) }
        return Continuity(store: store, defaults: defaults, suite: name)
    }

    private func runner(
        pairing: PairingService,
        continuity: SiriAskContinuityStore,
        budget: TimeInterval,
        settleGrace: TimeInterval = 0.5,
        now: @escaping @Sendable () -> Date
    )
        -> SiriAskRunner {
        SiriAskRunner(
            pairing: pairing,
            continuity: continuity,
            budget: budget,
            settleGrace: settleGrace,
            now: now,
            makeClient: { url, token in
                let config = URLSessionConfiguration.ephemeral
                config.protocolClasses = [StubGatewayProtocol.self]
                return AgentClient(
                    baseURL: url,
                    token: token,
                    session: URLSession(configuration: config)
                )
            }
        )
    }

    // MARK: - What a resume asks for

    /// The whole point of the resume path: take the session, not the
    /// thread. A thread whose previous turn searched carries every result
    /// it collected, and downloading it is time the ask does not have.
    func testAFollowUpResumesTheThreadWithoutFetchingIt() async throws {
        let clock = FrozenClock()
        let pairing = try pairingService()
        let continuity = try continuityStore(resuming: "conv-1", now: { clock.now })
        defer { continuity.discard() }
        StubGatewayProtocol.answerTurn(
            sessionId: "conv-1",
            text: "Friday at nine forty.",
            priorMessageCount: 12
        )

        let outcome = await runner(
            pairing: pairing,
            continuity: continuity.store,
            budget: 45,
            now: { clock.now }
        ).run(question: "and the one after that?")

        XCTAssertEqual(outcome, .answered(text: "Friday at nine forty."))
        let create = try XCTUnwrap(StubGatewayProtocol.sessionCreates().first)
        XCTAssertEqual(create.url?.query, "transcriptLimit=0")
        let body = try XCTUnwrap(
            JSONSerialization.jsonObject(with: XCTUnwrap(create.stubbedBody)) as? [String: Any]
        )
        XCTAssertEqual(body["resumeFromId"] as? String, "conv-1")
        XCTAssertEqual(body["profile"] as? String, "voice")
    }

    /// A first ask has no thread to resume, so it sends no cap — the
    /// request is the one a build predating the cap would send.
    func testAFirstAskCreatesAFreshSessionWithNoCap() async throws {
        let clock = FrozenClock()
        let pairing = try pairingService()
        let continuity = try continuityStore(resuming: nil, now: { clock.now })
        defer { continuity.discard() }
        StubGatewayProtocol.answerTurn(sessionId: "sess-new", text: "Nothing tomorrow.")

        let outcome = await runner(
            pairing: pairing,
            continuity: continuity.store,
            budget: 20,
            now: { clock.now }
        ).run(question: "anything tomorrow?")

        XCTAssertEqual(outcome, .answered(text: "Nothing tomorrow."))
        let create = try XCTUnwrap(StubGatewayProtocol.sessionCreates().first)
        XCTAssertNil(create.url?.query)
    }

    func testAForbiddenVoiceSessionRequestsRepairingWithAnAuthorizedToken() async throws {
        let clock = FrozenClock()
        let pairing = try pairingService()
        let continuity = try continuityStore(resuming: nil, now: { clock.now })
        defer { continuity.discard() }
        StubGatewayProtocol.rejectSessionCreate(status: 403)

        let outcome = await runner(
            pairing: pairing,
            continuity: continuity.store,
            budget: 20,
            now: { clock.now }
        ).run(question: "anything tomorrow?")

        XCTAssertEqual(outcome, .unauthorized)
    }

    /// A gateway too old to serve an empty transcript page rejects the
    /// request outright. Continuity matters more than the bytes: the ask
    /// asks again for the whole thread rather than dropping the follow-up
    /// into a conversation with no memory of what it follows up on.
    func testAnOlderGatewayKeepsTheThreadRatherThanTheSaving() async throws {
        let clock = FrozenClock()
        let pairing = try pairingService()
        let continuity = try continuityStore(resuming: "conv-1", now: { clock.now })
        defer { continuity.discard() }
        StubGatewayProtocol.rejectCappedResume()
        StubGatewayProtocol.answerTurn(
            sessionId: "conv-1",
            text: "Still Friday.",
            priorMessageCount: 12
        )

        let outcome = await runner(
            pairing: pairing,
            continuity: continuity.store,
            budget: 45,
            now: { clock.now }
        ).run(question: "and the one after that?")

        XCTAssertEqual(outcome, .answered(text: "Still Friday."))
        let creates = StubGatewayProtocol.sessionCreates()
        XCTAssertEqual(creates.count, 2)
        XCTAssertEqual(creates[0].url?.query, "transcriptLimit=0")
        // The retry is a resume, not a fresh session — that is the thread
        // being kept.
        XCTAssertNil(creates[1].url?.query)
        let retried = try XCTUnwrap(
            JSONSerialization.jsonObject(with: XCTUnwrap(creates[1].stubbedBody)) as? [String: Any]
        )
        XCTAssertEqual(retried["resumeFromId"] as? String, "conv-1")
    }

    // MARK: - How the budget is spent

    /// Reaching the gateway spends the same budget the turn does, and what
    /// is left is what the push is armed on — so a slow resume shortens
    /// the wait instead of extending the ask past the caller waiting on it.
    func testSetupTimeShortensTheWaitAndThePushTogether() async throws {
        let clock = FrozenClock()
        let pairing = try pairingService()
        let continuity = try continuityStore(resuming: "conv-1", now: { clock.now })
        defer { continuity.discard() }
        // A resume that took twelve seconds of a forty-five second budget.
        StubGatewayProtocol.onSessionCreate { clock.advance(12) }
        StubGatewayProtocol.answerTurn(
            sessionId: "conv-1",
            text: "Friday.",
            priorMessageCount: 12
        )

        _ = await runner(
            pairing: pairing,
            continuity: continuity.store,
            budget: 45,
            now: { clock.now }
        ).run(question: "and the one after that?")

        let send = try XCTUnwrap(StubGatewayProtocol.sends().first)
        let body = try XCTUnwrap(
            JSONSerialization.jsonObject(with: XCTUnwrap(send.stubbedBody)) as? [String: Any]
        )
        XCTAssertEqual(body["notifyAfterMs"] as? Int, 33000)
        XCTAssertEqual(body["viewingForMs"] as? Int, 33500)
    }

    /// A gateway that accepts the connection and then never answers must
    /// not hold the ask past its budget. Nothing in the transport gives up
    /// this early, so the ask gives up itself — and says the gateway
    /// couldn't be reached, which is what happened, rather than promising
    /// a notification for a question it never managed to post.
    func testAStalledSetupEndsTheAskInsteadOfOutlastingIt() async throws {
        let clock = FrozenClock()
        let pairing = try pairingService()
        let continuity = try continuityStore(resuming: nil, now: { clock.now })
        defer { continuity.discard() }
        StubGatewayProtocol.stallSessionCreate()

        let started = Date()
        let outcome = await runner(
            pairing: pairing,
            continuity: continuity.store,
            budget: 0.5,
            now: { clock.now }
        ).run(question: "anything tomorrow?")

        XCTAssertEqual(outcome, .unreachable)
        XCTAssertLessThan(Date().timeIntervalSince(started), 5)
        XCTAssertTrue(StubGatewayProtocol.sends().isEmpty)
    }

    /// The wait a slow setup left, not the budget it started with. A turn
    /// that never settles has to be abandoned at the shortened deadline —
    /// waiting out the original one is how the ask overruns the caller,
    /// which is the whole failure this budget exists to prevent.
    func testTheTurnIsAbandonedAtTheShortenedDeadline() async throws {
        let clock = FrozenClock()
        let pairing = try pairingService()
        let continuity = try continuityStore(resuming: nil, now: { clock.now })
        defer { continuity.discard() }
        // Ten of the twelve seconds are gone before the question is posted.
        StubGatewayProtocol.onSessionCreate { clock.advance(10) }
        StubGatewayProtocol.acceptSendThenStall(sessionId: "sess-new")

        let started = Date()
        let outcome = await runner(
            pairing: pairing,
            continuity: continuity.store,
            budget: 12,
            now: { clock.now }
        ).run(question: "anything tomorrow?")
        let elapsed = Date().timeIntervalSince(started)

        XCTAssertEqual(outcome, .stillWorking)
        // Two seconds left plus the grace — not the full twelve.
        XCTAssertLessThan(elapsed, 6)
    }

    /// A turn that outlives the wait is not a failure — the send armed a
    /// push for exactly this case, so the ask hands off to it.
    func testATurnThatOutlivesTheWaitDefersToThePush() async throws {
        let clock = FrozenClock()
        let pairing = try pairingService()
        let continuity = try continuityStore(resuming: nil, now: { clock.now })
        defer { continuity.discard() }
        StubGatewayProtocol.acceptSendThenStall(sessionId: "sess-new")

        let outcome = await runner(
            pairing: pairing,
            continuity: continuity.store,
            budget: 0.5,
            now: { clock.now }
        ).run(question: "anything tomorrow?")

        XCTAssertEqual(outcome, .stillWorking)
        XCTAssertFalse(StubGatewayProtocol.sends().isEmpty)
    }

    // MARK: - A queued watch ask

    /// Nobody is waiting on a question the watch queued, so how it ends has to
    /// reach the user as a notification. The send arms the shortest push
    /// budget the gateway accepts and takes no read-state lease; a turn that
    /// settles inside that budget gets no push, so the runner reports it.
    func testAQueuedAskThatSettlesInsideThePushBudgetReturnsItsAnswer() async throws {
        let clock = FrozenClock()
        let pairing = try pairingService()
        let continuity = try continuityStore(resuming: nil, now: { clock.now })
        defer { continuity.discard() }
        StubGatewayProtocol.answerTurn(sessionId: "sess-new", text: "Nothing tomorrow.")

        let handed = await runner(
            pairing: pairing,
            continuity: continuity.store,
            budget: 20,
            now: { clock.now }
        ).handOff(question: "anything tomorrow?")

        XCTAssertEqual(handed.outcome, .answered(text: "Nothing tomorrow."))
        XCTAssertEqual(handed.conversationId, "sess-new")
        let send = try XCTUnwrap(StubGatewayProtocol.sends().first)
        let body = try XCTUnwrap(
            JSONSerialization.jsonObject(with: XCTUnwrap(send.stubbedBody)) as? [String: Any]
        )
        XCTAssertEqual(body["notifyAfterMs"] as? Int, 1000)
        XCTAssertNil(body["viewingForMs"])
        XCTAssertEqual(body["text"] as? String, "anything tomorrow?")
        // A follow-up asked live afterwards continues this conversation.
        XCTAssertEqual(continuity.store.conversationToResume(), "sess-new")
    }

    /// A turn still running when the push budget ends is the gateway's push
    /// to announce: the runner stops following it within about that budget.
    func testAQueuedAskStillRunningIsLeftToThePush() async throws {
        let clock = FrozenClock()
        let pairing = try pairingService()
        let continuity = try continuityStore(resuming: nil, now: { clock.now })
        defer { continuity.discard() }
        StubGatewayProtocol.acceptSendThenStall(sessionId: "sess-new")

        let started = Date()
        let handed = await runner(
            pairing: pairing,
            continuity: continuity.store,
            budget: 20,
            now: { clock.now }
        ).handOff(question: "anything tomorrow?")

        XCTAssertEqual(handed.outcome, .stillWorking)
        XCTAssertEqual(handed.conversationId, "sess-new")
        XCTAssertLessThan(Date().timeIntervalSince(started), 5)
    }

    /// A live ask behind a running turn tells its caller to ask again. A
    /// queued one has nobody to tell, so it goes to a fresh conversation
    /// rather than being dropped.
    func testAQueuedAskBehindARunningTurnStartsAFreshConversation() async throws {
        let clock = FrozenClock()
        let pairing = try pairingService()
        let continuity = try continuityStore(resuming: "conv-1", now: { clock.now })
        defer { continuity.discard() }
        StubGatewayProtocol.answerTurn(sessionId: "sess-fresh", text: "Friday.")
        StubGatewayProtocol.resumeIsBusy(sessionId: "conv-1")

        let handed = await runner(
            pairing: pairing,
            continuity: continuity.store,
            budget: 20,
            now: { clock.now }
        ).handOff(question: "and the one after that?")

        XCTAssertEqual(handed.outcome, .answered(text: "Friday."))
        let creates = StubGatewayProtocol.sessionCreates()
        XCTAssertEqual(creates.count, 2)
        let fresh = try XCTUnwrap(
            JSONSerialization.jsonObject(with: XCTUnwrap(creates[1].stubbedBody)) as? [String: Any]
        )
        XCTAssertNil(fresh["resumeFromId"])
        let send = try XCTUnwrap(StubGatewayProtocol.sends().first)
        XCTAssertEqual(send.url?.path, "/agent/sessions/sess-fresh/messages")
        XCTAssertEqual(continuity.store.conversationToResume(), "sess-fresh")
    }

    func testAQueuedAskOnAnUnpairedPhoneIsNotSent() async throws {
        let clock = FrozenClock()
        let continuity = try continuityStore(resuming: nil, now: { clock.now })
        defer { continuity.discard() }

        let handed = await runner(
            pairing: PairingService(store: InMemoryStore()),
            continuity: continuity.store,
            budget: 20,
            now: { clock.now }
        ).handOff(question: "anything tomorrow?")

        XCTAssertEqual(handed.outcome, .notPaired)
        XCTAssertNil(handed.conversationId)
        XCTAssertTrue(StubGatewayProtocol.sends().isEmpty)
    }

    func testAQueuedAskWhoseSendFailsSaysSo() async throws {
        let clock = FrozenClock()
        let pairing = try pairingService()
        let continuity = try continuityStore(resuming: nil, now: { clock.now })
        defer { continuity.discard() }
        StubGatewayProtocol.answerTurn(sessionId: "sess-new", text: "unused")
        StubGatewayProtocol.rejectSend(status: 500)

        let handed = await runner(
            pairing: pairing,
            continuity: continuity.store,
            budget: 20,
            now: { clock.now }
        ).handOff(question: "anything tomorrow?")

        XCTAssertEqual(handed.outcome, .sendFailed)
        XCTAssertNil(continuity.store.conversationToResume())
    }

    /// The whole hand-off is bounded by the runner's budget, so a gateway that
    /// never answers cannot outlast the background time a queued launch gets.
    func testAStalledQueuedAskEndsWithinItsBudget() async throws {
        let clock = FrozenClock()
        let pairing = try pairingService()
        let continuity = try continuityStore(resuming: nil, now: { clock.now })
        defer { continuity.discard() }
        StubGatewayProtocol.stallSessionCreate()

        let started = Date()
        let handed = await runner(
            pairing: pairing,
            continuity: continuity.store,
            budget: 0.5,
            now: { clock.now }
        ).handOff(question: "anything tomorrow?")

        XCTAssertEqual(handed.outcome, .unreachable)
        XCTAssertLessThan(Date().timeIntervalSince(started), 5)
        XCTAssertTrue(StubGatewayProtocol.sends().isEmpty)
    }
}

/// A clock the test moves by hand, so budget arithmetic is decided by the
/// test rather than by how long the stub took.
private final class FrozenClock: @unchecked Sendable {
    private let lock = NSLock()
    private var current = Date(timeIntervalSince1970: 1_700_000_000)

    var now: Date {
        lock.lock()
        defer { lock.unlock() }
        return current
    }

    func advance(_ seconds: TimeInterval) {
        lock.lock()
        defer { lock.unlock() }
        current = current.addingTimeInterval(seconds)
    }
}

extension URLRequest {
    /// `URLProtocol` moves a request body into a stream, so the bytes have
    /// to be read back from `httpBodyStream` rather than `httpBody`.
    fileprivate var stubbedBody: Data? {
        if let httpBody { return httpBody }
        guard let stream = httpBodyStream else { return nil }
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable {
            let read = stream.read(&buffer, maxLength: buffer.count)
            if read <= 0 { break }
            data.append(contentsOf: buffer[0 ..< read])
        }
        return data
    }
}

/// In-process gateway for the runner: answers session-create, send and
/// event-stream calls, records every request, and can be told to stall or
/// to reject a capped resume the way an older gateway does.
final class StubGatewayProtocol: URLProtocol, @unchecked Sendable {
    private struct State {
        var requests: [URLRequest] = []
        var sessionId = "sess-new"
        var priorMessageCount = 0
        var answer: String?
        var rejectCapped = false
        var rejectCreateStatus: Int?
        var stallCreate = false
        var stallAfterSend = false
        var busyResumeId: String?
        var rejectSendStatus: Int?
        var onSessionCreate: (@Sendable () -> Void)?
    }

    /// The assistant message id every turn runs under. Known up front, so
    /// the event stream can be served the moment it is attached.
    static let messageId = "m-1"

    private nonisolated(unsafe) static var state = State()
    private static let lock = NSLock()

    private static func mutate<T>(_ body: (inout State) -> T) -> T {
        lock.lock()
        defer { lock.unlock() }
        return body(&state)
    }

    static func reset() {
        mutate { $0 = State() }
    }

    /// Serve a turn that streams `text` and ends, over a conversation that
    /// already held `priorMessageCount` messages.
    static func answerTurn(sessionId: String, text: String, priorMessageCount: Int = 0) {
        mutate {
            $0.sessionId = sessionId
            $0.answer = text
            $0.priorMessageCount = priorMessageCount
        }
    }

    /// Reject `transcriptLimit=0` with a 400, as a gateway predating the
    /// empty-transcript page does.
    static func rejectCappedResume() {
        mutate { $0.rejectCapped = true }
    }

    static func rejectSessionCreate(status: Int) {
        mutate { $0.rejectCreateStatus = status }
    }

    /// Accept the connection for session-create and then never answer.
    static func stallSessionCreate() {
        mutate { $0.stallCreate = true }
    }

    /// Accept the question, then leave the turn running forever.
    static func acceptSendThenStall(sessionId: String) {
        mutate {
            $0.sessionId = sessionId
            $0.stallAfterSend = true
        }
    }

    /// Answer a resume of `sessionId` as a conversation whose previous turn is
    /// still running; a fresh create is served as usual.
    static func resumeIsBusy(sessionId: String) {
        mutate { $0.busyResumeId = sessionId }
    }

    static func rejectSend(status: Int) {
        mutate { $0.rejectSendStatus = status }
    }

    /// Called on each session-create, before the response is built — the
    /// hook a test uses to spend budget on the setup step.
    static func onSessionCreate(_ hook: @escaping @Sendable () -> Void) {
        mutate { $0.onSessionCreate = hook }
    }

    /// Session-create calls only — `/agent/sessions/:id/messages` shares
    /// the prefix, so matching on it would count the send as a create.
    static func sessionCreates() -> [URLRequest] {
        mutate {
            $0.requests.filter { $0.url?.path == "/agent/sessions" }
        }
    }

    static func sends() -> [URLRequest] {
        mutate {
            $0.requests.filter { $0.url?.path.hasSuffix("/messages") ?? false }
        }
    }

    // URLProtocol's overrides must be class funcs (they override class
    // methods), so `static` isn't possible here.
    // swiftlint:disable:next static_over_final_class
    override class func canInit(with _: URLRequest) -> Bool {
        true
    }

    // swiftlint:disable:next static_over_final_class
    override class func canonicalRequest(for request: URLRequest) -> URLRequest {
        request
    }

    override func startLoading() {
        let request = self.request
        Self.mutate { $0.requests.append(request) }
        let path = request.url?.path ?? ""
        let query = request.url?.query

        if path == "/agent/events" {
            // A stalled turn is a stream that stays open saying nothing;
            // an answered one streams its text and ends the message. The
            // stream is left open either way, so the engine folds it
            // rather than seeing EOF and re-attaching.
            if Self.mutate({ $0.stallAfterSend }) {
                openStream()
                return
            }
            let sessionId = Self.mutate { $0.sessionId }
            let answer = Self.mutate { $0.answer } ?? ""
            openStream(events: [
                [
                    "type": "agent.text.delta",
                    "payload": [
                        "sessionId": sessionId, "messageId": Self.messageId, "delta": answer,
                    ],
                ],
                [
                    "type": "agent.message.end",
                    "payload": [
                        "sessionId": sessionId, "messageId": Self.messageId,
                        "stopReason": "end_turn",
                    ],
                ],
            ])
            return
        }
        if path == "/agent/sessions" {
            respondToSessionCreate(query: query)
            return
        }
        if path.hasSuffix("/messages") {
            if let status = Self.mutate({ $0.rejectSendStatus }) {
                respond(status: status, body: Data("send rejected".utf8))
                return
            }
            respond(status: 200, json: ["messageId": Self.messageId, "userMessageId": "u-1"])
            return
        }
        if path.hasPrefix("/agent/conversations/") {
            if Self.mutate({ $0.stallAfterSend }) { return }
            let sessionId = Self.mutate { $0.sessionId }
            let answer = Self.mutate { $0.answer } ?? ""
            // The prior turns the ask resumed, then its own — so the
            // engine's index into the transcript has something to land on.
            let prior = (0 ..< Self.mutate { $0.priorMessageCount }).map { index in
                [
                    "role": index.isMultiple(of: 2) ? "user" : "assistant",
                    "parts": [["kind": "text", "text": "earlier"]],
                ]
            }
            respond(status: 200, json: [
                "id": sessionId,
                "callerId": "token:test",
                "model": "test-model",
                "backend": "test-backend",
                "createdAt": "2026-01-01T00:00:00.000Z",
                "updatedAt": "2026-01-01T00:00:00.000Z",
                "title": "test",
                "pinned": false,
                "messages": prior + [
                    ["role": "user", "parts": [["kind": "text", "text": "q"]]],
                    ["role": "assistant", "parts": [["kind": "text", "text": answer]]],
                ],
            ])
            return
        }
        respond(status: 404, body: Data())
    }

    override func stopLoading() {}

    /// A session create: stalled, rejected, a busy resume, or a fresh session.
    private func respondToSessionCreate(query: String?) {
        Self.mutate { $0.onSessionCreate }?()
        if Self.mutate({ $0.stallCreate }) { return }
        if let status = Self.mutate({ $0.rejectCreateStatus }) {
            respond(status: status, body: Data("request rejected".utf8))
            return
        }
        if Self.mutate({ $0.rejectCapped }), query == "transcriptLimit=0" {
            respond(status: 400, body: Data("transcript limit must be an integer".utf8))
            return
        }
        let resumeFromId = request.stubbedBody
            .flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }?["resumeFromId"] as? String
        let busyId = Self.mutate { $0.busyResumeId }
        let busy = resumeFromId != nil && resumeFromId == busyId
        let sessionId = busy ? (busyId ?? "") : Self.mutate { $0.sessionId }
        respond(status: 200, json: [
            "sessionId": sessionId,
            "conversationId": sessionId,
            "model": "test-model",
            "backend": "test-backend",
            "messageCount": Self.mutate { $0.priorMessageCount },
            "busy": busy,
            "messages": [],
        ])
    }

    /// Open an SSE response, write each event as a frame, and leave the
    /// stream open — never finishing it, so the engine keeps folding
    /// rather than treating the end as a dropped connection.
    private func openStream(events: [[String: Any]] = []) {
        guard let url = request.url,
              let response = HTTPURLResponse(
                  url: url,
                  statusCode: 200,
                  httpVersion: "HTTP/1.1",
                  headerFields: ["Content-Type": "text/event-stream"]
              )
        else {
            return
        }
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        for event in events {
            guard let data = try? JSONSerialization.data(withJSONObject: event),
                  let json = String(data: data, encoding: .utf8)
            else {
                continue
            }
            client?.urlProtocol(self, didLoad: Data("data: \(json)\n\n".utf8))
        }
    }

    private func respond(status: Int, json: [String: Any]) {
        respond(status: status, body: (try? JSONSerialization.data(withJSONObject: json)) ?? Data())
    }

    private func respond(status: Int, body: Data) {
        guard let url = request.url,
              let response = HTTPURLResponse(
                  url: url,
                  statusCode: status,
                  httpVersion: "HTTP/1.1",
                  headerFields: ["Content-Type": "application/json"]
              )
        else {
            return
        }
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: body)
        client?.urlProtocolDidFinishLoading(self)
    }
}
