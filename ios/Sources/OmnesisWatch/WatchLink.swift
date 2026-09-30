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
///   - `flushOutbox` hands the notes waiting in the durable
///     `WatchVoiceOutbox` — dictated as text, or recorded for gateway
///     dictation — to the phone, and sends them again until the phone
///     confirms each.
/// The phone owns the pairing; the watch's whole job is voice in, relay
/// out, result back.
///
/// `sendMessage(_:replyHandler:errorHandler:)` from watchOS launches the
/// iPhone app in the background if it isn't already running, so the ask
/// relay works with the phone locked. An app iOS has evicted from memory takes a
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

    /// Hard ceiling on one send. WatchConnectivity is supposed to call either
    /// the reply or the error handler, but a phone suspended after a
    /// background wake can leave both silent — and a turn that settles inside
    /// the budget arms no push, so nothing else would ever end the wait. Sits
    /// above the phone's own budget so a genuinely slow turn still reports
    /// through the normal path.
    private static let relayTimeout: TimeInterval = 70

    private let log = Logger(subsystem: "dev.omnesis.watch", category: "relay")
    private let lock = NSLock()
    /// Serializes outbox passes, which run from the main actor and from
    /// WatchConnectivity's delegate queue.
    private let outboxLock = NSLock()
    private var retryTask: Task<Void, Never>?
    /// Text notes whose live message is awaiting the phone's reply: carried,
    /// so not handed over again meanwhile.
    private var liveNoteSends: Set<String> = []
    private var activationWaiters: [CheckedContinuation<Void, Never>] = []
    /// The in-flight relay, resumed by whichever of the reply, the phone's
    /// fire-and-forget result, or the timeout arrives first. Every resolver
    /// carries the ref of the ask it belongs to: a timeout armed by an earlier
    /// ask outlives it, and would otherwise end the NEXT ask's wait with a
    /// verdict about a question already answered. Retries of one ask share
    /// its ref, so the per-send resolvers (reply, error, timeout) also carry
    /// the attempt they belong to; the phone's result names only the ask.
    private var pendingRelay: PendingSend<SiriAskOutcome>?

    /// Activate the shared session with this link as delegate. Called at
    /// app launch so the session is ready by the time Siri fires an ask or
    /// a note.
    func activate() {
        guard WCSession.isSupported() else { return }
        let session = WCSession.default
        session.delegate = self
        session.activate()
    }

    /// The gateway dictation gate the iPhone last published, once the session
    /// is active. Nil when there is none — the watch then uses system
    /// dictation.
    func dictationGate() async -> WatchDictationGate? {
        guard WCSession.isSupported() else { return nil }
        WCSession.default.delegate = self
        await ensureActivated()
        return WatchDictationGate(applicationContext: WCSession.default.receivedApplicationContext)
    }

    /// Hand every waiting note that nothing carries to WatchConnectivity,
    /// drop those that waited too long, and wake a reachable iPhone app so it
    /// receives what is outstanding (`WatchOutboxPolicy`). WatchConnectivity
    /// holds a transfer until the iPhone app runs, and carries it on after
    /// this app exits; a note leaves the outbox only when the phone confirms
    /// it — a transfer's `didFinish` without error, or its reply to a live
    /// message. Returns the refs now carried.
    @discardableResult
    func flushOutbox(_ trigger: WatchOutboxPolicy.Trigger) -> Set<String> {
        guard WCSession.isSupported() else { return [] }
        let session = WCSession.default
        guard session.activationState == .activated else { return [] }
        outboxLock.lock()
        defer { outboxLock.unlock() }
        let outbox = WatchVoiceOutbox.shared
        let transfers = session.outstandingFileTransfers
        let queuedNotes = session.outstandingUserInfoTransfers.filter { WatchNoteWire.text(from: $0.userInfo) != nil }
        var carried = Set(transfers.compactMap { $0.file.metadata?[WatchVoiceRecording.refKey] as? String })
            .union(queuedNotes.compactMap { WatchNoteWire.ref(from: $0.userInfo) })
        lock.lock()
        carried.formUnion(liveNoteSends)
        lock.unlock()
        let entries = outbox.entries()
        var dropped = 0
        for (ref, action) in WatchOutboxPolicy.plan(entries, carried: carried, trigger: trigger, now: Date()) {
            switch action {
            case .send:
                guard session.isCompanionAppInstalled, let entry = entries.first(where: { $0.ref == ref }) else { continue }
                send(entry, ref: ref, session: session)
                carried.insert(ref)
            case .drop:
                transfers.filter { $0.file.metadata?[WatchVoiceRecording.refKey] as? String == ref }.forEach { $0.cancel() }
                queuedNotes.filter { WatchNoteWire.ref(from: $0.userInfo) == ref }.forEach { $0.cancel() }
                carried.remove(ref)
                outbox.drop(ref)
                dropped += 1
            case .wait:
                break
            }
        }
        if dropped > 0 {
            log.error("Dropped \(dropped, privacy: .public) notes that waited too long for the iPhone")
            Task { @MainActor in WatchVoiceCapture.shared.showDroppedIfNeeded() }
        }
        // A transfer alone may not start the iPhone app; a message does.
        if !carried.isEmpty, session.isReachable {
            session.sendMessage(WatchVoiceFormat.nudgeMessage, replyHandler: nil) { _ in }
        }
        scheduleRetry(WatchOutboxPolicy.nextRetry(outbox.entries(), carried: carried, now: Date()))
        return carried
    }

    /// Hand one waiting note over (`WatchOutboxPolicy.transport`). A text
    /// note to a reachable iPhone goes as a live message, so the phone's reply
    /// confirms it at once; when that message fails it goes on the queued
    /// channel instead. Every copy carries the note's ref, so the phone saves
    /// it once.
    private func send(_ entry: WatchOutboxPolicy.Entry, ref: String, session: WCSession) {
        switch WatchOutboxPolicy.transport(for: entry, phoneReachable: session.isReachable) {
        case .file:
            session.transferFile(WatchVoiceOutbox.shared.audioURL(ref), metadata: entry.metadata)
        case .queuedTransfer:
            session.transferUserInfo(Self.queued(entry))
        case .liveMessage:
            lock.lock()
            liveNoteSends.insert(ref)
            lock.unlock()
            session.sendMessage(
                entry.metadata,
                replyHandler: { [weak self] _ in
                    // Any reply means the phone has the note.
                    self?.liveNoteSettled(ref)
                    WatchVoiceOutbox.shared.remove(ref)
                },
                errorHandler: { [weak self] error in
                    guard let self else { return }
                    self.log.info("Live note send failed, queueing it: \(String(describing: error), privacy: .public)")
                    self.liveNoteSettled(ref)
                    if WCSession.default.activationState == .activated {
                        WCSession.default.transferUserInfo(Self.queued(entry))
                    }
                }
            )
        }
    }

    private func liveNoteSettled(_ ref: String) {
        lock.lock()
        liveNoteSends.remove(ref)
        lock.unlock()
    }

    /// A text note's queued-channel payload: its message, stamped with when
    /// it joined the outbox.
    private static func queued(_ entry: WatchOutboxPolicy.Entry) -> [String: String] {
        WatchRelayQueue.queued(entry.metadata, envelope: .init(queuedAt: entry.queuedAt, attempts: 0, lastErrorCode: nil))
    }

    /// Run the outbox again when the next backed-off note falls due, while
    /// the app is running; a relaunch or the link coming back does it too.
    private func scheduleRetry(_ due: Date?) {
        retryTask?.cancel()
        guard let due else { return }
        retryTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(max(1, due.timeIntervalSinceNow)))
            guard !Task.isCancelled else { return }
            self?.flushOutbox(.retry)
        }
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
            plan: RelayPlan(unreachable: .phoneUnreachable, queued: .queuedForPhone),
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

    /// Send `message` until the phone takes it, answers with anything but
    /// `unreachable`, or the delivery window closes — then queue it if it
    /// never arrived. Only an unreachable phone is retried: every other
    /// outcome means the phone received the relay, so a question is never
    /// asked twice.
    ///
    /// A cancelled relay (replaced by a newer question) stops at once and is
    /// not queued: its answer would arrive about something the person moved
    /// on from. Nothing is queued for an iPhone that can never receive it: no
    /// companion app, or no pairing.
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
        guard !cancelled,
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
        if activationState == .activated { flushOutbox(.linkMayHaveChanged) }
    }

    /// A recording transfer ended. Delivered, the note leaves the outbox; a
    /// failed one stays, and is sent again after a backoff — the next launch,
    /// the iPhone becoming reachable, or the backoff running out.
    func session(_ session: WCSession, didFinish fileTransfer: WCSessionFileTransfer, error: Error?) {
        guard let ref = fileTransfer.file.metadata?[WatchVoiceRecording.refKey] as? String else { return }
        if let error {
            log.error("Recording transfer failed, will retry: \(String(describing: error), privacy: .public)")
            WatchVoiceOutbox.shared.recordFailure(ref)
            flushOutbox(.retry)
        } else {
            WatchVoiceOutbox.shared.remove(ref)
        }
    }

    /// The iPhone app became reachable: hand over what waits, and wake it
    /// for what is outstanding.
    func sessionReachabilityDidChange(_ session: WCSession) {
        guard session.isReachable else { return }
        flushOutbox(.linkMayHaveChanged)
    }

    func sessionCompanionAppInstalledDidChange(_ session: WCSession) {
        flushOutbox(.linkMayHaveChanged)
    }

    /// A queued relay ended. A text note the phone received leaves the
    /// outbox; one that failed stays, and is sent again after a backoff. A
    /// queued question is not retried — its answer would come long after it
    /// mattered.
    func session(_ session: WCSession, didFinish userInfoTransfer: WCSessionUserInfoTransfer, error: Error?) {
        guard WatchNoteWire.text(from: userInfoTransfer.userInfo) != nil,
              let ref = WatchNoteWire.ref(from: userInfoTransfer.userInfo)
        else { return }
        if let error {
            log.error("Queued note transfer failed, will retry: \(String(describing: error), privacy: .public)")
            WatchVoiceOutbox.shared.recordFailure(ref)
            flushOutbox(.retry)
        } else {
            WatchVoiceOutbox.shared.remove(ref)
        }
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

/// How a relay reports its two watch-side endings.
private struct RelayPlan<Outcome> {
    /// The outcome of a send that never reached the phone — the one retried.
    let unreachable: Outcome
    let queued: Outcome
}

/// One registered send, resumed by whichever of its resolvers comes first.
/// `ref` names the ask it belongs to, for the phone's result message.
private struct PendingSend<Outcome> {
    let ref: String
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
