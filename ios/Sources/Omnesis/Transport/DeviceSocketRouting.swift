// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

@available(iOS 17.0, *)
extension DeviceSocket {
    public init(
        gatewayUrl: URL,
        token: String,
        session: URLSession = OmnesisURLSession.shared,
        capabilities: PairingCapabilities = .ios(),
        routingOwner: (any GatewaySocketRouting)? = nil,
        expectedDeviceId: String? = nil,
        promotionClock: any GatewayPromotionWaiting = GatewayPromotionClock(),
        hintRefresher: (any GatewayDirectHintRefreshing)? = nil,
        liveness: Liveness? = CloudRelayFeature.enabled ? Liveness() : nil
    ) {
        // OmnesisURLSession.shared pins the gateway's TLS leaf cert when a
        // fingerprint is in Keychain (post-pair) and falls through to
        // URLSession.shared otherwise. URLSessionWebSocketTask is supported
        // by both shapes — both .ephemeral (PinnedSession) and .default.
        guard let liveness else {
            // Off the cloud build flag: the socket pings only when the network path changes.
            self.init(
                gatewayUrl: gatewayUrl,
                token: token,
                connector: URLSessionDeviceSocketConnector(session: routingOwner?.session ?? session),
                capabilities: capabilities,
                pathObserver: SystemNetworkPathObserver(),
                clock: ContinuousDeviceSocketClock(),
                routingOwner: routingOwner,
                expectedDeviceId: expectedDeviceId,
                promotionClock: promotionClock,
                hintRefresher: hintRefresher
            )
            return
        }
        var limits = DeviceSocketReconnectPolicy.Limits()
        limits.helloTimeout = liveness.helloTimeout
        limits.probeTimeout = liveness.pongTimeout
        self.init(
            gatewayUrl: gatewayUrl,
            token: token,
            connector: URLSessionDeviceSocketConnector(session: routingOwner?.session ?? session, ping: liveness.ping),
            capabilities: capabilities,
            pathObserver: SystemNetworkPathObserver(),
            clock: GatewaySocketLivenessClock(liveness: liveness),
            limits: limits,
            routingOwner: routingOwner,
            expectedDeviceId: expectedDeviceId,
            promotionClock: promotionClock,
            hintRefresher: hintRefresher,
            heartbeatInterval: liveness.pingInterval
        )
    }

    func startRouting() {
        guard let routingOwner else { return }
        routeObserver = routingOwner.observeRoutePath { [weak self] path in
            Task { await self?.routeChanged(path) }
        }
        let clock = promotionClock
        promotionTask = Task { [weak self] in
            while !Task.isCancelled {
                do { try await clock.wait() } catch { return }
                guard let self else { return }
                do { try await self.refreshRoutingHints() } catch { /* Rejected hints cannot change trust or current routes. */ }
                await self.promoteDirectPath()
            }
        }
    }

    func retireRouting() {
        promotionTask?.cancel()
        promotionTask = nil
        if let routeObserver { routingOwner?.removeRoutePathObserver(routeObserver) }
        routeObserver = nil
        routingOwner?.retireRouting()
    }

    func didAuthenticateRouting() {
        guard let path = routingOwner?.connectionPath else { return }
        Task { [weak self] in await self?.routeChanged(path) }
    }

    @discardableResult
    func refreshRoutingHints() async throws -> Bool {
        guard routeIsActive, let routingOwner, let hintRefresher else { return false }
        return try await hintRefresher.refresh { candidates in try routingOwner.updateCandidates(candidates) }
    }

    /// Only a verified direct path may replace the control socket; uploads retain their leases.
    func promoteDirectPath() async {
        guard routeIsActive, case .connected = state(),
              let routingOwner, routingOwner.connectionPath == .relay else { return }
        let generation = frameGeneration
        let verified = await routingOwner.directPathAvailable()
        guard verified, routeIsActive, case .connected = state(),
              routingOwner.connectionPath == .relay else { return }
        requestRouteReplacement(generation: generation)
    }

    func routeChanged(_ path: GatewayConnectionPath) async {
        guard routeIsActive, case .connected = state(), routingOwner?.connectionPath == path else { return }
        pathContinuation.yield(path)
        if path != .reconnecting {
            await emitEvent(type: "connection.path", payload: ["path": .string(path.rawValue)])
        }
    }
}

/// When a routed socket proves its loopback endpoint before reconnecting.
///
/// iOS can close a suspended app's listening socket without the listener reporting it. Every
/// attempt is then refused on loopback and never reaches the gateway, so the reconnect loop
/// asks the route to verify itself: after each wake signal, and after a refused connection at
/// most once per `failureInterval`, so an unreachable gateway cannot cause a probe storm.
struct GatewayRoutingCheck {
    static let failureInterval: Duration = .seconds(30)
    private(set) var pending = false
    private var lastFailureCheck: Duration?

    mutating func noteWake() {
        pending = true
    }

    /// True when this refusal is allowed to request a check.
    mutating func noteRefusal(at now: Duration) -> Bool {
        if let lastFailureCheck, now - lastFailureCheck < Self.failureInterval { return false }
        lastFailureCheck = now
        pending = true
        return true
    }

    mutating func take() -> Bool {
        defer { pending = false }
        return pending
    }
}

@available(iOS 17.0, *)
extension DeviceSocket {
    /// The shared HTTP session has a loopback endpoint of its own, with the same exposure.
    func noteRoutingWake() {
        guard routingOwner != nil else { return }
        routingCheck.noteWake()
        OmnesisURLSession.verifyRouting()
    }

    func noteRoutingFailure(_ error: Error, at now: Duration) {
        guard routingOwner != nil, (error as? URLError)?.code == .cannotConnectToHost,
              routingCheck.noteRefusal(at: now) else { return }
        OmnesisURLSession.verifyRouting()
    }

    /// Runs between the wait and the next attempt, so a rebuilt endpoint is ready for that attempt.
    func verifyRoutingIfNeeded() async {
        guard let routingOwner, routingCheck.take() else { return }
        if await !routingOwner.verifyRouting() { log.info("WS route's loopback endpoint is not serving yet") }
    }
}
