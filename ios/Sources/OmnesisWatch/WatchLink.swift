// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if os(watchOS)
import Foundation
import OSLog
import WatchConnectivity

/// Watch side of the phone relay — the watch's single WatchConnectivity
/// session owner (and delegate). The watch holds no gateway pairing, so
/// both surfaces it drives hand off to the paired iPhone:
///   - `relayAsk` sends a dictated question and awaits the spoken answer.
///   - `relayNote` sends a dictated note and awaits a save confirmation.
/// The phone owns the pairing; the watch's whole job is voice in, relay
/// out, result back.
///
/// `sendMessage(_:replyHandler:errorHandler:)` from watchOS launches the
/// iPhone app in the background if it isn't already running, so the relay
/// works with the phone locked. An app iOS has evicted from memory takes a
/// while to launch, so an unreachable phone is retried for the whole
/// `WatchRelayPatience.deliveryWindow`; past it the relay is queued on
/// `transferUserInfo`, which the system delivers whenever the iPhone app
/// next runs. An ask reply timeout defers to the phone's armed slow-answer
/// push ("I'll notify you") rather than reporting a hard failure, because
/// the phone did receive the question and armed that push before the
/// window elapsed.
final class WatchLink: NSObject, WCSessionDelegate, @unchecked Sendable {
    static let shared = WatchLink()

    /// Ceiling on how long `relay` waits for the session to activate before
    /// giving up and speaking `phoneUnreachable`. Activation normally
    /// completes in well under a second; this only bites when it fails
    /// terminally (a delegate callback that never re-fires), so the intent
    /// answers instead of hanging until Siri kills it.
    private static let activationTimeout: TimeInterval = 5

    /// How long to let the phone link settle into `isReachable` after the
    /// session activates, as a poll count × interval. `WCSession` has no
    /// async "become reachable" primitive, so this polls the flag.
    private static let reachabilityPolls = 20
    private static let reachabilityPollInterval: TimeInterval = 0.15
    /// Backstop on one note relay. A note save on the phone is quick
    /// (a POST, or a fall-back to the durable queue), so this sits far
    /// below the ask relay's turn-length budget — a lost reply shouldn't
    /// leave the wrist waiting a minute-plus for a note.
    private static let noteRelayTimeout: TimeInterval = 15

    /// Hard ceiling on one send. WatchConnectivity is supposed to call either
    /// the reply or the error handler, but a phone suspended after a
    /// background wake can leave both silent — and a turn that settles inside
    /// the budget arms no push, so nothing else would ever end the wait. Sits
    /// above the phone's own budget so a genuinely slow turn still reports
    /// through the normal path.
    private static let relayTimeout: TimeInterval = 70

    private let log = Logger(subsystem: "dev.omnesis.watch", category: "relay")
    private let lock = NSLock()
    private var activationWaiters: [CheckedContinuation<Void, Never>] = []
    /// The in-flight relay, resumed by whichever of the reply, the phone's
    /// fire-and-forget result, or the timeout arrives first. Every resolver
    /// carries the ref of the ask it belongs to: a timeout armed by an earlier
    /// ask outlives it, and would otherwise end the NEXT ask's wait with a
    /// verdict about a question already answered. Retries of one ask share
    /// its ref, so the per-send resolvers (reply, error, timeout) also carry
    /// the attempt they belong to; the phone's result names only the ask.
    private var pendingRelay: PendingSend<SiriAskOutcome>?
    /// The in-flight note relay, resolved by whichever of the reply, a
    /// send error, or the backstop arrives first — correlated by attempt so
    /// a stale backstop can't end a later send's wait.
    ///
    /// Each slot holds one send. A new send that finds it taken — a relay
    /// replaced mid-send by a newer one — resumes the displaced wait as
    /// undelivered before taking the slot, so no wait is ever stranded.
    private var pendingNote: PendingSend<WatchNoteOutcome>?

