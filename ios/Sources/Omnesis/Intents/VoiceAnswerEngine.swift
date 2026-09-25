// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

// Drives the answer-collection phase of a Siri ask: folds the watched
// turn's SSE events through `VoiceAnswerCollector`, survives a
// prematurely-ended stream by re-attaching with `Last-Event-ID` replay
// after a short backoff, and consults the persisted transcript so the
// spoken text is the settled answer rather than a partial delta
// accumulation.
//
// Exits:
//   - **terminal outcome** — the watched turn's `messageEnd` or
//     `error` arrived. On `messageEnd` the persisted transcript is
//     preferred over the accumulated deltas (an attach that raced the
//     turn's first deltas still speaks the full answer); the
//     accumulation is the fallback when the fetch fails.
//   - **budget elapsed** — the transcript is fetched once: a turn that
//     settled inside the budget (its `messageEnd` lost to a stream
//     drop) is spoken directly. Only a turn still running at the
//     deadline resolves to `.stillWorking` — exactly the case where
//     the send's armed `notifyAfterMs` push later delivers the answer.
//   - **unrecoverable stream error** — an auth failure a re-attach
//     cannot fix.
//
// Pure orchestration over injected effects (stream attach, transcript
// fetch, clock, sleep) so the sim-less logic lane can drive every exit
// deterministically. The first stream is attached by the caller
// *before* the question is posted (a fresh SSE attach delivers live
// events only; `AsyncThrowingStream` buffers unconsumed yields), so
// the turn's earliest deltas never fall into the POST→attach gap.

/// Tool calls already announced as progress, shared across the re-attaches of
/// one ask. A replayed stream re-delivers events the caller has already seen,
/// so without a set that outlives the individual stream the wait would walk
/// backwards through steps the agent has finished.
final class AnnouncedTools: @unchecked Sendable {
    private let lock = NSLock()
    private var seen = Set<String>()

    /// True the first time a call id is offered, false every time after.
    func announce(_ toolCallId: String) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return seen.insert(toolCallId).inserted
    }
}

public struct VoiceAnswerEngine: Sendable {
    /// What the intent should speak.
    public enum Resolution: Equatable, Sendable {
        /// The turn settled with this reply (empty when it produced no
        /// spoken text at all).
        case answered(text: String)
        /// The turn died: a gateway `agent.error`, or a stream failure
        /// no re-attach can recover.
        case failed(code: String, message: String)
        /// Budget elapsed with the turn still running — the armed
        /// `notifyAfterMs` push delivers the answer.
        case stillWorking
    }

    /// The engine's side effects, injected so tests can script them.
    public struct Effects: Sendable {
        /// Open a fresh SSE stream against `/agent/events`; a non-nil
        /// `lastEventId` asks the gateway to replay every event it
        /// buffered past that id before attaching the live feed.
        public var attach: @Sendable (_ lastEventId: String?) -> AsyncThrowingStream<AgentStreamItem, Error>
        /// Load the conversation's persisted transcript.
        public var loadTranscript: @Sendable () async throws -> [ChatMessage]
        /// Current time — the budget deadline is measured against this.
        public var now: @Sendable () -> Date
        /// Suspend for an interval. Must respect task cancellation
        /// (return or throw promptly once cancelled) or the deadline
        /// race would leak its losing task.
        public var sleep: @Sendable (_ seconds: TimeInterval) async throws -> Void
        /// Delivers a privacy-safe milestone for the watched turn. Fires on
        /// the stream-consuming task, so it must be cheap and must not block.
        /// Omit when nothing is watching — the on-phone Siri ask speaks only
        /// the final answer.
        public var onActivity: (@Sendable (_ event: SiriAskActivityEvent) -> Void)?

        public init(
            attach: @escaping @Sendable (_ lastEventId: String?) -> AsyncThrowingStream<AgentStreamItem, Error>,
            loadTranscript: @escaping @Sendable () async throws -> [ChatMessage],
            now: @escaping @Sendable () -> Date,
            sleep: @escaping @Sendable (_ seconds: TimeInterval) async throws -> Void,
            onActivity: (@Sendable (_ event: SiriAskActivityEvent) -> Void)? = nil
        ) {
            self.attach = attach
            self.loadTranscript = loadTranscript
            self.now = now
            self.sleep = sleep
            self.onActivity = onActivity
        }
    }

    /// Session whose stream is folded.
    public let sessionId: String
    /// The watched assistant turn — the send response's `messageId`.
    public let messageId: String
    /// Persisted transcript length when the session was created, before
    /// the ask's user message was posted. The ask's own turn is the
    /// transcript tail past this index.
    public let priorMessageCount: Int
    /// How long the caller is willing to wait for a spoken answer.
    public let budget: TimeInterval
    /// Pause before re-attaching after a premature stream end.
    public let reattachDelay: TimeInterval
    private let effects: Effects

