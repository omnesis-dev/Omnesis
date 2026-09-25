// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if os(iOS)
import Foundation
import OSLog
import UIKit
@preconcurrency import UserNotifications
import WatchConnectivity

/// iPhone side of the Apple Watch relay — the phone's single
/// WatchConnectivity delegate, routing each message the watch sends by
/// its kind. The watch has no gateway pairing of its own:
///   - an "ask" runs the shared `SiriAskRunner` against the paired
///     gateway and replies with the spoken outcome;
///   - a "note" is saved through the shared `NoteCaptureService`
///     (attaching the phone's location) and replies with the save result.
/// Either way the whole operation reuses the phone's pairing, TLS
/// pinning, and — for asks — session continuity and slow-answer push; the
/// watch adds only voice in and result back.
///
/// WatchConnectivity wakes the iPhone app in the background to deliver a
/// `sendMessage` that carries a reply handler, so the relay works with
/// the phone locked in a pocket. We hold a background-task assertion for
/// the duration so a suspended app isn't frozen mid-operation, and (for
/// asks) the runner's armed `notifyAfterMs` push is the backstop if the
/// answer outlives the reply window (the watch maps that timeout to
/// "I'll notify you").
///
/// A relay the watch could not deliver live arrives later as a queued
/// payload (`transferUserInfo`). A queued note is saved like a live one; a
/// queued question is handed to the gateway, and how it ended reaches the
/// user as a notification — the gateway's slow-answer push, or a local one
/// when the push will not come (`QueuedAskNotice`). Refs make each relay act
/// at most once, however it arrives.
public final class WatchRelayReceiver: NSObject, WCSessionDelegate, @unchecked Sendable {
    public static let shared = WatchRelayReceiver()

    /// Builds the runner for one ask. Injectable so tests can substitute a
    /// stubbed runner; production uses the gateway-backed one on the watch's
    /// longer budget.
    private let makeRunner: @Sendable (@escaping @Sendable (SiriAskActivityEvent) -> Void) -> SiriAskRunner
    /// Builds the runner for a queued question. Its budget bounds the whole
    /// hand-off, so it stays inside the background time a queued relay's
    /// launch is granted.
    private let makeHandOffRunner: @Sendable () -> SiriAskRunner
    private let notifications: NotificationScheduling
    private let now: @Sendable () -> Date
    private let log = AppLog.make(category: "watch-relay")
    /// When this process started listening for the watch. Every relay log
    /// line is timed from it: a relay that arrives within a second or two of
    /// it is one that launched the app.
    private let listeningSince: Date
    private let lock = NSLock()
    private var handledRefs = WatchRelayRecentRefs()
    private var liveAsks = LiveAskLedger<([String: Any]) -> Void>()

    init(
        makeRunner: @escaping @Sendable (@escaping @Sendable (SiriAskActivityEvent) -> Void) -> SiriAskRunner
            = { SiriAskRunner(budget: SiriAskRunner.watchRelayBudget, onActivity: $0) },
        makeHandOffRunner: @escaping @Sendable () -> SiriAskRunner = { SiriAskRunner() },
        notifications: NotificationScheduling = SystemNotificationScheduler(),
        now: @escaping @Sendable () -> Date = Date.init
    ) {
        self.makeRunner = makeRunner
        self.makeHandOffRunner = makeHandOffRunner
        self.notifications = notifications
        self.now = now
        listeningSince = now()
        super.init()
    }

    /// Activate the shared session with this receiver as delegate. Called
    /// first thing at launch — a background launch the watch caused is only
    /// reachable once this has run, and the watch is waiting on it. Safe to
    /// call on every launch; a no-op where WatchConnectivity is unsupported
    /// (e.g. iPad).
    public func activate() {
        guard WCSession.isSupported() else { return }
        let session = WCSession.default
        session.delegate = self
        session.activate()
    }

    /// Seconds since this process started listening, for the relay log.
    private var sinceListening: String {
        String(format: "%.1fs", now().timeIntervalSince(listeningSince))
    }