    /// Activate the shared session with this link as delegate. Called at
    /// app launch so the session is ready by the time Siri fires an ask or
    /// a note.
    func activate() {
        guard WCSession.isSupported() else { return }
        let session = WCSession.default
        session.delegate = self
        session.activate()
    }

    /// Relay a non-empty, trimmed question to the iPhone and return the
    /// outcome it reports (or a watch-local relay failure).
    func relayAsk(question: String, ref: String) async -> SiriAskOutcome {
        guard WCSession.isSupported() else { return .watchLinkInactive }
        // A background App Shortcut invocation may run `perform()` without
        // the app's `init()` (and its `activate()`) ever having run, so set
        // the delegate here too — otherwise the activation callback would
        // never reach us and `ensureActivated()` would hang.
        WCSession.default.delegate = self
        await ensureActivated()
        let session = WCSession.default
        guard session.activationState == .activated else { return .watchLinkInactive }
        // Activation completing does NOT mean the phone link is usable yet:
        // `sendMessage` requires `isReachable`, which settles a moment later.
        // A Siri ask launches this app fresh, so `deliver` waits for the flag
        // before each send; otherwise the very first send loses that race and
        // reports an unreachable phone that is actually sitting right there.
        // A question the user replaced is not queued: its answer would arrive
        // as a notification about something they have moved on from.
        return await deliverOrQueue(
            SiriAskWire.request(question: question, ref: ref),
            session: session,
            plan: RelayPlan(unreachable: .phoneUnreachable, queued: .queuedForPhone, queueWhenCancelled: false),
            onWaking: {
                WatchAskRouter.shared.report(
                    activity: SiriAskActivitySnapshot(label: SiriAskActivity.wakingPhoneLabel),
                    ref: ref
                )
            },
            send: { message, diagnostics in
                await self.send(message, session: session, ref: ref, diagnostics: diagnostics)
            }
        )
    }

    /// Relay a non-empty, trimmed note to the iPhone and return the save
    /// outcome it reports (or a watch-local relay failure). Mirrors
    /// `relayAsk`'s activation + reachability handshake; the phone saves
    /// the note through the shared capture service and replies.
    func relayNote(text: String, captureTime: NoteCaptureTime) async -> WatchNoteOutcome {
        guard WCSession.isSupported() else { return .watchLinkInactive }
        // A background App Shortcut invocation may run `perform()` without
        // the app's `activate()` ever having run, so (re)assert the delegate
        // here, exactly as the ask relay does.
        WCSession.default.delegate = self
        await ensureActivated()
        let session = WCSession.default
        guard session.activationState == .activated else { return .watchLinkInactive }
        // The message, and so its ref, is built once: every copy of this note,
        // live or queued, carries the same ref, so the phone saves it once
        // however many reach it. That is also what makes it safe to queue a
        // note the user moved on from, rather than drop it.
        return await deliverOrQueue(
            WatchNoteWire.request(text: text, captureTime: captureTime, ref: UUID().uuidString),
            session: session,
            plan: RelayPlan(unreachable: .phoneUnreachable, queued: .queuedForPhone, queueWhenCancelled: true),
            onWaking: { WatchNoteRouter.shared.wakingPhone() },
            send: { message, diagnostics in
                await self.sendNote(message, session: session, diagnostics: diagnostics)
            }
        )
    }