    public init(
        sessionId: String,
        messageId: String,
        priorMessageCount: Int,
        budget: TimeInterval,
        reattachDelay: TimeInterval = 0.5,
        effects: Effects
    ) {
        self.sessionId = sessionId
        self.messageId = messageId
        self.priorMessageCount = priorMessageCount
        self.budget = budget
        self.reattachDelay = reattachDelay
        self.effects = effects
    }

    /// Consume streams until one of the documented exits resolves the
    /// ask. `initialStream` is the stream the caller attached before
    /// posting the question.
    public func run(initialStream: AsyncThrowingStream<AgentStreamItem, Error>) async -> Resolution {
        let deadline = effects.now().addingTimeInterval(budget)
        var collector = VoiceAnswerCollector(sessionId: sessionId, messageId: messageId)
        var lastEventId: String?
        var stream = initialStream
        let announced = AnnouncedTools()
        while true {
            switch await race(
                stream: stream,
                collector: collector,
                lastEventId: lastEventId,
                deadline: deadline,
                announced: announced
            ) {
            case .terminal(.answered(let accumulated, _)):
                let settled = await settledTranscriptAnswer()
                return .answered(text: settled ?? accumulated)
            case .terminal(.failed(let code, let message)):
                return .failed(code: code, message: message)
            case .budgetElapsed:
                return await budgetElapsedResolution()
            case .streamEnded(let folded, let resumeId, let error):
                if let error, Self.isUnrecoverable(error) {
                    return .failed(code: "stream_unrecoverable", message: "\(error)")
                }
                collector = folded
                lastEventId = resumeId
                try? await effects.sleep(reattachDelay)
                guard effects.now() < deadline else { return await budgetElapsedResolution() }
                stream = effects.attach(lastEventId)
            }
        }
    }

    // MARK: - Internals

    /// How one stream's consumption ended, relative to the deadline.
    private enum Phase: Sendable {
        case terminal(VoiceAnswerCollector.Outcome)
        /// The stream ended (EOF or transport error) before a terminal
        /// outcome. Carries the fold state and the last SSE id so a
        /// re-attach resumes exactly where this stream dropped.
        case streamEnded(collector: VoiceAnswerCollector, lastEventId: String?, error: Error?)
        case budgetElapsed
    }

    /// Race the stream fold against the remaining budget. First
    /// finisher wins; cancelling the group tears down the losing side
    /// (the SSE iterator's URL task, or the deadline sleep).
    private func race(
        stream: AsyncThrowingStream<AgentStreamItem, Error>,
        collector: VoiceAnswerCollector,
        lastEventId: String?,
        deadline: Date,
        announced: AnnouncedTools
    ) async
        -> Phase {
        let watchedSession = sessionId
        let watchedMessage = messageId
        return await withTaskGroup(of: Phase?.self) { group in
            group.addTask {
                var folded = collector
                var lastId = lastEventId
                do {
                    for try await item in stream {
                        if let id = item.id { lastId = id }
                        if Self.isAgentStart(item.event, sessionId: watchedSession, messageId: watchedMessage) {
                            effects.onActivity?(.agentStarted)
                        }
                        // The two events that open one call (`toolInputStart`
                        // then `toolStart`) announce it once between them.
                        if let started = Self.startedTool(
                            in: item.event,
                            sessionId: watchedSession,
                            messageId: watchedMessage
                        ), announced.announce(started.toolCallId) {
                            effects.onActivity?(.toolStarted(id: started.toolCallId, tool: started.tool))
                        }
                        if let finished = Self.finishedTool(
                            in: item.event,
                            sessionId: watchedSession,
                            messageId: watchedMessage
                        ) {
                            effects.onActivity?(.toolFinished(id: finished.toolCallId, outcome: finished.outcome))
                        }
                        if let outcome = folded.consume(item.event) { return .terminal(outcome) }
                    }
                } catch {
                    guard !Task.isCancelled else { return nil }
                    return .streamEnded(collector: folded, lastEventId: lastId, error: error)
                }
                guard !Task.isCancelled else { return nil }
                return .streamEnded(collector: folded, lastEventId: lastId, error: nil)
            }
            group.addTask {
                let remaining = deadline.timeIntervalSince(effects.now())
                if remaining > 0 { try? await effects.sleep(remaining) }
                guard !Task.isCancelled else { return nil }
                return .budgetElapsed
            }
            var first: Phase?
            while first == nil, let next = await group.next() {
                first = next
            }
            group.cancelAll()
            return first ?? .budgetElapsed
        }
    }

    /// Resolve a spent budget: a turn that settled before the deadline
    /// (per the persisted transcript) is spoken; otherwise the armed
    /// push owns delivery.
    private func budgetElapsedResolution() async -> Resolution {
        if let settled = await settledTranscriptAnswer() { return .answered(text: settled) }
        return .stillWorking
    }