    /// Record a live note's `ref` as handled; false when it already was.
    private func claim(_ ref: String?) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return handledRefs.insert(ref)
    }

    // MARK: - WCSessionDelegate

    public func session(
        _ session: WCSession,
        activationDidCompleteWith activationState: WCSessionActivationState,
        error: Error?
    ) {
        let state = activationState.rawValue
        log.info("Watch session activated \(self.sinceListening, privacy: .public) after launch (state \(state, privacy: .public))")
        if let error {
            log.error("Watch session activation failed: \(String(describing: error), privacy: .public)")
        }
    }

    public func sessionDidBecomeInactive(_ session: WCSession) {}

    /// After a device un-pair/re-pair the session deactivates; re-activate
    /// so a later watch ask can still reach us.
    public func sessionDidDeactivate(_ session: WCSession) {
        session.activate()
    }

    public func session(
        _ session: WCSession,
        didReceiveMessage message: [String: Any],
        replyHandler: @escaping ([String: Any]) -> Void
    ) {
        // Route by message kind. A note is saved locally through the
        // shared capture service; everything else is treated as an ask.
        if let noteText = WatchNoteWire.text(from: message) {
            guard let captureTime = WatchNoteWire.captureTime(from: message) else {
                replyHandler(WatchNoteWire.reply(for: .relayFailed))
                return
            }
            log.info("Watch note received live \(self.sinceListening, privacy: .public) after launch")
            guard claim(WatchNoteWire.ref(from: message)) else {
                // An earlier copy is already being saved; say it reached the
                // phone rather than save it twice.
                replyHandler(WatchNoteWire.reply(for: .reachedPhone))
                return
            }
            handleNote(noteText, captureTime: captureTime) { replyHandler(WatchNoteWire.reply(for: $0)) }
            return
        }
        guard let question = SiriAskWire.question(from: message) else {
            replyHandler(SiriAskWire.reply(for: .failed(reason: nil)))
            return
        }
        // Echoed on the result so the watch can tell this ask's answer from a
        // straggler belonging to the previous one.
        let ref = SiriAskWire.ref(from: message)
        log.info("Watch ask received live \(self.sinceListening, privacy: .public) after launch")
        guard claimLiveAsk(ref, replyHandler: replyHandler) else { return }
        // Progress is best-effort: a wrist that leaves the foreground simply
        // keeps its last snapshot, and an update must never disturb the ask.
        let reporter = WatchAskActivityReporter(session: session, ref: ref)
        reporter.report(.relayReceived)
        let runner = makeRunner { reporter.report($0) }
        Task {
            // Keep the (possibly background-woken) app alive for the turn,
            // ending the assertion as soon as the reply is sent. The turn
            // itself runs off the main actor — only the assertion's
            // begin/end touch `UIApplication` and hop to it.
            let assertion = WatchRelayBackgroundAssertion()
            await assertion.begin()
            let outcome = await runner.run(question: question)
            self.log.info("Watch ask settled as \(outcome.tag, privacy: .public) \(self.sinceListening, privacy: .public) after launch")
            // Two delivery paths for one answer. The reply is primary, but it
            // is a single point of failure: a turn that settles inside the
            // budget arms no push, so a reply lost to a suspended app or a
            // timeout that never fires would strand the watch on an answer
            // that exists. The watch takes whichever lands first.
            // Attempted unconditionally: `isReachable` is a snapshot that a
            // background-woken app reads pessimistically, and a send that
            // cannot land simply errors into the handler below. Guarding on it
            // only ever skipped the backup path at the moment it was needed.
            session.sendMessage(
                SiriAskWire.result(for: outcome, ref: ref),
                replyHandler: nil
            ) { _ in }
            let reply = SiriAskWire.reply(for: outcome)
            replyHandler(reply)
            for duplicate in self.settleLiveAsk(ref, reply: reply) {
                duplicate(reply)
            }
            await assertion.end()
        }
    }

    /// Claim a live ask, or answer a later copy of one: held until the first
    /// copy settles, or given its reply if it already has. False when this
    /// copy is not the one to run.
    private func claimLiveAsk(_ ref: String?, replyHandler: @escaping ([String: Any]) -> Void) -> Bool {
        guard let ref else { return true }
        lock.lock()
        let claim = liveAsks.claim(ref, isNew: handledRefs.insert(ref), waiter: replyHandler)
        lock.unlock()
        switch claim {
        case .run:
            return true
        case .held:
            return false
        case .reply(let reply):
            replyHandler(reply)
            return false
        case .untracked:
            replyHandler(SiriAskWire.reply(for: .stillWorking))
            return false
        }
    }

    /// Record a live ask's reply and return the later copies waiting on it.
    private func settleLiveAsk(_ ref: String?, reply: [String: String]) -> [([String: Any]) -> Void] {
        guard let ref else { return [] }
        lock.lock()
        defer { lock.unlock() }
        return liveAsks.settle(ref, reply: reply)
    }

    /// Save a watch-dictated note through the shared capture service and
    /// report the result. The phone attaches its own location (the
    /// watch relays only text), so a watch note is geotagged like one
    /// captured on the phone. Best-effort in the background: a locked or
    /// suspended phone may serve no fix, and the note is saved location
    /// -less in that case.
    private func handleNote(
        _ text: String,
        captureTime: NoteCaptureTime,
        completion: @escaping (WatchNoteOutcome) -> Void
    ) {
        Task {
            let assertion = WatchRelayBackgroundAssertion()
            await assertion.begin()
            // Background, no UI — never prompt; use location only if the
            // user already granted it in the app.
            let location = await NoteLocationProvider.shared.current(promptIfNeeded: false)
            let outcome = await NoteCaptureService.captureStandalone(
                text: text,
                surface: .watch,
                captureTime: captureTime,
                location: location
            )
            let noteOutcome = WatchNoteOutcome(capture: outcome)
            self.log.info("Watch note settled as \(noteOutcome.tag, privacy: .public)")
            completion(noteOutcome)
            await assertion.end()
        }
    }
}

