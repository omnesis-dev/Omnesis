// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

/// Deterministic coverage of `VoiceAnswerEngine`'s exits: terminal
/// outcome first, budget first (with and without a settled transcript),
/// premature stream end followed by a replayed re-attach, stream end
/// running into the deadline, foreign-turn filtering, and the
/// transcript-over-deltas preference on completion.
///
/// Determinism comes from how each scenario scripts `Effects.sleep`:
/// a sleep that parks until cancellation makes the stream fold the only
/// task that can win the race; a sleep that returns immediately makes
/// the deadline the only winner against a never-ending stream. The fake
/// clock only moves when a scripted sleep advances it.
final class VoiceAnswerEngineTests: XCTestCase {
    private let sessionId = "sess-voice-1"
    private let messageId = "m-watched"

    /// Lock-guarded fake clock the scripted sleeps advance.
    private final class Clock: @unchecked Sendable {
        private let lock = NSLock()
        private var date = Date(timeIntervalSince1970: 1_000_000)

        func now() -> Date {
            lock.lock()
            defer { lock.unlock() }
            return date
        }

        func advance(_ seconds: TimeInterval) {
            lock.lock()
            date = date.addingTimeInterval(seconds)
            lock.unlock()
        }
    }

    /// Suspend until cancelled — the "this side must lose the race" sleep.
    private static let park: @Sendable (TimeInterval) async throws -> Void = { _ in
        try await Task.sleep(nanoseconds: 3_600_000_000_000)
    }

    private struct FetchFailed: Error {}

    private func item(_ event: AgentEvent, id: String? = nil) -> AgentStreamItem {
        AgentStreamItem(id: id, event: event)
    }

    private func finishedStream(
        _ items: [AgentStreamItem],
        throwing error: Error? = nil
    )
        -> AsyncThrowingStream<AgentStreamItem, Error> {
        AsyncThrowingStream { continuation in
            for item in items {
                continuation.yield(item)
            }
            if let error {
                continuation.finish(throwing: error)
            } else {
                continuation.finish()
            }
        }
    }

    /// A stream that yields its items and then stays open forever (the
    /// turn is still running).
    private func openStream(_ items: [AgentStreamItem]) -> AsyncThrowingStream<AgentStreamItem, Error> {
        AsyncThrowingStream { continuation in
            for item in items {
                continuation.yield(item)
            }
        }
    }

    private func makeEngine(
        priorMessageCount: Int = 0,
        budget: TimeInterval = 100,
        reattachDelay: TimeInterval = 0.25,
        attach: @escaping @Sendable (String?) -> AsyncThrowingStream<AgentStreamItem, Error> = { _ in
            AsyncThrowingStream { $0.finish() }
        },
        loadTranscript: @escaping @Sendable () async throws -> [ChatMessage] = { throw FetchFailed() },
        now: @escaping @Sendable () -> Date = { Date(timeIntervalSince1970: 1_000_000) },
        sleep: @escaping @Sendable (TimeInterval) async throws -> Void = VoiceAnswerEngineTests.park,
        onActivity: (@Sendable (SiriAskActivityEvent) -> Void)? = nil
    )
        -> VoiceAnswerEngine {
        VoiceAnswerEngine(
            sessionId: sessionId,
            messageId: messageId,
            priorMessageCount: priorMessageCount,
            budget: budget,
            reattachDelay: reattachDelay,
            effects: .init(
                attach: attach,
                loadTranscript: loadTranscript,
                now: now,
                sleep: sleep,
                onActivity: onActivity
            )
        )
    }

    /// Thread-safe collector for the tools an engine announces.
    private final class ToolLog: @unchecked Sendable {
        private let lock = NSLock()
        private var tools: [String] = []

        func record(_ tool: String) {
            lock.lock()
            tools.append(tool)
            lock.unlock()
        }

        var recorded: [String] {
            lock.lock()
            defer { lock.unlock() }
            return tools
        }
    }

    private final class ActivityLog: @unchecked Sendable {
        private let lock = NSLock()
        private var events: [SiriAskActivityEvent] = []

        func record(_ event: SiriAskActivityEvent) {
            lock.lock()
            events.append(event)
            lock.unlock()
        }

        var recorded: [SiriAskActivityEvent] {
            lock.lock()
            defer { lock.unlock() }
            return events
        }
    }

    private func transcript(question: String, answer: String?) -> [ChatMessage] {
        var messages: [ChatMessage] = [.user(parts: [.text(question)])]
        if let answer {
            messages.append(.assistant(parts: [.text(answer)]))
        }
        return messages
    }

    // MARK: - Terminal outcome first

