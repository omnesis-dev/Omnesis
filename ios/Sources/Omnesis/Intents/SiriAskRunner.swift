// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// The iPhone-side engine of a Siri ask: create (or resume) a voice
/// session against the paired gateway, post the question with an armed
/// slow-answer push, and fold the turn's stream into a spoken answer.
/// Returns a `SiriAskOutcome` the caller turns into speech — the same
/// runner backs the on-phone `AskOmnesisIntent` and the watch-relay
/// receiver, so both surfaces behave identically.
///
/// Pure Foundation (no AppIntents, no UIKit) so the resolution-mapping
/// is unit-testable in the sim-less logic lane and the file builds on
/// macOS. The network dance itself is thin orchestration over
/// `AgentClient` + the already-tested `VoiceAnswerEngine`.
struct SiriAskRunner {
    /// How long an ask may take before handing off to the push channel —
    /// the setup round trips and the turn together, measured from `run`.
    /// What is left of it when the question is posted is also sent as the
    /// gateway's `notifyAfterMs`, so the spoken wait and the armed push
    /// end on the same deadline, give or take the post's own round trip.
    ///
    /// It has to cover the whole ask, not just the turn: the caller's own
    /// patience (Siri's, and the watch relay's backstop) starts when the
    /// question is dictated. A budget that began at the post would let a
    /// slow setup overrun the caller's ceiling, and the ask would then be
    /// resolved by that backstop — reported as an answer stranded on the
    /// phone — rather than by this runner. `SiriAskBudget.settleGrace` is
    /// the only margin the ask may exceed it by.
    static let answerBudget: TimeInterval = 20

    /// Budget for a watch-relayed ask. The watch app — not Siri — owns this
    /// wait: it sits on screen with a progress view, so it can afford far
    /// longer than Siri's 20s and most turns then settle in-band and are
    /// shown and spoken on the wrist instead of falling through to the push.
    /// Held below WatchConnectivity's reply window, since the answer travels
    /// back as the `sendMessage` reply.
    static let watchRelayBudget: TimeInterval = 45

    /// Transcript page requested when resuming the continuity thread:
    /// none of it. The ask reads no message content — only the session's
    /// id, its busy flag and its `messageCount` — while a thread whose
    /// previous turn searched carries every result it collected, hundreds
    /// of kilobytes the ask would spend its budget downloading and then
    /// discard. `messageCount` still reports the whole transcript, which
    /// is the one number the answer engine needs.
    ///
    /// That count is of user-visible messages, while the answer engine
    /// indexes the full stored transcript. The two agree for every thread
    /// this ask will resume, because `resume` refuses an anchored one —
    /// a hidden seeded prefix is exactly what would part them.
    static let resumeTranscriptLimit = 0

    let pairing: PairingService
    let continuity: SiriAskContinuityStore
    let budget: TimeInterval
    /// Margin the ask may exceed `budget` by, for the round trips the wait
    /// itself does not cover — see `SiriAskBudget.settleGrace`.
    let settleGrace: TimeInterval
    /// Wall clock, injected so a test can hold the budget still.
    let now: @Sendable () -> Date
    /// Builds the gateway client for a pairing. The seam a test drives the
    /// whole ask through: a client over a stubbed transport answers the
    /// session, send and transcript calls without a gateway.
    let makeClient: @Sendable (_ url: URL, _ token: String) -> AgentClient
    /// Reports privacy-safe milestones to a caller with a progress surface.
    /// Nil for the on-phone Siri ask, which speaks only the final answer.
    let onActivity: (@Sendable (_ event: SiriAskActivityEvent) -> Void)?

    init(
        pairing: PairingService = PairingService(),
        continuity: SiriAskContinuityStore = SiriAskContinuityStore(),
        budget: TimeInterval = answerBudget,
        settleGrace: TimeInterval = SiriAskBudget.settleGrace,
        now: @escaping @Sendable () -> Date = Date.init,
        makeClient: @escaping @Sendable (_ url: URL, _ token: String) -> AgentClient
            = { AgentClient(baseURL: $0, token: $1) },
        onActivity: (@Sendable (_ event: SiriAskActivityEvent) -> Void)? = nil
    ) {
        self.pairing = pairing
        self.continuity = continuity
        self.budget = budget
        self.settleGrace = settleGrace
        self.now = now
        self.makeClient = makeClient
        self.onActivity = onActivity
    }