/// Owns the aggregate reducer for one relayed ask. The answer engine can
/// replay SSE events after a reconnect, so this instance serializes timeline
/// updates and lets the shared reducer deduplicate by tool-call id before a
/// snapshot crosses to the watch.
private final class WatchAskActivityReporter: @unchecked Sendable {
    private let lock = NSLock()
    /// Deliveries run here, off the stream-consuming task. Serial, and
    /// enqueued while the reducer's lock is held, so the wrist sees the steps
    /// in the order they happened: two events racing would otherwise be free
    /// to arrive reversed, leaving the watch on a stale step for the rest of
    /// the turn.
    private let deliveries = DispatchQueue(label: "dev.omnesis.watch-relay.progress")
    private let session: WCSession
    private let ref: String?
    private var timeline = SiriAskActivityTimeline()

    init(session: WCSession, ref: String?) {
        self.session = session
        self.ref = ref
    }

    func report(_ event: SiriAskActivityEvent) {
        lock.lock()
        let message = SiriAskWire.progress(snapshot: timeline.apply(event), ref: ref)
        let session = session
        deliveries.async {
            // Read on the delivery queue: reachability at the moment of
            // sending is what matters, and a progress update must never
            // disturb the ask it is reporting on.
            guard session.activationState == .activated, session.isReachable else { return }
            session.sendMessage(message, replyHandler: nil) { _ in }
        }
        lock.unlock()
    }
}

/// A background-task assertion scoped to one watch-relayed operation (an
/// ask or a note save). Isolated to the main actor because
/// `UIApplication`'s background-task API requires it; the expiration
/// handler (invoked by UIKit when the granted time runs out) ends the
/// assertion so the app is never terminated for an outstanding one. If
/// expiration fires mid-operation the reply is simply never sent — for an
/// ask the watch maps that to a slow-answer and the runner's armed push
/// still delivers; for a note the watch reports a relay failure.
@MainActor
final class WatchRelayBackgroundAssertion {
    private var id: UIBackgroundTaskIdentifier = .invalid

    /// Non-isolated so the receiver's off-actor `Task` can construct it; the
    /// `id` default needs no main-actor work, and `begin`/`end` do the
    /// actual `UIApplication` calls on the main actor.
    nonisolated init() {}

    func begin() {
        id = UIApplication.shared.beginBackgroundTask(withName: "omnesis.watch-relay") { [weak self] in
            self?.end()
        }
    }

    func end() {
        guard id != .invalid else { return }
        UIApplication.shared.endBackgroundTask(id)
        id = .invalid
    }
}
#endif