    /// The watched turn completes before the deadline; the persisted
    /// transcript is preferred over the accumulated deltas (it also
    /// covers deltas an attach may have missed).
    func testTerminalOutcomePrefersPersistedTranscript() async {
        let stream = finishedStream([
            item(.textDelta(sessionId: sessionId, messageId: messageId, delta: "Your next meeting")),
            item(.messageEnd(sessionId: sessionId, messageId: messageId, stopReason: "end_turn")),
        ])
        let full = transcript(question: "when is my next meeting", answer: "Your next meeting is at three.")
        let engine = makeEngine(loadTranscript: { full })
        let resolution = await engine.run(initialStream: stream)
        XCTAssertEqual(resolution, .answered(text: "Your next meeting is at three."))
    }

    /// When the transcript fetch fails, the accumulated deltas are the
    /// fallback answer.
    func testTerminalOutcomeFallsBackToAccumulatedOnFetchFailure() async {
        let stream = finishedStream([
            item(.textDelta(sessionId: sessionId, messageId: messageId, delta: "Sunny, ")),
            item(.textDelta(sessionId: sessionId, messageId: messageId, delta: "21 degrees.")),
            item(.messageEnd(sessionId: sessionId, messageId: messageId, stopReason: "end_turn")),
        ])
        let engine = makeEngine()
        let resolution = await engine.run(initialStream: stream)
        XCTAssertEqual(resolution, .answered(text: "Sunny, 21 degrees."))
    }

    /// A gateway `agent.error` for the watched turn resolves to failure
    /// without consulting the transcript.
    func testTurnErrorResolvesToFailure() async {
        let stream = finishedStream([
            item(.error(
                sessionId: sessionId,
                messageId: messageId,
                code: "backend_unavailable",
                message: "model backend closed the stream",
                provider: nil
            )),
        ])
        let engine = makeEngine()
        let resolution = await engine.run(initialStream: stream)
        XCTAssertEqual(resolution, .failed(code: "backend_unavailable", message: "model backend closed the stream"))
    }

    /// Same-session events for OTHER turns — arriving before the watched
    /// message's events — neither terminate the fold nor pollute the
    /// answer.
    func testForeignTurnEventsAreFilteredOut() async {
        let stream = finishedStream([
            item(.textDelta(sessionId: sessionId, messageId: "m-prev", delta: "stale answer")),
            item(.messageEnd(sessionId: sessionId, messageId: "m-prev", stopReason: "end_turn")),
            item(.textDelta(sessionId: sessionId, messageId: messageId, delta: "Fresh answer.")),
            item(.messageEnd(sessionId: sessionId, messageId: messageId, stopReason: "end_turn")),
        ])
        let engine = makeEngine()
        let resolution = await engine.run(initialStream: stream)
        XCTAssertEqual(resolution, .answered(text: "Fresh answer."))
    }

    // MARK: - Budget first

    /// The turn outlives the budget and the transcript shows it still
    /// running → the armed push owns delivery.
    func testBudgetElapsedWithoutSettledTranscriptResolvesStillWorking() async {
        let stream = openStream([
            item(.textDelta(sessionId: sessionId, messageId: messageId, delta: "Working on")),
        ])
        let pending = transcript(question: "summarise my week", answer: nil)
        let engine = makeEngine(
            loadTranscript: { pending },
            sleep: { _ in }
        )
        let resolution = await engine.run(initialStream: stream)
        XCTAssertEqual(resolution, .stillWorking)
    }

    /// The turn settled inside the budget but its terminal event never
    /// reached us (dropped stream): the transcript check at the deadline
    /// speaks the settled answer instead of promising a push that will
    /// never fire.
    func testBudgetElapsedWithSettledTranscriptSpeaksTheAnswer() async {
        let stream = openStream([])
        let settled = transcript(question: "when is my next meeting", answer: "It's at three tomorrow.")
        let engine = makeEngine(
            loadTranscript: { settled },
            sleep: { _ in }
        )
        let resolution = await engine.run(initialStream: stream)
        XCTAssertEqual(resolution, .answered(text: "It's at three tomorrow."))
    }

    /// A transcript fetch failure at the deadline degrades to the push
    /// promise.
    func testBudgetElapsedWithFetchFailureResolvesStillWorking() async {
        let engine = makeEngine(sleep: { _ in })
        let resolution = await engine.run(initialStream: openStream([]))
        XCTAssertEqual(resolution, .stillWorking)
    }

    // MARK: - Premature stream end