    /// Run one ask. `question` must already be non-empty and trimmed —
    /// the intents guard emptiness so Siri can re-prompt for the value.
    func run(question: String) async -> SiriAskOutcome {
        // The budget clock starts here, before the first round trip — see
        // `answerBudget`.
        let startedAt = now()
        guard let pairing = (try? pairing.current()).flatMap({ $0 }) else {
            return .notPaired
        }
        let client = makeClient(pairing.url, pairing.token)
        onActivity?(.connecting)
        let session: CreateSessionResponse
        switch await openSession(client, resumeFromId: continuity.conversationToResume(), within: budget) {
        case .ended(let outcome): return outcome
        case .opened(let opened): session = opened
        }
        switch SiriAskPreflight.action(for: session) {
        case .reportPreviousTurnRunning(let conversationId):
            // The previous ask's turn is still running — its own armed
            // push delivers that answer. Refresh the continuity stamp so
            // the promised follow-up resumes this same thread.
            continuity.record(conversationId: conversationId)
            return .previousTurnRunning
        case .send(let conversationId):
            return await send(
                question: question,
                client: client,
                session: session,
                conversationId: conversationId,
                startedAt: startedAt
            )
        }
    }

    /// Ask a question nobody is waiting on: one the watch queued after the
    /// iPhone app missed the live relay. Returns how the ask ended and the
    /// conversation it went to, for the caller to notify from.
    ///
    /// The question is posted with the shortest slow-answer budget the
    /// gateway accepts, so a turn that settles after it is announced by the
    /// gateway's own push — its answer, or that it failed. A turn that
    /// settles inside that budget gets no push, so the runner follows the
    /// turn for exactly that long and returns what it saw; only a turn still
    /// running at the end returns `stillWorking`, the push's to deliver. The
    /// runner's window opens once the gateway has accepted the question, so
    /// it covers the gateway's silent window rather than falling short of it.
    ///
    /// No read-state lease is taken: nothing presents this answer as it is
    /// produced, so it stays unread for the notification to point at. The
    /// whole hand-off is bounded by `budget`, so it ends inside the
    /// background time a queued relay's launch is granted.
    ///
    /// `stillWorking` means the runner could not see the turn settle — which
    /// is almost always a turn still running, left to the push. A turn that
    /// did settle inside the push budget reads the same only when the stream
    /// missed its end and the transcript read-back failed too; its answer is
    /// then in the conversation without a notification.
    func handOff(question: String) async -> (outcome: SiriAskOutcome, conversationId: String?) {
        let startedAt = now()
        guard let pairing = (try? pairing.current()).flatMap({ $0 }) else {
            return (.notPaired, nil)
        }
        let client = makeClient(pairing.url, pairing.token)
        // Every step spends the one budget, so the hand-off ends inside the
        // background time a queued relay's launch is granted.
        let left = { max(0, budget - now().timeIntervalSince(startedAt)) }
        var session: CreateSessionResponse
        switch await openSession(client, resumeFromId: continuity.conversationToResume(), within: left()) {
        case .ended(let outcome): return (outcome, nil)
        case .opened(let opened): session = opened
        }
        if case .reportPreviousTurnRunning = SiriAskPreflight.action(for: session) {
            // A live ask would tell its caller to try again; nobody is here to
            // hear that, so the question goes to a fresh conversation instead
            // of being dropped behind the running one.
            switch await openSession(client, resumeFromId: nil, within: left()) {
            case .ended(let outcome): return (outcome, nil)
            case .opened(let opened): session = opened
            }
        }
        let conversationId = session.conversationId ?? session.sessionId
        let posted = PostedFlag()
        let record = {
            posted.set()
            continuity.record(conversationId: conversationId)
        }
        let pending = PendingTurn(
            question: question,
            client: client,
            session: session,
            conversationId: conversationId,
            remaining: SiriAskBudget.minimumRemaining,
            viewingForMs: nil
        )
        // The same bound a live ask's turn gets — the wait plus the margin for
        // posting and reading back — and never past what is left of `budget`.
        let outcome = await Self.beforeDeadline(min(pending.remaining + settleGrace, left())) {
            await Self.turn(pending, onSent: record, onActivity: nil)
        }
        switch outcome {
        case .timedOut:
            // A posted question is the push's to announce; one the gateway
            // never accepted was not asked at all.
            return (posted.value ? .stillWorking : .sendFailed, conversationId)
        case .finished(let resolved):
            return (resolved, conversationId)
        }
    }

    /// Open the voice session an ask posts to, or the outcome that ends the
    /// ask when the gateway can't provide one.
    ///
    /// Reaching the gateway is raced against what is left of the budget
    /// (`seconds`). Nothing in a URL request gives up on its own inside the
    /// ask's window, so without this a single stalled round trip outlives the
    /// caller — and the caller then resolves the ask itself, reporting a
    /// delivery problem for a question that was never even posted.
    private func openSession(
        _ client: AgentClient,
        resumeFromId: String?,
        within seconds: TimeInterval
    ) async
        -> OpenedSession {
        switch await Self.beforeDeadline(seconds, { await Self.voiceSession(client, resumeFromId) }) {
        case .timedOut:
            .ended(.unreachable)
        case .finished(.failure(GatewayClient.Error.forbidden)),
             .finished(.failure(GatewayClient.Error.unauthorized)):
            .ended(.unauthorized)
        case .finished(.failure):
            .ended(.unreachable)
        case .finished(.success(let created)):
            .opened(created)
        }
    }