    /// Send `message` until the phone takes it, answers with anything but
    /// `unreachable`, or the delivery window closes — then queue it if it
    /// never arrived. Only an unreachable phone is retried: every other
    /// outcome means the phone received the relay, so a question is never
    /// asked — nor a note saved — twice.
    ///
    /// A cancelled relay (replaced by a newer one) stops at once and
    /// is queued only when the plan says so. Nothing is queued for an
    /// iPhone that can never receive it: no companion app, or no pairing.
    private func deliverOrQueue<Outcome: Equatable>(
        _ message: [String: String],
        session: WCSession,
        plan: RelayPlan<Outcome>,
        onWaking: @escaping @MainActor () -> Void,
        send: ([String: String], RelayDiagnostics) async -> Outcome
    ) async
        -> Outcome {
        let diagnostics = RelayDiagnostics()
        let started = Date()
        var attempts = 0
        var cancelled = false
        while true {
            await waitForReachability(session)
            if Task.isCancelled {
                cancelled = true
                break
            }
            attempts += 1
            let outcome = await send(message, diagnostics)
            let elapsed = Date().timeIntervalSince(started)
            let seconds = String(format: "%.1fs", elapsed)
            guard outcome == plan.unreachable else {
                log.info("Relay reached the iPhone on attempt \(attempts, privacy: .public) after \(seconds, privacy: .public)")
                return outcome
            }
            log.info(
                """
                Relay attempt \(attempts, privacy: .public) found the iPhone unreachable after \
                \(seconds, privacy: .public) (link reachable: \(session.isReachable, privacy: .public), \
                WCError \(diagnostics.lastErrorDescription, privacy: .public))
                """
            )
            if Task.isCancelled {
                cancelled = true
                break
            }
            guard !diagnostics.phoneCannotReceive,
                  let pause = WatchRelayPatience.pause(afterAttempts: attempts, elapsed: elapsed)
            else { break }
            await onWaking()
            try? await Task.sleep(nanoseconds: UInt64(pause * 1_000_000_000))
        }
        guard !cancelled || plan.queueWhenCancelled,
              !diagnostics.phoneCannotReceive,
              session.activationState == .activated,
              session.isCompanionAppInstalled
        else { return plan.unreachable }
        let envelope = WatchRelayQueue.Envelope(
            queuedAt: Date(),
            attempts: attempts,
            lastErrorCode: diagnostics.lastErrorCode
        )
        session.transferUserInfo(WatchRelayQueue.queued(message, envelope: envelope))
        log.info("Relay queued for the iPhone after \(attempts, privacy: .public) live attempts")
        return plan.queued
    }

    private func sendNote(
        _ message: [String: String],
        session: WCSession,
        diagnostics: RelayDiagnostics
    ) async
        -> WatchNoteOutcome {
        let attempt = UUID()
        return await withCheckedContinuation { continuation in
            lock.lock()
            let displaced = pendingNote
            pendingNote = PendingSend(ref: nil, attempt: attempt, continuation: continuation)
            lock.unlock()
            displaced?.continuation.resume(returning: .phoneUnreachable)
            session.sendMessage(
                message,
                replyHandler: { [weak self] reply in
                    self?.resolveNote(WatchNoteWire.outcome(from: reply), attempt: attempt)
                },
                errorHandler: { [weak self] error in
                    diagnostics.record(error)
                    self?.resolveNote(Self.mapNoteSendError(error), attempt: attempt)
                }
            )
            // Backstop: a lost reply must not spin the watch forever. This
            // fires only when the send itself did NOT error (the phone was
            // reached) but no reply arrived — the note almost certainly
            // landed, so report `reachedPhone` (a status), never a failure
            // that would nudge the user into a duplicate.
            Task { [weak self] in
                try? await Task.sleep(nanoseconds: UInt64(Self.noteRelayTimeout * 1_000_000_000))
                self?.resolveNote(.reachedPhone, attempt: attempt)
            }
        }
    }

    /// Resume the in-flight note send if `attempt` is the one still waiting —
    /// first matching caller wins, everything else is a no-op.
    private func resolveNote(_ outcome: WatchNoteOutcome, attempt: UUID) {
        lock.lock()
        guard let waiting = pendingNote, waiting.attempt == attempt else {
            lock.unlock()
            return
        }
        pendingNote = nil
        lock.unlock()
        waiting.continuation.resume(returning: outcome)
    }

    /// Classify a note `sendMessage` failure into a spoken outcome.
    /// Connectivity failures ask the user to bring the phone closer; a
    /// watch-session problem points at the watch; anything else is generic.
    static func mapNoteSendError(_ error: Error) -> WatchNoteOutcome {
        switch (error as? WCError)?.code {
        case .notReachable, .deviceNotPaired, .companionAppNotInstalled:
            .phoneUnreachable
        case .sessionNotActivated, .sessionMissingDelegate, .sessionInactive:
            .watchLinkInactive
        default:
            .relayFailed
        }
    }

