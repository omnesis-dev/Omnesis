// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
import Network
import Security

/// Queue-confined verification state: a late TLS callback belongs only to its own attempt.
struct GatewayProbeAttempt {
    private var generation = UUID()
    private(set) var identityRejected = false
    private(set) var identityVerified = false

    mutating func begin() -> UUID {
        generation = UUID()
        identityRejected = false
        identityVerified = false
        return generation
    }

    func isCurrent(_ id: UUID) -> Bool {
        generation == id
    }

    mutating func record(_ id: UUID, accepted: Bool) -> Bool {
        guard isCurrent(id), !identityRejected else { return false }
        identityRejected = !accepted
        identityVerified = accepted
        return accepted
    }
}

/// Authenticates a candidate through a complete TLS handshake without sending application bytes.
public enum GatewayDirectProbe {
    public typealias TrustVerifier = @Sendable (SecTrust, String) -> Bool

    public static func reachable(route: GatewayDirectRoute, verifyTrust: @escaping TrustVerifier) async -> Bool {
        await reachable(route: route, attemptTimeout: 0.75, totalTimeout: 5, verifyTrust: verifyTrust)
    }

    static func reachable(
        route: GatewayDirectRoute,
        attemptTimeout: TimeInterval,
        totalTimeout: TimeInterval,
        verifyTrust: @escaping TrustVerifier
    ) async
        -> Bool {
        await reachable(
            route: route,
            attemptTimeout: attemptTimeout,
            totalTimeout: totalTimeout,
            connectTLS: { endpoint, host, queue, verify in
                GatewayTLSNetworkConnection.make(endpoint: endpoint, serverName: host, queue: queue, verify: verify)
            },
            verifyTrust: verifyTrust
        )
    }

    static func reachable(
        route: GatewayDirectRoute,
        attemptTimeout: TimeInterval,
        totalTimeout: TimeInterval,
        connectTLS: @escaping GatewayTLSNetworkConnection.Connector,
        clock: GatewayDeadlineClock = .live,
        verifyTrust: @escaping TrustVerifier
    ) async
        -> Bool {
        let operation = Operation(
            route: route,
            attemptTimeout: attemptTimeout,
            totalTimeout: totalTimeout,
            connectTLS: connectTLS,
            clock: clock,
            verifyTrust: verifyTrust
        )
        return await withTaskCancellationHandler {
            await withCheckedContinuation { operation.start($0) }
        } onCancel: { operation.cancel() }
    }

    /// Queue-confined, single-use probe lifecycle. Terminal entry is idempotent.
    final class Operation: @unchecked Sendable {
        private let route: GatewayDirectRoute
        private let attemptTimeout: TimeInterval
        private let totalTimeout: TimeInterval
        private let verifyTrust: TrustVerifier
        private let connectTLS: GatewayTLSNetworkConnection.Connector
        private let clock: GatewayDeadlineClock
        let queue = DispatchQueue(label: "omnesis.gateway.direct-probe")
        private var continuation: CheckedContinuation<Bool, Never>?
        private var connection: (any GatewayByteConnection)?
        private var timer: (any GatewayDeadline)?
        private var candidate = 0
        private var cancelled = false
        private var finished = false
        private var attempt = GatewayProbeAttempt()
        private var deadline = DispatchTime.distantFuture

        init(
            route: GatewayDirectRoute,
            attemptTimeout: TimeInterval,
            totalTimeout: TimeInterval,
            connectTLS: @escaping GatewayTLSNetworkConnection.Connector,
            clock: GatewayDeadlineClock,
            verifyTrust: @escaping TrustVerifier
        ) {
            self.route = route
            self.attemptTimeout = attemptTimeout
            self.totalTimeout = totalTimeout
            self.verifyTrust = verifyTrust
            self.connectTLS = connectTLS
            self.clock = clock
        }

        func start(_ continuation: CheckedContinuation<Bool, Never>) {
            queue.async {
                self.continuation = continuation
                if self.cancelled { self.finish(false)
                    return
                }
                self.deadline = self.clock.now() + self.totalTimeout
                self.connectNext()
            }
        }

        func cancel() {
            queue.async {
                self.cancelled = true
                self.finish(false)
            }
        }

        func connectNext() {
            guard !finished else { return }
            guard candidate < route.candidates.count, clock.now() < deadline else { finish(false)
                return
            }
            let destination = route.candidates[candidate]
            candidate += 1
            let generation = attempt.begin()
            let attemptDeadline = min(clock.now() + attemptTimeout, deadline)
            let endpoint = NWEndpoint.hostPort(
                host: NWEndpoint.Host(destination.address),
                port: NWEndpoint.Port(rawValue: UInt16(destination.port))!
            )
            let next = connectTLS(endpoint, route.host, queue) { [weak self] trust in
                guard let self, !finished, attempt.isCurrent(generation) else { return false }
                let accepted = verifyTrust(trust, route.host)
                return attempt.record(generation, accepted: accepted)
            }
            connection = next
            next.onState { [weak self, weak next] state in
                guard let self, let next, connection === next, !finished else { return }
                switch state {
                case .ready:
                    if clock.now() < attemptDeadline, attempt.identityVerified,
                       !attempt.identityRejected { finish(true) } else { advance(next) }
                case .failed, .cancelled: advance(next)
                default: break
                }
            }
            let source = clock.make(queue) { [weak self, weak next] in
                guard let self, let next, connection === next, !finished else { return }
                advance(next)
            }
            source.schedule(deadline: attemptDeadline)
            timer = source
            next.start(queue: queue)
        }

        private func advance(_ current: any GatewayByteConnection) {
            timer?.cancel()
            connection = nil
            current.cancel()
            connectNext()
        }

        private func finish(_ result: Bool) {
            guard !finished, let continuation else { return }
            finished = true
            timer?.cancel()
            connection?.cancel()
            connection = nil
            self.continuation = nil
            continuation.resume(returning: result)
        }
    }
}