    /// Whether a hand-off's question reached the gateway, set from the turn's
    /// send callback and read after the deadline race that may abandon it.
    private final class PostedFlag: @unchecked Sendable {
        private let lock = NSLock()
        private var posted = false

        var value: Bool {
            lock.lock()
            defer { lock.unlock() }
            return posted
        }

        func set() {
            lock.lock()
            posted = true
            lock.unlock()
        }
    }

    /// A voice session ready for the question, or the outcome that ends the
    /// ask without one.
    private enum OpenedSession {
        case opened(CreateSessionResponse)
        case ended(SiriAskOutcome)
    }

    private func send(
        question: String,
        client: AgentClient,
        session: CreateSessionResponse,
        conversationId: String,
        startedAt: Date
    ) async
        -> SiriAskOutcome {
        // Whatever reaching the gateway cost comes out of the budget, so the
        // spoken wait and the armed push both end when the caller's own
        // ceiling does.
        let remaining = SiriAskBudget.remaining(
            budget: budget,
            elapsed: now().timeIntervalSince(startedAt)
        )
        let activity = onActivity
        let record = { continuity.record(conversationId: conversationId) }
        // Posting the question and reading back the settled transcript are
        // round trips the wait itself does not cover, so the turn is raced
        // against the wait plus that margin. Timing out here resolves to
        // the still-working dialog rather than a failure: the send's
        // `notifyAfterMs` armed a push for exactly this wait, so a turn
        // whose answer this ask never sees is still delivered.
        let pending = PendingTurn(
            question: question,
            client: client,
            session: session,
            conversationId: conversationId,
            remaining: remaining,
            viewingForMs: Self.viewingForMs(remaining: remaining, settleGrace: settleGrace)
        )
        let outcome = await Self.beforeDeadline(remaining + settleGrace) {
            await Self.turn(
                pending,
                onSent: {
                    activity?(.requestSent)
                    // The turn is running: remember the thread whatever
                    // happens next, so a follow-up ask resumes it.
                    record()
                },
                onActivity: activity
            )
        }
        switch outcome {
        case .timedOut: return .stillWorking
        case .finished(let resolved): return resolved
        }
    }

    /// A question ready to post, and the wait it is allowed once it is.
    private struct PendingTurn: Sendable {
        let question: String
        let client: AgentClient
        let session: CreateSessionResponse
        let conversationId: String
        let remaining: TimeInterval
        /// The read-state lease for a caller presenting the answer as it is
        /// produced; nil when nothing is.
        let viewingForMs: Int?
    }

    /// Post the question and fold the turn's stream into a spoken outcome.
    /// Static and self-free so the deadline race can hold it in a
    /// `@Sendable` closure.
    private static func turn(
        _ pending: PendingTurn,
        onSent: @Sendable () -> Void,
        onActivity: (@Sendable (_ event: SiriAskActivityEvent) -> Void)?
    ) async
        -> SiriAskOutcome {
        let (question, client, session) = (pending.question, pending.client, pending.session)
        let remaining = pending.remaining
        // Subscribe before posting the question: a fresh SSE attach gets
        // live events only (no Last-Event-ID to replay from), and the
        // stream buffers its yields until the engine starts consuming, so
        // opening it first keeps the turn's earliest deltas out of the gap
        // between POST and attach.
        let stream = client.events()
        let sent: SendMessageResponse
        do {
            sent = try await client.sendMessage(
                sessionId: session.sessionId,
                text: question,
                notifyAfterMs: SiriAskBudget.notifyAfterMs(remaining: remaining),
                viewingForMs: pending.viewingForMs
            )
        } catch {
            return .sendFailed
        }
        onSent()
        let engine = VoiceAnswerEngine(
            sessionId: session.sessionId,
            messageId: sent.messageId,
            // The transcript length before this ask's user message. A
            // resume reports it as `messageCount` and returns no messages;
            // `messages.count` covers a gateway that reports no count.
            priorMessageCount: max(session.messageCount, session.messages.count),
            budget: remaining,
            effects: .live(
                client: client,
                conversationId: pending.conversationId,
                onActivity: onActivity
            )
        )
        return await SiriAskOutcome.from(engine.run(initialStream: stream))
    }

