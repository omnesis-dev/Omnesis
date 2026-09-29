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
///
/// With gateway dictation on, the watch sends a recording instead of text
/// (`transferFile`), and does not wait for it. The recording is kept in the
/// `WatchVoiceInbox`, transcribed — by the gateway, or on this device when
/// the gateway cannot — and then goes the way a queued relay does. The
/// receiver also keeps the watch told whether to record for the gateway,
/// through the session's application context, and goes by the same gate
/// itself when a recording arrives.
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
    private let voiceInbox = WatchVoiceInbox()
    private let gateStore = WatchDictationGateStore()
    /// How long a recording waits for a fresh read of the gateway's status
    /// when the phone has never known the gate.
    private static let statusRefreshTimeout: Duration = .seconds(8)

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
        // Recordings a previous process received but did not finish, claimed
        // before the session can deliver new ones.
        for item in voiceInbox.claimLeftovers() {
            processRecording(item)
        }
        let session = WCSession.default
        session.delegate = self
        session.activate()
    }

    /// Record what the phone now knows about gateway dictation, and tell the
    /// watch when it changed (`WatchGatePublishing`). Called with the gate
    /// read from the gateway's status — never while that status is unknown.
    func update(_ gate: WatchDictationGate) {
        guard WatchGatePublishing.shouldPublish(gate, after: gateStore.load(), now: now()) else { return }
        gateStore.save(gate)
        sendGateToWatch()
    }

    /// Put the stored gate in the session's application context, when a
    /// watch app can receive it. Repeated at activation and whenever the
    /// watch's state changes, so a watch app installed or paired later
    /// learns it too.
    private func sendGateToWatch() {
        guard WCSession.isSupported(), let gate = gateStore.load() else { return }
        let session = WCSession.default
        guard session.activationState == .activated, session.isPaired, session.isWatchAppInstalled else { return }
        do {
            try session.updateApplicationContext(gate.applicationContext)
        } catch {
            log.error("Could not publish the dictation gate to the watch: \(String(describing: error), privacy: .public)")
        }
    }

    /// Seconds since this process started listening, for the relay log.
    private var sinceListening: String {
        String(format: "%.1fs", now().timeIntervalSince(listeningSince))
    }

    /// Record a relay's `ref` as handled; false when it already was.
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
        if activationState == .activated { sendGateToWatch() }
    }

    public func sessionWatchStateDidChange(_ session: WCSession) {
        sendGateToWatch()
    }

    /// The watch's wake-up message sent beside a recording transfer. Nothing
    /// to do: being woken is the point, and the transfer follows.
    public func session(_ session: WCSession, didReceiveMessage message: [String: Any]) {}

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
            handleNote(noteText, captureTime: captureTime, id: WatchNoteWire.ref(from: message)) {
                replyHandler(WatchNoteWire.reply(for: $0))
            }
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

    /// A relay the watch queued after its live sends failed. A note is saved
    /// like a live one; a question is handed to the gateway, and how it ended
    /// reaches the person as a notification.
    public func session(_ session: WCSession, didReceiveUserInfo userInfo: [String: Any]) {
        log.info("Queued watch relay received \(self.sinceListening, privacy: .public) after launch")
        let handler = WatchQueuedRelayHandler(
            route: { payload in
                self.lock.lock()
                defer { self.lock.unlock() }
                return WatchRelayInbox.route(queued: payload, now: self.now(), handled: &self.handledRefs)
            },
            saveNote: { text, captureTime, id in await self.saveNote(text, captureTime: captureTime, id: id) },
            ask: { await self.handOff($0) },
            notify: { await self.notify($0) }
        )
        let payload = userInfo
        Task {
            let assertion = WatchRelayBackgroundAssertion()
            await assertion.begin()
            let action = await handler.handle(payload)
            self.log.info("Queued watch relay settled as \(String(describing: action), privacy: .private)")
            await assertion.end()
        }
    }

    /// A recording the watch made for gateway dictation. WatchConnectivity
    /// deletes the file once this returns, so it is moved into the inbox
    /// before anything else.
    public func session(_ session: WCSession, didReceive file: WCSessionFile) {
        log.info("Watch recording received \(self.sinceListening, privacy: .public) after launch")
        guard let item = voiceInbox.admit(file: file.fileURL, metadata: file.metadata ?? [:]) else {
            log.error("Could not keep a watch recording")
            return
        }
        processRecording(item)
    }

    private func processRecording(_ item: WatchVoiceInbox.Item) {
        let pipeline = WatchVoicePipeline(
            gatewayRoute: { await self.gatewayRoute() },
            transcribeOnDevice: { await OnDeviceFileTranscriber.transcribe($0, locale: $1) },
            saveNote: { text, captureTime, id in await self.saveNote(text, captureTime: captureTime, id: id) },
            ask: { await self.handOff($0) },
            notify: { await self.notify($0) },
            claim: { self.claim($0) },
            now: now
        )
        let inbox = voiceInbox
        Task {
            let assertion = WatchRelayBackgroundAssertion()
            await assertion.begin()
            let outcome = await pipeline.handle(item, inbox: inbox)
            self.log.info("Watch recording settled as \(String(describing: outcome), privacy: .private)")
            await assertion.end()
        }
    }

    /// The gateway to transcribe a watch recording with: this phone's
    /// pairing, while the gate it last published is on. A phone that has
    /// never known the gate reads the gateway's status first, briefly. A gate
    /// switched off since then answers the upload with a refusal, and the
    /// recording is transcribed on the device instead.
    private func gatewayRoute() async -> GatewayDictationRoute? {
        guard let pairing = (try? PairingService().current()).flatMap({ $0 }) else { return nil }
        let gate = await WatchVoiceRouting.gate(stored: gateStore.load()) {
            await self.readGate(pairing: pairing)
        }
        return WatchVoiceRouting.route(
            gate: gate,
            transcriber: DictationClient(baseURL: pairing.url, token: pairing.token)
        )
    }

    /// The gate the gateway's status implies right now, recorded and passed
    /// on to the watch; nil when the status could not be read in time.
    private func readGate(pairing: Pairing) async -> WatchDictationGate? {
        let client = SearchClient(baseURL: pairing.url, token: pairing.token)
        let status = await withTaskGroup(of: StatusSnapshot?.self) { group in
            group.addTask { try? await client.getStatus() }
            group.addTask {
                try? await Task.sleep(for: Self.statusRefreshTimeout)
                return nil
            }
            let first = await group.next().flatMap { $0 }
            group.cancelAll()
            return first
        }
        guard let status else { return nil }
        let gate = WatchGatePublishing.gate(status: status.dictation, statusKnown: true, paired: true, now: now())
        if let gate { update(gate) }
        return gate
    }

    /// A question nobody is waiting on: asked on the gateway, and announced
    /// by the gateway's slow-answer push or, when that will not come, a
    /// local notification.
    private func handOff(_ question: String) async {
        let (outcome, conversationId) = await makeHandOffRunner().handOff(question: question)
        log.info("Watch hand-off settled as \(outcome.tag, privacy: .public)")
        guard let notice = QueuedAskNotice.notice(for: outcome, conversationId: conversationId) else { return }
        await post(title: notice.title, body: notice.body, userInfo: notice.userInfo)
    }

    private func notify(_ notice: WatchVoiceNotice) async {
        switch notice {
        case .untranscribed(.note):
            await post(
                title: "Couldn't transcribe your note",
                body: "Your watch recording couldn't be turned into text, so nothing was saved.",
                userInfo: [:]
            )
        case .untranscribed(.ask):
            await post(
                title: "Couldn't transcribe your question",
                body: "Your watch recording couldn't be turned into text, so nothing was asked.",
                userInfo: [:]
            )
        case .questionExpired:
            await post(
                title: "Your watch question wasn't asked",
                body: "It reached your iPhone too late to be worth answering. Ask it again if you still need to.",
                userInfo: [:]
            )
        }
    }

    private func post(title: String, body: String, userInfo: [String: Any]) async {
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.sound = .default
        content.userInfo = userInfo
        let request = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
        do {
            try await notifications.add(request)
        } catch {
            log.error("Could not post a watch relay notification: \(String(describing: error), privacy: .public)")
        }
    }

    /// Save a watch note through the shared capture service. The phone
    /// attaches its own location (the watch relays none), so a watch note is
    /// geotagged like one captured on the phone. Background, no UI — never
    /// prompts; a locked or suspended phone may serve no fix, and the note is
    /// then saved without one.
    ///
    /// `id` is the relay's ref: sent as the note's idempotency key when it
    /// is a UUID, so a note saved again after an interruption is not saved
    /// twice.
    @discardableResult
    private func saveNote(_ text: String, captureTime: NoteCaptureTime, id: String?) async -> WatchNoteOutcome {
        let location = await NoteLocationProvider.shared.current(promptIfNeeded: false)
        let outcome = await WatchNoteOutcome(capture: NoteCaptureService.captureStandalone(
            text: text,
            surface: .watch,
            captureTime: captureTime,
            location: location,
            noteId: id.flatMap(UUID.init(uuidString:))?.uuidString.lowercased()
        ))
        log.info("Watch note settled as \(outcome.tag, privacy: .public)")
        return outcome
    }

    /// Save a note the watch sent live and report the result, holding a
    /// background assertion for the save.
    private func handleNote(
        _ text: String,
        captureTime: NoteCaptureTime,
        id: String?,
        completion: @escaping (WatchNoteOutcome) -> Void
    ) {
        Task {
            let assertion = WatchRelayBackgroundAssertion()
            await assertion.begin()
            await completion(self.saveNote(text, captureTime: captureTime, id: id))
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
