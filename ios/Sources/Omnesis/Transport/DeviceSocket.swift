// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// The temporary state: no session is up and retries are expected to restore one.
public struct DeviceSocketReconnectStatus: Equatable, Sendable {
    public enum Network: Equatable, Sendable {
        case unknown, available, unavailable
    }

    public let network: Network
    /// The most recent attempt's failure, kept for diagnosis.
    public let lastError: String?
    /// Failures while the network looked usable, since it last changed.
    public let failedAttemptsOnNetwork: Int

    public init(network: Network, lastError: String?, failedAttemptsOnNetwork: Int) {
        self.network = network
        self.lastError = lastError
        self.failedAttemptsOnNetwork = failedAttemptsOnNetwork
    }
}

/// A refusal that retries are unlikely to change on their own.
public struct DeviceSocketFailure: Equatable, Sendable {
    public enum Kind: Equatable, Sendable {
        case authentication, certificate, incompatible
    }

    public let kind: Kind
    public let detail: String

    public init(kind: Kind, detail: String) {
        self.kind = kind
        self.detail = detail
    }
}

/// Bidirectional WebSocket client for the gateway's `/device/ws` endpoint.
///
/// Protocol (see `packages/core/src/ws-messages.ts` for the typed registry):
///   1. Connect with `Authorization: Bearer <token>` on the HTTP upgrade.
///   2. Send command `{kind:"command", id, type:"hello",
///      payload:{capabilities?, protocolVersion: 1}}`.
///   3. Await `{kind:"response", correlationId, ok:true,
///      result:{deviceId, scopes, deviceName, deviceKind, protocolVersion}}`.
///      `protocolVersion` mismatch yields `ok:false`,
///      `error.code = "protocol_version_mismatch"`.
///   4. Receive events: `{kind:"event", type, payload}` — route to the UI.
///
/// Reconnects by itself for as long as it is started. The lifecycle contract:
///
///   - A failed attempt waits out `DeviceSocketReconnectPolicy`'s backoff, and
///     every attempt spends from its budget, whatever triggered it.
///   - Network-path changes and `appDidBecomeActive()` are advisory wake signals.
///     They shorten a pending wait or replace a stale attempt, but only the
///     hello response counts as being connected. On an open socket they send a
///     bounded ping instead, because a socket that crossed an outage can look
///     open with no peer behind it.
///   - `.reconnecting` is the temporary state; `.failed` means retries continue
///     but are unlikely to help until something else changes.
///   - A routed pairing proves its loopback endpoint before the retry that
///     follows a wake signal or a refused connection (`GatewayRoutingCheck`).
///   - Each attempt goes through the one connector built at init, so a retry can
///     never use a different transport, token or TLS trust than the pairing's.
///   - `stop()` is terminal: no later signal, timer or callback has any effect.
///
/// The `events` AsyncStream keeps yielding across reconnects.
@available(iOS 17.0, *)
public actor DeviceSocket {
    public enum ConnectionState: Equatable, Sendable {
        case disconnected
        case connecting
        case authenticating
        case connected(deviceId: String, deviceName: String, scopes: [String])
        /// No session is up and automatic retries are expected to restore one.
        case reconnecting(ReconnectStatus)
        /// No session is up and the gateway's answer points at something a
        /// retry alone is unlikely to change.
        case failed(Failure)
    }

    public typealias ReconnectStatus = DeviceSocketReconnectStatus
    public typealias Failure = DeviceSocketFailure

    /// A raw event from the gateway. The `type` field routes to a handler;
    /// `payload` is the parsed JSON value (caller decodes further).
    public struct Event: Sendable, Equatable {
        public let type: String
        public let payload: JSONValue
    }

    /// Wire protocol version this client speaks. Must match the gateway's
    /// `PROTOCOL_VERSION` exported from `@omnesis/core/ws-messages.ts`. Bump
    /// in lockstep with the gateway when the registry shape changes
    /// incompatibly.
    static let protocolVersion: Int = 1 // PARITY:device-ws-protocol-version

    private let url: URL
    private let token: String
    private let connector: any DeviceSocketConnector
    let capabilities: PairingCapabilities
    let expectedDeviceId: String?
    let routingOwner: (any GatewaySocketRouting)?
    let hintRefresher: (any GatewayDirectHintRefreshing)?
    let promotionClock: any GatewayPromotionWaiting
    var routeObserver: UUID?
    var routingCheck = GatewayRoutingCheck()
    var promotionTask: Task<Void, Never>?
    public nonisolated let pathChanges: AsyncStream<GatewayConnectionPath>
    let pathContinuation: AsyncStream<GatewayConnectionPath>.Continuation
    private var connectionGeneration = UUID()
    let heartbeatInterval: Duration?
    private var heartbeatTask: Task<Void, Never>?
    private let pathObserver: any NetworkPathObserving
    private let clock: any DeviceSocketClock
    private let randomUnit: @Sendable () -> Double

    /// Public channel of events. The single consumer is typically the app
    /// store; callers iterate with `for await event in socket.events`.
    /// `nonisolated` so callers can subscribe without awaiting actor state.
    public nonisolated let events: AsyncStream<Event>
    let eventsContinuation: AsyncStream<Event>.Continuation

    public nonisolated let stateChanges: AsyncStream<ConnectionState>
    private let stateContinuation: AsyncStream<ConnectionState>.Continuation

    /// What the run loop is doing, which decides what a wake signal means.
    private enum Phase {
        case idle
        case attempting(any DeviceSocketConnection, startedAt: Duration)
        case authenticated(any DeviceSocketConnection)
        case waiting(until: Duration)
    }

    private enum AttemptOutcome {
        /// Replaced or stopped; says nothing about the gateway.
        case superseded
        case failed(DeviceSocketAttemptFailure)
    }

    private var phase: Phase = .idle
    private var runner: Task<Void, Never>?
    private var pathTask: Task<Void, Never>?
    private var policy: DeviceSocketReconnectPolicy
    private var currentState: ConnectionState = .disconnected
    private var stopped = false

    private var currentPath: NetworkPathSnapshot?
    private var isForeground = true
    /// A path was restored while backgrounded; the next foreground acts on it.
    private var restoredWhileBackgrounded = false
    private var failedAttemptsOnNetwork = 0
    private var lastConnectionError: String?

    /// The next attempt should not wait out the backoff.
    private var retryWithoutBackoff = false
    /// This session's attempt was cancelled here; its outcome is meaningless.
    private var attemptSuperseded = false
    /// The upgrade or hello took too long and the attempt was cancelled here.
    private var helloTimedOut = false
    private var helloTimer: Task<Void, Never>?
    /// The open connection failed its ping and was cancelled here.
    private var connectionProbeFailed = false

    /// Runs a `source.sync` for the named source. Late-bound by
    /// `AdminCoordinator` because the collector lives on the other side of the
    /// app; unset (previews, tests) means this build hosts nothing.
    private(set) var onSyncRequested: (@Sendable (String) async -> SyncDispatch)?

    private var waitContinuation: CheckedContinuation<Void, Never>?
    private var waitTimer: Task<Void, Never>?
    private var waitTimerID = UUID()
    /// Identifies the ping awaiting an answer. A pong or timeout for any other
    /// id belongs to a ping that no longer matters.
    private var probeID: UUID?
    private var probeTimer: Task<Void, Never>?

    let log = AppLog.make(category: "transport.ws")

    init(
        gatewayUrl: URL,
        token: String,
        connector: any DeviceSocketConnector,
        capabilities: PairingCapabilities = .ios(),
        pathObserver: any NetworkPathObserving,
        clock: any DeviceSocketClock,
        limits: DeviceSocketReconnectPolicy.Limits = .init(),
        routingOwner: (any GatewaySocketRouting)? = nil,
        expectedDeviceId: String? = nil,
        promotionClock: any GatewayPromotionWaiting = GatewayPromotionClock(),
        hintRefresher: (any GatewayDirectHintRefreshing)? = nil,
        heartbeatInterval: Duration? = nil,
        randomUnit: @escaping @Sendable () -> Double = { Double.random(in: 0 ... 1) }
    ) {
        self.url = DeviceSocket.deriveWsURL(from: gatewayUrl)
        self.token = token
        self.connector = connector
        self.capabilities = capabilities
        self.routingOwner = routingOwner
        self.expectedDeviceId = expectedDeviceId
        self.promotionClock = promotionClock
        self.hintRefresher = hintRefresher
        self.heartbeatInterval = heartbeatInterval
        var pathContinuation: AsyncStream<GatewayConnectionPath>.Continuation!
        self.pathChanges = AsyncStream { pathContinuation = $0 }
        self.pathContinuation = pathContinuation
        self.pathObserver = pathObserver
        self.clock = clock
        self.policy = DeviceSocketReconnectPolicy(limits: limits)
        self.randomUnit = randomUnit

        var econt: AsyncStream<Event>.Continuation!
        self.events = AsyncStream { econt = $0 }
        self.eventsContinuation = econt

        var scont: AsyncStream<ConnectionState>.Continuation!
        self.stateChanges = AsyncStream { scont = $0 }
        self.stateContinuation = scont
    }

    deinit {
        eventsContinuation.finish()
        stateContinuation.finish()
        pathContinuation.finish()
        promotionTask?.cancel()
        heartbeatTask?.cancel()
        routingOwner?.retireRouting()
    }

    /// Start the connect / reconnect loop. Safe to call once — subsequent
    /// calls are no-ops. A stopped socket is terminal; pairing rebuilds create
    /// a new instance. This also makes stop-before-start safe when teardown
    /// races the coordinator's asynchronous startup task.
    public func start() {
        guard !stopped, runner == nil else { return }
        startRouting()
        runner = Task { [weak self] in
            await self?.runLoop()
        }
        let observer = pathObserver
        pathTask = Task { [weak self] in
            for await path in observer.paths() {
                await self?.handlePath(path)
            }
        }
    }

    /// Close the socket and stop reconnecting.
    public func stop() {
        stopped = true
        connectionGeneration = UUID()
        retireRouting()
        cancelHeartbeat()
        pathTask?.cancel()
        pathTask = nil
        endProbe()
        switch phase {
        case .attempting(let connection, _), .authenticated(let connection):
            connection.cancel()
        case .idle, .waiting:
            break
        }
        phase = .idle
        runner?.cancel()
        runner = nil
        finishWait()
        updateState(.disconnected)
    }

    /// The user returned to the app, so a retry parked on a long backoff should
    /// not make them wait and an open socket should prove it is still alive.
    public func appDidBecomeActive() {
        guard !stopped else { return }
        isForeground = true
        if restoredWhileBackgrounded {
            restoredWhileBackgrounded = false
            wake(.connectivityRestored)
        }
        wake(.foreground)
    }

    /// Path changes wait for the next foreground from here on: nobody is looking
    /// at the connection, and the backoff schedule keeps running regardless.
    public func appDidEnterBackground() {
        guard !stopped else { return }
        isForeground = false
    }

    /// Wire the sync dispatcher. Called once per socket, before `start()`.
    public func setOnSyncRequested(_ handler: (@Sendable (String) async -> SyncDispatch)?) {
        self.onSyncRequested = handler
    }

    public func state() -> ConnectionState {
        currentState
    }

    var frameGeneration: UUID {
        connectionGeneration
    }

    var routeIsActive: Bool {
        !stopped
    }

    func requireCurrentFrame(generation: UUID) throws {
        guard !stopped, !Task.isCancelled, generation == connectionGeneration else { throw CancellationError() }
    }

    /// Route promotion replaces only this socket and spends the normal attempt budget.
    @discardableResult
    func requestRouteReplacement(generation: UUID) -> Bool {
        guard !stopped, runner != nil, generation == connectionGeneration,
              case .authenticated(let connection) = phase else { return false }
        connectionGeneration = UUID()
        attemptSuperseded = true
        retryWithoutBackoff = true
        endProbe()
        cancelHeartbeat()
        phase = .idle
        updateState(.connecting)
        connection.cancel()
        return true
    }

    /// Resolves true once the socket has completed a hello. The gateway
    /// refreshes the device's stored capabilities before it acknowledges the
    /// hello, so a connected socket means the capability row is fresh — a
    /// consent tap that waits for this can no longer outrun it. Polls the
    /// actor-isolated state rather than the stateChanges stream so a stale
    /// buffered event can never satisfy the wait.
    public func waitUntilConnected(timeout: Duration = .seconds(10)) async -> Bool {
        if case .connected = currentState { return true }
        let start = ContinuousClock().now
        while !Task.isCancelled {
            if case .connected = currentState { return true }
            if ContinuousClock().now - start >= timeout { break }
            try? await Task.sleep(for: .milliseconds(200))
        }
        // A cancel racing a connect must not satisfy the wait: the caller's
        // tap is dead, and no retry may be issued on its behalf.
        if Task.isCancelled { return false }
        if case .connected = currentState { return true }
        return false
    }

    #if DEBUG
    func runnerActiveForTesting() -> Bool {
        runner != nil
    }

    func currentPathForTesting() -> NetworkPathSnapshot? {
        currentPath
    }
    #endif

    /// Send an event frame upstream to the gateway.
    ///
    /// Mirror of the desktop collector's `wsClient.emitEvent(type, payload)`:
    /// produces a `{kind:"event", type, payload}` frame that the gateway
    /// routes through `onDeviceEvent`. Used by CollectorCore to publish
    /// `sync.status` lifecycle events so the gateway's SyncStatusRegistry
    /// (and therefore `/admin/sync/status` + the portal / CLI)
    /// reflect the iOS-side sync in real time.
    ///
    /// Drops silently if the socket isn't currently connected — the gateway
    /// maintains last-known state, a missed frame just means the portal
    /// shows stale info until the next sync lifecycle event lands.
    public func emitEvent(type: String, payload: [String: JSONValue]) async {
        guard case .authenticated(let connection) = phase else {
            log.debug("emitEvent dropped (no active socket): \(type, privacy: .public)")
            return
        }
        let frame: [String: JSONValue] = [
            "kind": .string("event"),
            "type": .string(type),
            "payload": .object(payload),
        ]
        do {
            try await send(object: frame, via: connection)
        } catch {
            log.warning("emitEvent(\(type, privacy: .public)) failed: \(String(describing: error), privacy: .private)")
        }
    }

    nonisolated static func helloCommand(
        id: String,
        capabilities: PairingCapabilities = .ios()
    )
        -> [String: JSONValue] {
        [
            "kind": .string("command"),
            "id": .string(id),
            "type": .string("hello"),
            "payload": .object([
                "capabilities": .object(capabilities.jsonObject),
                "protocolVersion": .int(Int64(protocolVersion)),
            ]),
        ]
    }

    // MARK: - Main loop

    private func runLoop() async {
        while !Task.isCancelled, !stopped {
            policy.recordAttemptStarted(at: clock.now)
            retryWithoutBackoff = false
            attemptSuperseded = false
            helloTimedOut = false
            connectionProbeFailed = false
            let outcome = await runAttempt()
            if Task.isCancelled || stopped { break }

            if case .failed(let failure) = outcome {
                policy.recordFailure(failure)
                record(failure)
            }
            // A refusal keeps its earned wait even if a wake arrived mid-attempt.
            let skipsBackoff = isSuperseded(outcome)
                || (retryWithoutBackoff && policy.accepts(.connectivityRestored))
            let backoff: Duration = skipsBackoff ? .zero : policy.retryDelay(jitter: randomUnit())
            await waitForNextAttempt(atLeast: backoff)
            await verifyRoutingIfNeeded()
        }
    }

    private func isSuperseded(_ outcome: AttemptOutcome) -> Bool {
        if case .superseded = outcome { return true }
        return false
    }

    /// Runs one connection from upgrade until it ends. Every step re-checks
    /// whether this attempt still counts, because a late answer on a connection
    /// that was replaced or stopped must not change anything.
    private func runAttempt() async -> AttemptOutcome {
        var request = URLRequest(url: url)
        request.timeoutInterval = 30
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")

        connectionGeneration = UUID()
        let generation = connectionGeneration
        publishAttemptProgress(.connecting)
        let connection = connector.open(request)
        phase = .attempting(connection, startedAt: clock.now)
        armHelloTimer(for: connection)
        defer {
            connection.cancel()
            endProbe()
            cancelHeartbeat()
            cancelHelloTimer()
            if !stopped { phase = .idle }
        }

        publishAttemptProgress(.authenticating)
        let helloId = UUID().uuidString
        var authenticated = false
        do {
            try await send(object: Self.helloCommand(id: helloId, capabilities: capabilities), via: connection)
            while !Task.isCancelled, !stopped, !attemptSuperseded {
                let message = try await connection.receive()
                guard !Task.isCancelled, !stopped, !attemptSuperseded else { return .superseded }
                try requireCurrentFrame(generation: generation)
                guard let frame = decodeFrame(message) else { continue }

                if authenticated {
                    await handleAuthenticatedFrame(frame, via: connection)
                } else if case .response(let response) = frame, response.correlationId == helloId {
                    // Anything else before the hello response is ignored.
                    try completeHello(response, on: connection)
                    authenticated = true
                }
            }
            return .superseded
        } catch {
            if Task.isCancelled || stopped || attemptSuperseded { return .superseded }
            log.warning("WS connection ended: \(String(describing: error), privacy: .private)")
            noteRoutingFailure(error, at: clock.now)
            if connectionProbeFailed {
                return .failed(.network(detail: URLError(.networkConnectionLost).localizedDescription))
            }
            if helloTimedOut {
                return .failed(.network(detail: "The gateway didn't answer in time."))
            }
            return .failed(.classify(
                error,
                handshakeStatus: connection.handshakeStatus,
                helloCompleted: authenticated
            ))
        }
    }

    private func completeHello(_ response: WsResponseFrame, on connection: any DeviceSocketConnection) throws {
        switch response.body {
        case .ok(let result):
            let deviceId = extractString(result["deviceId"]) ?? ""
            guard expectedDeviceId == nil || expectedDeviceId == deviceId else {
                throw DeviceSocketAttemptFailure.HelloRejection(
                    code: "device_not_found", message: "The gateway answered for a different device."
                )
            }
            let deviceName = extractString(result["deviceName"]) ?? ""
            let scopes = extractStringArray(result["scopes"]) ?? []
            cancelHelloTimer()
            policy.recordConnected()
            failedAttemptsOnNetwork = 0
            lastConnectionError = nil
            retryWithoutBackoff = false
            phase = .authenticated(connection)
            updateState(.connected(deviceId: deviceId, deviceName: deviceName, scopes: scopes))
            armHeartbeat(on: connection)
            didAuthenticateRouting()
            log.info("WS authenticated as \(deviceName, privacy: .public) (\(deviceId, privacy: .public))")
        case .err(let error):
            throw DeviceSocketAttemptFailure.HelloRejection(code: error.code, message: error.message)
        }
    }

    /// Post-auth: one switch covers all three frame kinds.
    ///   * `event`   → forward to the app's event stream.
    ///   * `command` → gateway wants us to act (source.debug / source.sync /
    ///                 sources.snapshot / …). We MUST respond — even with
    ///                 ok:false — or the gateway's sendCommand hangs for 30s and
    ///                 surfaces a timeout to whichever admin client called us.
    ///   * `response`→ reply to a command we sent (currently only `hello`,
    ///                 already handled). Ignore.
    private func handleAuthenticatedFrame(_ frame: WsFrame, via connection: any DeviceSocketConnection) async {
        switch frame {
        case .event(let event):
            if event.type == "ping" { return }
            eventsContinuation.yield(Event(type: event.type, payload: event.payload))
        case .command(let command):
            await handleIncomingCommand(command, via: connection)
        case .response:
            break
        }
    }
}