    /// Keep the gateway's read-state lease through the runner's whole bounded
    /// wait, including the small settle margin used to reconcile the final
    /// transcript. A later answer outlives this lease and remains unread so
    /// the slow-answer push still points at something awaiting attention.
    private static func viewingForMs(
        remaining: TimeInterval,
        settleGrace: TimeInterval
    )
        -> Int {
        let milliseconds = Int(ceil((remaining + settleGrace) * 1000))
        return min(600_000, max(1000, milliseconds))
    }

    /// Create the voice-profile session, resuming the continuity thread
    /// when one is live. A resume that cannot be used — the conversation
    /// was deleted since the last ask, or is one this ask has no business
    /// continuing — falls back to a fresh session rather than sinking the
    /// whole ask. A fresh session that fails for a systemic reason
    /// (auth or unreachable) returns that error for `run`
    /// to map to an outcome.
    ///
    /// Static and self-free so the deadline race can hold it in a
    /// `@Sendable` closure.
    private static func voiceSession(
        _ client: AgentClient,
        _ resumeFromId: String?
    ) async
        -> Result<CreateSessionResponse, Error> {
        if let resumeFromId, let resumed = await resume(client, resumeFromId) {
            return .success(resumed)
        }
        do {
            return try await .success(client.createSession(profile: "voice"))
        } catch {
            return .failure(error)
        }
    }

    /// The continuity thread as a session to send on, or nil to start
    /// fresh. Nil covers a resume that failed outright and one that
    /// succeeded into a conversation this ask must not continue: a thread
    /// frozen by a context-window failure cannot accept sends, and an
    /// anchored thread (a brief's, a watch firing's) belongs to the
    /// surface that opened it — resuming one would also break the
    /// `resumeTranscriptLimit` count, which is of visible messages while
    /// an anchored thread hides a seeded prefix.
    private static func resume(
        _ client: AgentClient,
        _ resumeFromId: String
    ) async
        -> CreateSessionResponse? {
        let resumed: CreateSessionResponse?
        do {
            resumed = try await client.createSession(
                profile: "voice",
                resumeFromId: resumeFromId,
                transcriptLimit: resumeTranscriptLimit
            )
        } catch GatewayClient.Error.serverError(let status, _) where status == 400 {
            // A gateway too old to serve an empty transcript page rejects
            // the request rather than ignoring the value it doesn't know.
            // The thread is worth more than the bytes not fetching it
            // saves, so ask again for the whole thing — losing continuity
            // would drop the follow-up into a conversation with no memory
            // of the question it is following up on.
            resumed = try? await client.createSession(
                profile: "voice",
                resumeFromId: resumeFromId
            )
        } catch {
            resumed = nil
        }
        guard let resumed, resumed.terminalFailure == nil, resumed.origin == nil else { return nil }
        return resumed
    }

    /// How one step of the ask ended, relative to the deadline it was
    /// given. `timedOut` means the step is abandoned, not that it failed —
    /// the caller decides what to say about a gateway that never answered.
    private enum Deadlined<Value> {
        case finished(Value)
        case timedOut
    }

    /// Run `step`, abandoning it once `seconds` elapse. Cancelling the
    /// group tears down the in-flight URL task, so a stalled round trip
    /// cannot outlive the ask's budget — nothing in the transport gives up
    /// on its own inside a window this short.
    private static func beforeDeadline<Value: Sendable>(
        _ seconds: TimeInterval,
        _ step: @escaping @Sendable () async -> Value
    ) async
        -> Deadlined<Value> {
        await withTaskGroup(of: Deadlined<Value>?.self) { group in
            group.addTask {
                let value = await step()
                return Task.isCancelled ? nil : .finished(value)
            }
            group.addTask {
                try? await Task.sleep(nanoseconds: UInt64(max(0, seconds) * 1_000_000_000))
                return Task.isCancelled ? nil : .timedOut
            }
            var first: Deadlined<Value>?
            while first == nil, let next = await group.next() {
                first = next
            }
            group.cancelAll()
            return first ?? .timedOut
        }
    }
}

extension SiriAskOutcome {
    /// Map the answer engine's terminal resolution to a spoken outcome:
    /// a settled turn with text is spoken, a settled turn without text is
    /// the empty-answer nudge, a dead turn fails, and a turn still running
    /// at the budget defers to the armed push.
    static func from(_ resolution: VoiceAnswerEngine.Resolution) -> SiriAskOutcome {
        switch resolution {
        case .answered(let text) where !text.isEmpty:
            .answered(text: text)
        case .answered:
            .emptyAnswer
        case .failed(_, let message):
            .failed(reason: message)
        case .stillWorking:
            .stillWorking
        }
    }
}