    /// A stream that drops mid-turn re-attaches with the last seen SSE
    /// id (replay), and the fold's accumulation carries across the
    /// re-attach.
    func testStreamEndThenReattachResumesWithReplay() async {
        let sid = sessionId
        let mid = messageId
        let first = finishedStream([
            item(.textDelta(sessionId: sid, messageId: mid, delta: "Your meeting "), id: "7"),
        ])
        let attachedWith = AttachRecorder()
        let engine = makeEngine(
            reattachDelay: 0.25,
            attach: { lastEventId in
                attachedWith.record(lastEventId)
                return AsyncThrowingStream { continuation in
                    continuation.yield(AgentStreamItem(
                        id: "8",
                        event: .textDelta(sessionId: sid, messageId: mid, delta: "is at three.")
                    ))
                    continuation.yield(AgentStreamItem(
                        id: "9",
                        event: .messageEnd(sessionId: sid, messageId: mid, stopReason: "end_turn")
                    ))
                    continuation.finish()
                }
            },
            sleep: { seconds in
                // The re-attach backoff returns; the deadline sleep parks.
                if seconds > 1 { try await Self.park(seconds) }
            }
        )
        let resolution = await engine.run(initialStream: first)
        XCTAssertEqual(resolution, .answered(text: "Your meeting is at three."))
        XCTAssertEqual(attachedWith.calls(), ["7"], "the re-attach must replay past the last seen SSE id")
    }

    /// A stream drop whose backoff runs into the deadline exits through
    /// the budget-elapsed path (one transcript check, then the push
    /// promise).
    func testStreamEndThenBudgetResolvesStillWorking() async {
        let clock = Clock()
        let pending = transcript(question: "summarise my week", answer: nil)
        let engine = makeEngine(
            budget: 100,
            reattachDelay: 0.25,
            loadTranscript: { pending },
            now: { clock.now() },
            sleep: { seconds in
                if seconds > 1 {
                    try await Self.park(seconds)
                } else {
                    // The backoff burns the rest of the budget.
                    clock.advance(1000)
                }
            }
        )
        let first = finishedStream([
            item(.textDelta(sessionId: sessionId, messageId: messageId, delta: "Working on"), id: "3"),
        ])
        let resolution = await engine.run(initialStream: first)
        XCTAssertEqual(resolution, .stillWorking)
    }

    /// Auth failures are unrecoverable — no re-attach loop, immediate
    /// failure.
    func testUnauthorizedStreamErrorFailsImmediately() async {
        let stream = finishedStream([], throwing: GatewayClient.Error.unauthorized)
        let engine = makeEngine()
        let resolution = await engine.run(initialStream: stream)
        guard case .failed(let code, _) = resolution else {
            return XCTFail("expected .failed, got \(resolution)")
        }
        XCTAssertEqual(code, "stream_unrecoverable")
    }

    // MARK: - Transcript reading

    /// `settledAnswer` only trusts a tail that opens with the ask's user
    /// message and closes with assistant text.
    func testSettledAnswerTailRules() {
        let question = ChatMessage.user(parts: [.text("what's on tomorrow")])
        let reply = ChatMessage.assistant(parts: [.text("Two meetings.")])
        let older = ChatMessage.assistant(parts: [.text("An older answer.")])
        // Settled: user question then assistant reply past the baseline.
        XCTAssertEqual(
            VoiceAnswerEngine.settledAnswer(in: [older, question, reply], priorMessageCount: 1),
            "Two meetings."
        )
        // Still running: the tail ends on the user message.
        XCTAssertNil(VoiceAnswerEngine.settledAnswer(in: [older, question], priorMessageCount: 1))
        // Nothing persisted past the baseline yet.
        XCTAssertNil(VoiceAnswerEngine.settledAnswer(in: [older], priorMessageCount: 1))
        // A baseline undercount must not promote an older assistant
        // answer to "the reply": the tail doesn't open with a user
        // message.
        XCTAssertNil(VoiceAnswerEngine.settledAnswer(in: [older, question, reply], priorMessageCount: 0))
        // An assistant tail without text (tool use only) is not settled.
        let toolOnly = ChatMessage.assistant(parts: [
            .toolUse(toolCallId: "t1", tool: "search", args: JSONAny.null),
        ])
        XCTAssertNil(
            VoiceAnswerEngine.settledAnswer(in: [question, toolOnly], priorMessageCount: 0)
        )
    }

    // MARK: - Progress reporting

    /// The two events that open one call must announce it once between them,
    /// or the watch shows the same step twice for every tool.
    func testOneToolCallIsAnnouncedOnce() async {
        let log = ToolLog()
        let stream = finishedStream([
            item(.toolInputStart(sessionId: sessionId, messageId: messageId, toolCallId: "t1", tool: "search_documents")),
            item(.toolStart(
                sessionId: sessionId,
                messageId: messageId,
                toolCallId: "t1",
                tool: "search_documents",
                args: JSONAny.null,
                argsSummary: nil
            )),
            item(.toolInputStart(sessionId: sessionId, messageId: messageId, toolCallId: "t2", tool: "run_sql")),
            item(.messageEnd(sessionId: sessionId, messageId: messageId, stopReason: "end_turn")),
        ])
        let engine = makeEngine(onActivity: { if case .toolStarted(_, let tool) = $0 { log.record(tool) } })
        _ = await engine.run(initialStream: stream)
        XCTAssertEqual(log.recorded, ["search_documents", "run_sql"])
    }