    private func settledTranscriptAnswer() async -> String? {
        guard let messages = try? await effects.loadTranscript() else { return nil }
        return Self.settledAnswer(in: messages, priorMessageCount: priorMessageCount)
    }

    /// The ask's settled reply as persisted, or nil when the transcript
    /// can't prove the turn settled. The ask's turn is the tail past
    /// `priorMessageCount`: it must open with the ask's own user
    /// message (guarding a baseline undercount from promoting an older
    /// turn's answer to "the reply") and end with an assistant message
    /// carrying text — a tail still ending in the user message, or in
    /// an assistant tool-use message without text, means the turn is
    /// still running.
    static func settledAnswer(in messages: [ChatMessage], priorMessageCount: Int) -> String? {
        guard priorMessageCount >= 0, messages.count > priorMessageCount else { return nil }
        let tail = messages.dropFirst(priorMessageCount)
        guard case .user? = tail.first else { return nil }
        guard case .assistant(let parts)? = tail.last else { return nil }
        let textParts = parts.compactMap { part -> String? in
            if case .text(let value) = part { return value }
            return nil
        }
        let text = textParts.joined()
        return text.isEmpty ? nil : text
    }

    /// The tool a stream event opens, if it opens one **for the watched
    /// turn**. `/agent/events` is a caller-wide feed: a background brief run
    /// or the user's own phone chat can be mid-turn on the same stream, and
    /// their tools must never be reported as this ask's progress. Both events
    /// that can open a call carry the name; the caller dedupes on
    /// `toolCallId` so one call is announced once.
    static func startedTool(
        in event: AgentEvent,
        sessionId: String,
        messageId: String
    )
        -> (toolCallId: String, tool: String)? {
        switch event {
        case .toolInputStart(let session, let message, let toolCallId, let tool)
            where session == sessionId && message == messageId:
            (toolCallId: toolCallId, tool: tool)
        case .toolStart(let session, let message, let toolCallId, let tool, _, _)
            where session == sessionId && message == messageId:
            (toolCallId: toolCallId, tool: tool)
        default:
            nil
        }
    }

    static func isAgentStart(_ event: AgentEvent, sessionId: String, messageId: String) -> Bool {
        if case .messageStart(let session, let message) = event {
            return session == sessionId && message == messageId
        }
        return false
    }

    static func finishedTool(
        in event: AgentEvent,
        sessionId: String,
        messageId: String
    )
        -> (toolCallId: String, outcome: SiriAskActivityToolOutcome)? {
        switch event {
        case .toolResult(let session, let message, let toolCallId, let result, _)
            where session == sessionId && message == messageId:
            (toolCallId, activityOutcome(for: result))
        case .toolChildResult(let session, let message, let toolCallId, let childIndex, let result)
            where session == sessionId && message == messageId:
            ("\(toolCallId)#\(childIndex)", activityOutcome(for: result))
        default:
            nil
        }
    }

    static func activityOutcome(for result: AgentToolResult) -> SiriAskActivityToolOutcome {
        switch result {
        case .searchResults(_, _, _, let results):
            return .search(found: results.count)
        case .document:
            return .documentOpened
        case .searchBatch(let items), .documentBatch(let items):
            let outcomes = items.map(activityOutcome(for:))
            return .batch(
                found: outcomes.reduce(0) { $0 + foundCount(in: $1) },
                opened: outcomes.reduce(0) { $0 + openedCount(in: $1) }
            )
        default:
            return .none
        }
    }

    private static func foundCount(in outcome: SiriAskActivityToolOutcome) -> Int {
        switch outcome {
        case .search(let found): found
        case .batch(let found, _): found
        case .none, .documentOpened: 0
        }
    }

    private static func openedCount(in outcome: SiriAskActivityToolOutcome) -> Int {
        switch outcome {
        case .documentOpened: 1
        case .batch(_, let opened): opened
        case .none, .search: 0
        }
    }

    /// Stream errors a re-attach cannot fix: the token is bad or the
    /// caller lost the scope. Everything else (socket drops, watchdog
    /// cancellations, transient server errors) is worth a replayed
    /// re-attach while budget remains.
    static func isUnrecoverable(_ error: Error) -> Bool {
        switch error {
        case GatewayClient.Error.unauthorized, GatewayClient.Error.forbidden:
            true
        default:
            false
        }
    }
}

extension VoiceAnswerEngine.Effects {
    /// Production wiring against the paired gateway: SSE re-attach with
    /// replay, transcript fetch, wall clock, real sleep.
    public static func live(
        client: AgentClient,
        conversationId: String,
        onActivity: (@Sendable (_ event: SiriAskActivityEvent) -> Void)? = nil
    )
        -> Self {
        .init(
            attach: { client.events(lastEventId: $0) },
            loadTranscript: { try await client.loadConversation(id: conversationId).messages },
            now: { Date() },
            sleep: { try await Task.sleep(nanoseconds: UInt64($0 * 1_000_000_000)) },
            onActivity: onActivity
        )
    }
}