    private func send(
        _ message: [String: String],
        session: WCSession,
        ref: String,
        diagnostics: RelayDiagnostics
    ) async
        -> SiriAskOutcome {
        let attempt = UUID()
        return await withCheckedContinuation { continuation in
            lock.lock()
            let displaced = pendingRelay
            pendingRelay = PendingSend(ref: ref, attempt: attempt, continuation: continuation)
            lock.unlock()
            displaced?.continuation.resume(returning: .phoneUnreachable)
            session.sendMessage(
                message,
                replyHandler: { [weak self] reply in
                    self?.resolveRelay(SiriAskWire.outcome(from: reply), ref: ref, attempt: attempt)
                },
                errorHandler: { [weak self] error in
                    diagnostics.record(error)
                    self?.resolveRelay(Self.mapSendError(error), ref: ref, attempt: attempt)
                }
            )
            // The backstop. Without it a lost reply spins the watch forever.
            Task { [weak self] in
                try? await Task.sleep(nanoseconds: UInt64(Self.relayTimeout * 1_000_000_000))
                self?.resolveRelay(.answerOnPhone, ref: ref, attempt: attempt)
            }
        }
    }

    /// Suspend until the phone link reports reachable, or the timeout elapses.
    /// Returns either way — an unreachable send still produces the spoken
    /// "couldn't reach your iPhone", so this only buys the link time to settle.
    private func waitForReachability(_ session: WCSession) async {
        guard !session.isReachable else { return }
        for _ in 0 ..< Self.reachabilityPolls where !Task.isCancelled {
            try? await Task.sleep(nanoseconds: UInt64(Self.reachabilityPollInterval * 1_000_000_000))
            if session.isReachable { return }
        }
    }

    /// Resume the in-flight relay if `ref` is the ask still waiting and, for a
    /// per-send resolver, `attempt` is the send still waiting — first matching
    /// caller wins, everything else is a no-op.
    private func resolveRelay(_ outcome: SiriAskOutcome, ref: String, attempt: UUID? = nil) {
        lock.lock()
        guard let waiting = pendingRelay, waiting.ref == ref,
              attempt == nil || waiting.attempt == attempt
        else {
            lock.unlock()
            return
        }
        pendingRelay = nil
        lock.unlock()
        waiting.continuation.resume(returning: outcome)
    }

    /// Classify a `sendMessage` failure into a spoken outcome. A reply
    /// timeout means the phone got the question but its answer outran the
    /// window — its armed push will still deliver it, so we speak the
    /// still-working line. Connectivity failures ask the user to bring the
    /// phone closer; anything else is a generic relay failure.
    static func mapSendError(_ error: Error) -> SiriAskOutcome {
        switch (error as? WCError)?.code {
        case .messageReplyTimedOut:
            .stillWorking
        case .notReachable, .deviceNotPaired, .companionAppNotInstalled:
            .phoneUnreachable
        case .sessionNotActivated, .sessionMissingDelegate, .sessionInactive:
            // The watch's own session is the problem, not the phone's distance.
            .watchLinkInactive
        default:
            .relayFailed
        }
    }