    /// `/agent/events` is a caller-wide feed: a background brief run or the
    /// user's own phone chat can be mid-turn on the same stream. Their tools
    /// must never be reported as this ask's progress.
    func testToolsFromOtherTurnsAreNotAnnounced() async {
        let log = ToolLog()
        let stream = finishedStream([
            item(.toolInputStart(sessionId: "other-session", messageId: "m-other", toolCallId: "x1", tool: "run_sql")),
            item(.toolInputStart(sessionId: sessionId, messageId: "m-different-turn", toolCallId: "x2", tool: "run_sql")),
            item(.toolInputStart(sessionId: sessionId, messageId: messageId, toolCallId: "mine", tool: "search_documents")),
            item(.messageEnd(sessionId: sessionId, messageId: messageId, stopReason: "end_turn")),
        ])
        let engine = makeEngine(onActivity: { if case .toolStarted(_, let tool) = $0 { log.record(tool) } })
        _ = await engine.run(initialStream: stream)
        XCTAssertEqual(log.recorded, ["search_documents"])
    }

    /// A re-attach replays buffered events. Re-announcing them would walk the
    /// displayed step backwards through work the agent already finished.
    func testReplayedToolsAfterReattachAreNotAnnouncedAgain() async {
        let log = ToolLog()
        let first = finishedStream([
            item(.toolInputStart(sessionId: sessionId, messageId: messageId, toolCallId: "t1", tool: "search_documents"), id: "e1"),
        ])
        // The replay re-delivers t1, then carries the turn forward.
        let replayed: [AgentStreamItem] = [
            item(.toolInputStart(sessionId: sessionId, messageId: messageId, toolCallId: "t1", tool: "search_documents")),
            item(.toolInputStart(sessionId: sessionId, messageId: messageId, toolCallId: "t2", tool: "fetch_document")),
            item(.messageEnd(sessionId: sessionId, messageId: messageId, stopReason: "end_turn")),
        ]
        let engine = makeEngine(
            attach: { _ in
                AsyncThrowingStream { continuation in
                    for replayItem in replayed {
                        continuation.yield(replayItem)
                    }
                    continuation.finish()
                }
            },
            // Short sleep (the re-attach backoff) returns at once; the long
            // one is the budget deadline and must lose the race.
            sleep: { seconds in
                if seconds >= 1 { try await VoiceAnswerEngineTests.park(seconds) }
            },
            onActivity: { if case .toolStarted(_, let tool) = $0 { log.record(tool) } }
        )
        _ = await engine.run(initialStream: first)
        XCTAssertEqual(log.recorded, ["search_documents", "fetch_document"])
    }

    func testWatchedTurnReportsStartAndTerminalSearchAggregate() async {
        let log = ActivityLog()
        let stream = finishedStream([
            item(.messageStart(sessionId: sessionId, messageId: messageId)),
            item(.toolInputStart(sessionId: sessionId, messageId: messageId, toolCallId: "search", tool: "search_documents")),
            item(.toolResult(
                sessionId: sessionId,
                messageId: messageId,
                toolCallId: "search",
                result: .searchResults(query: "private", durationMs: 1, candidates: 2, results: []),
                durationMs: 1
            )),
            item(.messageEnd(sessionId: sessionId, messageId: messageId, stopReason: "end_turn")),
        ])
        let engine = makeEngine(onActivity: { log.record($0) })
        _ = await engine.run(initialStream: stream)
        XCTAssertEqual(log.recorded, [
            .agentStarted,
            .toolStarted(id: "search", tool: "search_documents"),
            .toolFinished(id: "search", outcome: .search(found: 0)),
        ])
    }

    /// The projection carries how much a search returned and nothing about
    /// what it returned — no query, no title, no source identity. The watch
    /// is told the size of the work, never its content.
    func testActivityOutcomeCarriesOnlyResultCounts() {
        let gmail = AgentDocRef(documentId: "doc-1", sourceType: "gmail", sourceId: "gmail:example")
        let drive = AgentDocRef(documentId: "doc-2", sourceType: "google-drive", sourceId: "drive:example")
        let outcome = VoiceAnswerEngine.activityOutcome(for: .searchResults(
            query: "private", durationMs: 1, candidates: 2, results: [gmail, gmail, drive]
        ))
        XCTAssertEqual(outcome, .search(found: 3))
    }
}

/// Lock-guarded recorder for the attach factory's `lastEventId` args.
private final class AttachRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var recorded: [String?] = []

    func record(_ value: String?) {
        lock.lock()
        recorded.append(value)
        lock.unlock()
    }

    func calls() -> [String?] {
        lock.lock()
        defer { lock.unlock() }
        return recorded
    }
}