@available(iOS 17.0, *)
extension DeviceSocket {
    // MARK: - Waiting and waking

    /// Waits for the backoff and the budget, whichever is later. A wake signal
    /// can shorten the wait, but never to before the budget allows an attempt.
    private func waitForNextAttempt(atLeast backoff: Duration) async {
        let delay = max(backoff, policy.budgetDelay(at: clock.now))
        guard delay > .zero else { return }
        log.info("WS reconnect in \(delay.description, privacy: .public)")
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            waitContinuation = continuation
            phase = .waiting(until: clock.now + delay)
            armWaitTimer(after: delay)
        }
        if !stopped { phase = .idle }
    }

    private func armWaitTimer(after delay: Duration) {
        waitTimer?.cancel()
        let id = UUID()
        waitTimerID = id
        let clock = clock
        waitTimer = Task { [weak self] in
            do {
                try await clock.sleep(for: delay)
            } catch {
                return
            }
            await self?.waitTimerFired(id)
        }
    }

    private func waitTimerFired(_ id: UUID) {
        if id == waitTimerID { finishWait() }
    }

    private func finishWait() {
        waitTimer?.cancel()
        waitTimer = nil
        let continuation = waitContinuation
        waitContinuation = nil
        continuation?.resume()
    }

    private func handlePath(_ path: NetworkPathSnapshot) {
        guard !stopped else { return }
        let transition = path.transition(from: currentPath)
        currentPath = path
        // A connected socket stays as it is on `.lost`: only the socket itself
        // can say the session ended, and a brief loss may not end it.
        if case .reconnecting = currentState { publishReconnecting() }
        guard transition == .restored else { return }
        if isForeground {
            wake(.connectivityRestored)
        } else {
            restoredWhileBackgrounded = true
        }
    }

    private func wake(_ signal: DeviceSocketReconnectPolicy.WakeSignal) {
        guard runner != nil else { return }
        noteRoutingWake()
        if case .authenticated(let connection) = phase {
            startProbe(on: connection)
            return
        }
        guard policy.accepts(signal) else { return }
        if signal == .connectivityRestored {
            policy.connectivityRestored()
            failedAttemptsOnNetwork = 0
            if case .reconnecting = currentState { publishReconnecting() }
        }
        let now = clock.now
        switch phase {
        case .waiting(let deadline):
            let budget = policy.budgetDelay(at: now)
            if budget == .zero {
                finishWait()
            } else if now + budget < deadline {
                phase = .waiting(until: now + budget)
                armWaitTimer(after: budget)
            }
        case .attempting(let connection, let startedAt):
            // The attempt may have started on the network that is now gone, or
            // just ahead of this signal as a backoff fell due on resume.
            retryWithoutBackoff = true
            if now - startedAt >= policy.limits.supersedeInFlightAfter {
                attemptSuperseded = true
                connectionGeneration = UUID()
                connection.cancel()
            }
        case .idle, .authenticated:
            break
        }
    }

    // MARK: - Deadlines

    /// The request's timeout covers the upgrade, but a peer that vanishes after
    /// it would otherwise leave the hello waiting with no end.
    private func armHelloTimer(for connection: any DeviceSocketConnection) {
        let clock = clock
        let timeout = policy.limits.helloTimeout
        helloTimer = Task { [weak self, weak connection] in
            do {
                try await clock.sleep(for: timeout)
            } catch {
                return
            }
            guard let connection else { return }
            await self?.helloTimerFired(for: connection)
        }
    }

    private func helloTimerFired(for connection: any DeviceSocketConnection) {
        guard case .attempting(let current, _) = phase, current === connection else { return }
        helloTimedOut = true
        connectionGeneration = UUID()
        connection.cancel()
    }

    private func cancelHelloTimer() {
        helloTimer?.cancel()
        helloTimer = nil
    }

    // MARK: - Liveness probe

    private func armHeartbeat(on connection: any DeviceSocketConnection) {
        cancelHeartbeat()
        guard let heartbeatInterval else { return }
        let clock = clock
        heartbeatTask = Task { [weak self, weak connection] in
            do { try await clock.sleep(for: heartbeatInterval) } catch { return }
            guard let connection else { return }
            await self?.heartbeatTick(on: connection)
        }
    }

    private func heartbeatTick(on connection: any DeviceSocketConnection) {
        guard !stopped, case .authenticated(let current) = phase, current === connection else { return }
        heartbeatTask = nil
        startProbe(on: connection)
    }

    private func cancelHeartbeat() {
        heartbeatTask?.cancel()
        heartbeatTask = nil
    }

    private func startProbe(on connection: any DeviceSocketConnection) {
        guard probeID == nil else { return }
        cancelHeartbeat()
        let id = UUID()
        probeID = id
        connection.sendPing { [weak self] error in
            Task { await self?.probeAnswered(id, error: error) }
        }
        let clock = clock
        let timeout = policy.limits.probeTimeout
        probeTimer = Task { [weak self] in
            do {
                try await clock.sleep(for: timeout)
            } catch {
                return
            }
            await self?.probeTimedOut(id)
        }
    }

    private func probeAnswered(_ id: UUID, error: Error?) {
        guard id == probeID else { return }
        endProbe()
        if error != nil {
            abandonUnresponsiveConnection()
        } else if case .authenticated(let connection) = phase {
            armHeartbeat(on: connection)
        }
    }

    private func probeTimedOut(_ id: UUID) {
        guard id == probeID else { return }
        endProbe()
        abandonUnresponsiveConnection()
    }

    private func endProbe() {
        probeID = nil
        probeTimer?.cancel()
        probeTimer = nil
    }

    private func abandonUnresponsiveConnection() {
        guard case .authenticated(let connection) = phase else { return }
        log.info("WS connection did not answer its ping; reconnecting")
        connectionProbeFailed = true
        connectionGeneration = UUID()
        retryWithoutBackoff = true
        connection.cancel()
    }

    // MARK: - State transitions

    private func updateState(_ state: ConnectionState) {
        guard state != currentState else { return }
        currentState = state
        stateContinuation.yield(state)
    }

    /// A first connection shows its progress. After a failure the state keeps
    /// saying what is wrong through each retry, so the UI does not flicker back
    /// to "connecting" every time an attempt starts.
    private func publishAttemptProgress(_ state: ConnectionState) {
        if policy.lastFailure == nil { updateState(state) }
    }

    private func record(_ failure: DeviceSocketAttemptFailure) {
        switch failure {
        case .network(let detail):
            noteTemporaryFailure(detail)
        case .server(let status):
            noteTemporaryFailure("The gateway answered with status \(status).")
        case .rateLimited:
            noteTemporaryFailure("The gateway is limiting connection attempts.")
        case .trust(let detail):
            updateState(.failed(Failure(kind: .certificate, detail: detail)))
        case .authentication(let detail):
            updateState(.failed(Failure(kind: .authentication, detail: detail)))
        case .incompatible(let detail):
            updateState(.failed(Failure(kind: .incompatible, detail: detail)))
        }
    }

    private func noteTemporaryFailure(_ detail: String) {
        lastConnectionError = detail
        if currentPath?.isUsable != false { failedAttemptsOnNetwork += 1 }
        publishReconnecting()
    }

    private func publishReconnecting() {
        let network: ReconnectStatus.Network = switch currentPath?.isUsable {
        case true?: .available
        case false?: .unavailable
        case nil: .unknown
        }
        updateState(.reconnecting(ReconnectStatus(
            network: network,
            lastError: lastConnectionError,
            failedAttemptsOnNetwork: failedAttemptsOnNetwork
        )))
    }
}
