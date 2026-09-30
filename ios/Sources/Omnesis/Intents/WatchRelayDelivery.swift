// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// How long the watch keeps trying to hand a question or note to the iPhone
/// app before falling back to the queued channel.
///
/// A live relay (`sendMessage`) is what starts the iPhone app in the
/// background, and an app iOS has evicted from memory takes a while to
/// launch — longer than a single retry covers. The first send starts that
/// launch; a later send lands on the app once it is up. The watch app owns
/// this wait on screen, so it can afford to keep going well past what Siri
/// would hold open.
///
/// Pure so the sim-less logic lane covers the schedule.
public enum WatchRelayPatience {
    /// Total time the watch spends trying live delivery, measured from the
    /// first attempt. Past it, the relay is queued instead.
    public static let deliveryWindow: TimeInterval = 20

    /// Pauses between attempts. Short at first, when a merely suspended app
    /// is about to answer, then longer while a cold launch completes. The
    /// last entry repeats.
    static let pauses: [TimeInterval] = [0.7, 1.5, 2.5, 3]

    /// The pause before the next attempt, or nil when another attempt would
    /// start past the delivery window. `attempts` counts sends already made;
    /// `elapsed` is the time since the first began.
    public static func pause(afterAttempts attempts: Int, elapsed: TimeInterval) -> TimeInterval? {
        let pause = pauses[min(max(attempts, 1) - 1, pauses.count - 1)]
        return elapsed + pause < deliveryWindow ? pause : nil
    }
}

/// The queued fallback for a relay the iPhone app never picked up live.
///
/// `transferUserInfo` is WatchConnectivity's guaranteed-delivery channel: the
/// system holds the payload until the iPhone app next runs, however long that
/// is. The payload is the same message the live relay sends, stamped with
/// when it was queued and a compact record of why live delivery failed, so
/// the phone can drop a question that has gone stale and log what the watch
/// saw.
public enum WatchRelayQueue {
    static let queuedAtKey = "queuedAt"
    static let attemptsKey = "relayAttempts"
    static let lastErrorKey = "relayLastError"

    /// A queued question older than this is dropped rather than answered.
    /// Its answer arrives as a notification, and one for a question asked
    /// long ago reads as unprompted. A note has no such limit: it is saved
    /// with its own capture time whenever it arrives.
    public static let askExpiry: TimeInterval = 10 * 60

    /// What the watch saw before queueing, carried for the phone's log.
    public struct Envelope: Equatable, Sendable {
        public let queuedAt: Date
        public let attempts: Int
        /// The last `WCError` code of a failed send, when there was one.
        public let lastErrorCode: Int?

        public init(queuedAt: Date, attempts: Int, lastErrorCode: Int?) {
            self.queuedAt = queuedAt
            self.attempts = attempts
            self.lastErrorCode = lastErrorCode
        }
    }

    /// Watch side: the live message stamped as a queued one.
    public static func queued(_ message: [String: String], envelope: Envelope) -> [String: String] {
        var stamped = message
        stamped[queuedAtKey] = String(envelope.queuedAt.timeIntervalSince1970)
        stamped[attemptsKey] = String(envelope.attempts)
        if let code = envelope.lastErrorCode { stamped[lastErrorKey] = String(code) }
        return stamped
    }

    /// iPhone side: the stamp on a queued payload, or nil when it carries
    /// none — which the phone treats as malformed rather than guessing an age.
    public static func envelope(from payload: [String: Any]) -> Envelope? {
        guard let raw = payload[queuedAtKey] as? String,
              let seconds = TimeInterval(raw), seconds.isFinite
        else { return nil }
        return Envelope(
            queuedAt: Date(timeIntervalSince1970: seconds),
            attempts: (payload[attemptsKey] as? String).flatMap { Int($0) } ?? 0,
            lastErrorCode: (payload[lastErrorKey] as? String).flatMap { Int($0) }
        )
    }

    /// Whether a queued question is too old to answer. A queued time in the
    /// future (the two clocks disagree) is treated as fresh: the question was
    /// just asked, and dropping it would lose it for a clock skew.
    public static func askIsExpired(_ envelope: Envelope, now: Date) -> Bool {
        now.timeIntervalSince(envelope.queuedAt) > askExpiry
    }
}