    /// Suspend until the session reaches `.activated` (or the activation
    /// timeout elapses). Returns immediately when already activated;
    /// otherwise parks a continuation that either `activationDidCompleteWith`
    /// or the timeout resumes — whichever fires first drains every parked
    /// waiter under the lock, so each continuation resumes exactly once and
    /// a terminally-failed activation can never strand the caller.
    private func ensureActivated() async {
        let session = WCSession.default
        if session.activationState == .activated { return }
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            lock.lock()
            // Re-check under the lock: activation may have completed between
            // the fast-path check and here, in which case resume now rather
            // than park a continuation nothing will wake.
            if session.activationState == .activated {
                lock.unlock()
                continuation.resume()
                return
            }
            activationWaiters.append(continuation)
            // The first parked waiter kicks activation and arms the timeout;
            // a later waiter (added while the same activation is pending)
            // rides the in-flight attempt. Once drained, the next relay
            // re-arms both.
            let isFirstWaiter = activationWaiters.count == 1
            lock.unlock()
            if isFirstWaiter {
                session.activate()
                armActivationTimeout()
            }
        }
    }

    /// Resume (and clear) every parked activation waiter. Draining under the
    /// lock makes the delegate callback and the timeout mutually exclusive —
    /// whichever runs first takes all waiters; the other drains an empty list.
    private func resumeActivationWaiters() {
        lock.lock()
        let waiters = activationWaiters
        activationWaiters.removeAll()
        lock.unlock()
        for waiter in waiters {
            waiter.resume()
        }
    }

    /// Fail-safe for an activation callback that never arrives: after the
    /// timeout, resume any still-parked waiters so `relay` can fall through
    /// to its `.activated` check (and speak `phoneUnreachable`) instead of
    /// hanging.
    private func armActivationTimeout() {
        Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(Self.activationTimeout * 1_000_000_000))
            self?.resumeActivationWaiters()
        }
    }

    // MARK: - WCSessionDelegate

    func session(
        _ session: WCSession,
        activationDidCompleteWith activationState: WCSessionActivationState,
        error: Error?
    ) {
        resumeActivationWaiters()
    }

    /// Mid-turn progress pushed by the phone (no reply expected): the tool the
    /// agent just started, so the wait can name its current step. Anything
    /// else on this channel is ignored — the ask itself travels as a reply to
    /// the watch's own `sendMessage`, never as an inbound message.
    func session(_ session: WCSession, didReceiveMessage message: [String: Any]) {
        if let result = SiriAskWire.resultOutcome(from: message) {
            // A result without a ref comes from a phone build that predates
            // correlation; accepting it blind could answer the wrong ask, so
            // it is dropped in favour of the reply or the backstop.
            if let ref = result.ref { resolveRelay(result.outcome, ref: ref) }
            return
        }
        guard let activity = SiriAskWire.activitySnapshot(from: message) else { return }
        Task { @MainActor in
            WatchAskRouter.shared.report(activity: activity.snapshot, ref: activity.ref)
        }
    }
}

/// How one kind of relay reports its two watch-side endings, and whether a
/// relay the user moved on from is still worth queueing.
private struct RelayPlan<Outcome> {
    /// The outcome of a send that never reached the phone — the one retried.
    let unreachable: Outcome
    let queued: Outcome
    let queueWhenCancelled: Bool
}

/// One registered send, resumed by whichever of its resolvers comes first.
/// `ref` names the ask it belongs to, for the phone's result message; a note
/// has none, and is only ever resolved by its own send.
private struct PendingSend<Outcome> {
    let ref: String?
    let attempt: UUID
    let continuation: CheckedContinuation<Outcome, Never>
}

/// What one relay's failed sends reported, for its log lines and its queue
/// stamp. Per relay, so a late error from an earlier relay's send cannot be
/// attributed to this one.
private final class RelayDiagnostics: @unchecked Sendable {
    private let lock = NSLock()
    private var code: WCError.Code?

    var lastErrorCode: Int? {
        lastCode?.rawValue
    }

    private var lastCode: WCError.Code? {
        lock.lock()
        defer { lock.unlock() }
        return code
    }

    var lastErrorDescription: String {
        lastErrorCode.map(String.init) ?? "none"
    }

    /// The last failure says no retry or queued copy can ever reach the
    /// phone: its app is not installed, or the watch is not paired with it.
    var phoneCannotReceive: Bool {
        switch lastCode {
        case .companionAppNotInstalled, .deviceNotPaired: true
        default: false
        }
    }

    func record(_ error: Error) {
        lock.lock()
        code = (error as? WCError)?.code
        lock.unlock()
    }
}
#endif
