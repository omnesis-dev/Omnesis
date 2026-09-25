// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// Decides whether a Siri ask continues the previous ask's conversation
/// or starts a fresh one: repeat asks within the window resume the same
/// thread, so "what about tomorrow?" lands as a follow-up rather than a
/// contextless new chat. Pure — the decision is a function of the stored
/// record and the current time, so the sim-less logic lane can test it
/// without touching `UserDefaults`.
public enum SiriAskContinuity {
    /// How long after an ask a follow-up still resumes its conversation.
    public static let window: TimeInterval = 5 * 60

    /// The last Siri ask: which conversation it landed in, and when.
    public struct Record: Equatable, Sendable {
        public let conversationId: String
        public let askedAt: Date

        public init(conversationId: String, askedAt: Date) {
            self.conversationId = conversationId
            self.askedAt = askedAt
        }
    }

    /// The conversation to resume, or nil to start fresh: no prior ask,
    /// a prior ask older than the window, or a record from the future
    /// (the clock moved backwards — treat it as unusable rather than
    /// resuming on garbage timing).
    public static func conversationToResume(
        record: Record?,
        now: Date,
        window: TimeInterval = window
    )
        -> String? {
        guard let record else { return nil }
        let age = now.timeIntervalSince(record.askedAt)
        guard age >= 0, age < window else { return nil }
        return record.conversationId
    }
}

/// Pre-send gate for a Siri ask: decides what to do with the freshly
/// created (possibly resumed) voice session before posting the
/// question. Pure — a function of the session-create response — so the
/// sim-less logic lane can test the busy branch without AppIntents.
public enum SiriAskPreflight {
    public enum Action: Equatable, Sendable {
        /// The resumed conversation's previous turn is still in flight
        /// (`busy`): posting now would only draw the gateway's
        /// session-busy rejection. Speak the still-working dialog
        /// instead, send nothing, and keep the continuity thread — the
        /// previous turn's own armed push delivers its answer.
        case reportPreviousTurnRunning(conversationId: String)
        /// The session is idle: record continuity and send the question.
        case send(conversationId: String)
    }

    /// `conversationId` falls back to `sessionId` for gateways that
    /// don't emit the persisted conversation id separately.
    public static func action(for session: CreateSessionResponse) -> Action {
        let conversationId = session.conversationId ?? session.sessionId
        return session.busy
            ? .reportPreviousTurnRunning(conversationId: conversationId)
            : .send(conversationId: conversationId)
    }
}

/// How an ask's answer budget is split between reaching the gateway and
/// waiting for the turn. The budget is a promise about the *whole* ask —
/// the surface waiting on it (the watch's relay backstop, Siri's own
/// patience) starts its clock when the question is dictated, not when the
/// gateway finally accepts it. So the setup round-trips spend the same
/// budget the turn does, and what is left over is both what the caller
/// may still wait and what `notifyAfterMs` is set to, which lands the
/// armed push on that same deadline.
///
/// Pure — a function of the elapsed setup time — so the sim-less logic
/// lane can drive every branch.
public enum SiriAskBudget {
    /// Floor on the remaining wait. The gateway rejects a `notifyAfterMs`
    /// under a second, and a setup that has already overrun still has to
    /// arm the push: it is the only channel left to deliver the answer.
    /// A wait this short resolves to the still-working dialog almost
    /// immediately, which is the honest thing to say once the promised
    /// window is gone.
    public static let minimumRemaining: TimeInterval = 1

    /// Ceiling on the remaining wait, mirroring the widest `notifyAfterMs`
    /// the gateway accepts. No real budget approaches it; the clamp is
    /// what keeps a nonsensical one (an infinity, a caller-set budget in
    /// the wrong unit) from becoming a rejected send or a trapping
    /// conversion instead of a long wait.
    public static let maximumRemaining: TimeInterval = 600

    /// Grace over the remaining wait for the two steps that bracket it:
    /// handing the question to the gateway, and reading back the settled
    /// transcript once the turn ends. Both are ordinary round trips that
    /// the wait itself does not cover, and neither may be what makes an
    /// ask outlive the caller waiting on it — so the ask abandons them at
    /// this margin and answers from what it already has.
    public static let settleGrace: TimeInterval = 10

    /// What is left of `budget` after `elapsed` seconds of setup, never
    /// below `minimumRemaining`.
    public static func remaining(budget: TimeInterval, elapsed: TimeInterval) -> TimeInterval {
        max(minimumRemaining, budget - max(0, elapsed))
    }

    /// The remaining wait as the gateway's `notifyAfterMs` — whole
    /// milliseconds, so the armed push and the spoken wait share one
    /// deadline rather than drifting by a rounding error. Clamped to the
    /// range the gateway accepts, since a value outside it is refused
    /// with the question rather than merely losing the push.
    public static func notifyAfterMs(remaining: TimeInterval) -> Int {
        let seconds = min(maximumRemaining, max(minimumRemaining, remaining))
        return Int((seconds * 1000).rounded())
    }
}

/// `UserDefaults`-backed persistence for the last Siri ask. The defaults
/// suite and the clock are injected so tests can run against a throwaway
/// suite at a controlled time; production uses `.standard` and the real
/// clock.
public final class SiriAskContinuityStore {
    static let conversationIdKey = "siriAsk.lastConversationId"
    static let askedAtKey = "siriAsk.lastAskedAt"

    private let defaults: UserDefaults
    private let now: () -> Date

    public init(defaults: UserDefaults = .standard, now: @escaping () -> Date = Date.init) {
        self.defaults = defaults
        self.now = now
    }

    /// The conversation the next ask should resume, per
    /// `SiriAskContinuity.conversationToResume` over the stored record.
    public func conversationToResume() -> String? {
        SiriAskContinuity.conversationToResume(record: load(), now: now())
    }

    /// Stamp `conversationId` as the latest ask, dated now.
    public func record(conversationId: String) {
        defaults.set(conversationId, forKey: Self.conversationIdKey)
        defaults.set(now().timeIntervalSince1970, forKey: Self.askedAtKey)
    }

    func load() -> SiriAskContinuity.Record? {
        guard let id = defaults.string(forKey: Self.conversationIdKey) else { return nil }
        let stamp = defaults.double(forKey: Self.askedAtKey)
        guard stamp > 0 else { return nil }
        return SiriAskContinuity.Record(
            conversationId: id,
            askedAt: Date(timeIntervalSince1970: stamp)
        )
    }
}