/// The relay refs the iPhone has already acted on. A watch only queues a
/// relay after its live sends failed, so the phone should never see one
/// twice — this makes that a guarantee rather than an assumption, for the
/// case where a send the watch saw fail did in fact land.
///
/// Bounded and in-memory: it covers the minutes in which a live send and its
/// queued copy could both arrive. A copy that arrives after iOS has ended the
/// process is acted on again.
struct WatchRelayRecentRefs: Sendable {
    static let capacity = 32
    private var refs: [String] = []

    init() {}

    /// Record `ref`, returning false when it was already recorded. A relay
    /// without a ref comes from a watch build that predates them and is
    /// always new.
    mutating func insert(_ ref: String?) -> Bool {
        guard let ref else { return true }
        guard !refs.contains(ref) else { return false }
        refs.append(ref)
        if refs.count > Self.capacity { refs.removeFirst(refs.count - Self.capacity) }
        return true
    }
}

/// What the iPhone does with a relay the watch queued. Pure, so the sim-less
/// logic lane covers every way a queued payload is acted on or dropped.
enum WatchRelayInbox {
    enum Action: Equatable {
        case saveNote(text: String, captureTime: NoteCaptureTime)
        case ask(question: String)
        case drop(DropReason)
    }

    enum DropReason: String, Equatable {
        /// No queue stamp, so no way to tell a stale question from a fresh one.
        case unstamped
        case noteWithoutCaptureTime
        case unknownKind
        /// A question asked longer ago than `WatchRelayQueue.askExpiry`.
        case expired
        /// Already acted on from another copy of the same relay.
        case duplicate
    }

    static func route(
        queued payload: [String: Any],
        now: Date,
        handled refs: inout WatchRelayRecentRefs
    )
        -> Action {
        guard let envelope = WatchRelayQueue.envelope(from: payload) else { return .drop(.unstamped) }
        if let text = WatchNoteWire.text(from: payload) {
            guard let captureTime = WatchNoteWire.captureTime(from: payload) else {
                return .drop(.noteWithoutCaptureTime)
            }
            guard refs.insert(WatchNoteWire.ref(from: payload)) else { return .drop(.duplicate) }
            return .saveNote(text: text, captureTime: captureTime)
        }
        guard let question = SiriAskWire.question(from: payload) else { return .drop(.unknownKind) }
        guard !WatchRelayQueue.askIsExpired(envelope, now: now) else { return .drop(.expired) }
        guard refs.insert(SiriAskWire.ref(from: payload)) else { return .drop(.duplicate) }
        return .ask(question: question)
    }
}

/// The live asks the iPhone is answering, by ref, so a later copy of one is
/// answered from the first rather than run again or guessed at: a send the
/// watch saw fail can still have landed, and its retry then arrives while —
/// or after — the first copy runs. Generic over the waiting reply so the
/// sim-less logic lane can drive it without WatchConnectivity.
struct LiveAskLedger<Waiter> {
    enum Claim {
        /// The first copy: run the ask, then `settle` it.
        case run
        /// A later copy of an ask still running; its waiter is held.
        case held
        /// A later copy of an ask that settled with this reply.
        case reply([String: String])
        /// A later copy of an ask this ledger no longer tracks — one handled
        /// as a queued copy, or aged out.
        case untracked
    }

    private enum Entry {
        case running(waiting: [Waiter])
        case settled(reply: [String: String])
    }

    private var entries: [String: Entry] = [:]
    private var order: [String] = []

    /// Claim `ref` for a live copy that arrived with `waiter`. `isNew` says
    /// whether the ref was unseen by the phone's shared relay dedupe.
    mutating func claim(_ ref: String, isNew: Bool, waiter: Waiter) -> Claim {
        if isNew {
            entries[ref] = .running(waiting: [])
            order.append(ref)
            if order.count > WatchRelayRecentRefs.capacity {
                entries.removeValue(forKey: order.removeFirst())
            }
            return .run
        }
        switch entries[ref] {
        case .running(let waiting):
            entries[ref] = .running(waiting: waiting + [waiter])
            return .held
        case .settled(let reply):
            return .reply(reply)
        case nil:
            return .untracked
        }
    }

    /// Record the first copy's reply and return the later copies waiting on it.
    mutating func settle(_ ref: String, reply: [String: String]) -> [Waiter] {
        guard case .running(let waiting) = entries[ref] else { return [] }
        entries[ref] = .settled(reply: reply)
        return waiting
    }
}
