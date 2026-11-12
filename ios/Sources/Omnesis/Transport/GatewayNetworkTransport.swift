// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
import Network
import os

/// Queue-confined byte IO. TLS and certificate policy remain with the caller's Network parameters or URLSession.
protocol GatewayByteConnection: AnyObject {
    func onState(_ handler: @escaping (NWConnection.State) -> Void)
    func start(queue: DispatchQueue)
    func cancel()
    func receive(minimum: Int, maximum: Int, completion: @escaping (Data?, Bool, NWError?) -> Void)
    func send(content: Data?, final: Bool, completion: @escaping (NWError?) -> Void)
}

protocol GatewayByteListener: AnyObject {
    var port: UInt16? { get }
    func onState(_ handler: @escaping (NWListener.State) -> Void)
    func onConnection(_ handler: @escaping (any GatewayByteConnection) -> Void)
    func start(queue: DispatchQueue)
    func cancel()
}

struct GatewayNetworkTransport {
    let makeConnection: (NWEndpoint, NWParameters) -> any GatewayByteConnection
    let makeListener: (NWParameters) throws -> any GatewayByteListener

    static let live = GatewayNetworkTransport(
        makeConnection: { GatewayLiveConnection(NWConnection(to: $0, using: $1)) },
        makeListener: { try GatewayLiveListener(NWListener(using: $0)) }
    )
}

private final class GatewayLiveConnection: GatewayByteConnection {
    private let connection: NWConnection
    init(_ connection: NWConnection) {
        self.connection = connection
    }

    func onState(_ handler: @escaping (NWConnection.State) -> Void) {
        connection.stateUpdateHandler = handler
    }

    func start(queue: DispatchQueue) {
        connection.start(queue: queue)
    }

    func cancel() {
        connection.cancel()
    }

    func receive(minimum: Int, maximum: Int, completion: @escaping (Data?, Bool, NWError?) -> Void) {
        connection.receive(minimumIncompleteLength: minimum, maximumLength: maximum) { data, _, complete, error in
            completion(data, complete, error)
        }
    }

    func send(content: Data?, final: Bool, completion: @escaping (NWError?) -> Void) {
        connection.send(
            content: content,
            contentContext: final ? .finalMessage : .defaultMessage,
            isComplete: true,
            completion: .contentProcessed(completion)
        )
    }
}

private final class GatewayLiveListener: GatewayByteListener {
    private let listener: NWListener
    init(_ listener: NWListener) {
        self.listener = listener
    }

    var port: UInt16? {
        listener.port?.rawValue
    }

    func onState(_ handler: @escaping (NWListener.State) -> Void) {
        listener.stateUpdateHandler = handler
    }

    func onConnection(_ handler: @escaping (any GatewayByteConnection) -> Void) {
        listener.newConnectionHandler = { handler(GatewayLiveConnection($0)) }
    }

    func start(queue: DispatchQueue) {
        listener.start(queue: queue)
    }

    func cancel() {
        listener.cancel()
    }
}

protocol GatewayDeadline: AnyObject {
    func schedule(deadline: DispatchTime)
    func cancel()
}

/// Keeps a session's loopback endpoint across faults. Explicit retirement is terminal.
///
/// A listener can stop accepting without reporting a failure: iOS reclaims the sockets of a
/// suspended app. `verify` therefore proves the endpoint with a loopback connection.
final class GatewayRecoveringListener {
    static let probeTimeout: TimeInterval = 2
    /// Spelled out because app extensions compile this file without the app's `AppLog`.
    private static let log = Logger(subsystem: "dev.omnesis.ios", category: "transport.route")

    private let transport: GatewayNetworkTransport
    private let clock: GatewayDeadlineClock
    private let queue: DispatchQueue
    private let ready: (Bool) -> Void
    private let failed: () -> Void
    private let accepted: (any GatewayByteConnection) -> Void
    private var listener: (any GatewayByteListener)?
    private var timer: (any GatewayDeadline)?
    private var generation = UUID()
    private var retired = false
    private var deadlineGeneration = UUID()
    private var attempts = 0
    private var probe: (any GatewayByteConnection)?
    private var probeTimer: (any GatewayDeadline)?
    private var probeTicket = UUID()
    private var verifications: [(Bool) -> Void] = []
    private(set) var port: UInt16
    private(set) var listening = false

    init(
        port: UInt16, transport: GatewayNetworkTransport, clock: GatewayDeadlineClock,
        queue: DispatchQueue, ready: @escaping (Bool) -> Void, failed: @escaping () -> Void,
        accepted: @escaping (any GatewayByteConnection) -> Void
    ) {
        self.port = port
        self.transport = transport
        self.clock = clock
        self.queue = queue
        self.ready = ready
        self.failed = failed
        self.accepted = accepted
    }

    deinit { settleVerifications(false) }

    func start() {
        open()
    }

    /// Answers whether the endpoint is serving, after rebuilding it on the same port when a
    /// loopback connection is not accepted. A repair waiting out its backoff runs at once.
    func verify(_ completion: @escaping (Bool) -> Void) {
        guard !retired, port > 0 else {
            completion(false)
            return
        }
        verifications.append(completion)
        guard probe == nil else { return }
        guard listening else {
            if listener == nil {
                attempts = 0
                open()
            }
            return
        }
        let ticket = UUID()
        probeTicket = ticket
        let connection = transport.makeConnection(.hostPort(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: port)!), .tcp)
        probe = connection
        connection.onState { [weak self] state in
            guard let self, probeTicket == ticket else { return }
            switch state {
            case .waiting, .failed, .cancelled: probeFailed()
            default: break
            }
        }
        let timer = clock.make(queue) { [weak self] in
            guard let self, probeTicket == ticket else { return }
            probeFailed()
        }
        probeTimer = timer
        timer.schedule(deadline: clock.now() + Self.probeTimeout)
        connection.start(queue: queue)
    }

    private func probeFailed() {
        Self.log.notice("Loopback endpoint stopped accepting without a listener failure; rebuilding it")
        endProbe()
        fault(reopenNow: true)
    }

    private func endProbe() {
        probeTicket = UUID()
        probeTimer?.cancel()
        probeTimer = nil
        probe?.cancel()
        probe = nil
    }

    private func settleVerifications(_ serving: Bool) {
        let pending = verifications
        verifications = []
        for completion in pending {
            completion(serving)
        }
    }

    private func open() {
        guard !retired else { return }
        generation = UUID()
        let lease = generation
        let parameters = NWParameters.tcp
        // A rebind of the session's port must not wait for the previous socket's connections to drain.
        parameters.allowLocalEndpointReuse = true
        parameters.requiredLocalEndpoint = .hostPort(
            host: "127.0.0.1", port: port == 0 ? .any : NWEndpoint.Port(rawValue: port)!
        )
        do {
            let next = try transport.makeListener(parameters)
            listener = next
            next.onState { [weak self, weak next] state in
                guard let self, let next, !retired, generation == lease, listener === next else { return }
                switch state {
                case .ready:
                    guard let bound = next.port, bound > 0, port == 0 || port == bound else { fault()
                        return
                    }
                    port = bound
                    listening = true
                    attempts = 0
                    timer?.cancel()
                    deadlineGeneration = UUID()
                    ready(true)
                    settleVerifications(true)
                case .failed, .cancelled: fault()
                // A serving listener that falls back to waiting has stopped accepting. One that is
                // still opening keeps its readiness deadline instead.
                case .waiting: if listening { fault() }
                default: break
                }
            }
            next.onConnection { [weak self, weak next] connection in
                guard let self, let next, !retired, listening, generation == lease, listener === next else {
                    connection.cancel()
                    return
                }
                // Any accepted connection proves the endpoint; the probe's own ends as an unfinished handshake.
                if probe != nil {
                    endProbe()
                    settleVerifications(true)
                }
                accepted(connection)
            }
            deadline(after: 2, lease: lease) { [weak self] in self?.fault() }
            next.start(queue: queue)
        } catch { fault() }
    }

    /// A fault found by `verify` reopens once without the backoff; a second failure waits as usual.
    private func fault(reopenNow: Bool = false) {
        guard !retired else { return }
        generation = UUID()
        listening = false
        let old = listener
        listener = nil
        timer?.cancel()
        endProbe()
        old?.cancel()
        failed()
        ready(false)
        if reopenNow, port > 0 {
            open()
            return
        }
        settleVerifications(false)
        guard port > 0 else { return }
        let delay = min(pow(2, Double(min(attempts, 5))), 30)
        attempts += 1
        deadline(after: delay, lease: generation) { [weak self] in self?.open() }
    }

    private func deadline(after seconds: TimeInterval, lease: UUID, action: @escaping () -> Void) {
        timer?.cancel()
        let ticket = UUID()
        deadlineGeneration = ticket
        let next = clock.make(queue) { [weak self] in
            guard let self, !retired, generation == lease, deadlineGeneration == ticket else { return }
            action()
        }
        timer = next
        next.schedule(deadline: clock.now() + seconds)
    }

    func close() {
        guard !retired else { return }
        retired = true
        generation = UUID()
        listening = false
        timer?.cancel()
        endProbe()
        listener?.cancel()
        listener = nil
        settleVerifications(false)
    }
}

struct GatewayDeadlineClock {
    let now: () -> DispatchTime
    let make: (DispatchQueue, @escaping () -> Void) -> any GatewayDeadline
    static let live = GatewayDeadlineClock(now: { .now() }, make: { GatewayDispatchDeadline(queue: $0, action: $1) })
}

private final class GatewayDispatchDeadline: GatewayDeadline {
    private let source: DispatchSourceTimer
    init(queue: DispatchQueue, action: @escaping () -> Void) {
        source = DispatchSource.makeTimerSource(queue: queue)
        source.schedule(deadline: .distantFuture)
        source.setEventHandler(handler: action)
        source.resume()
    }

    deinit { source.cancel() }
    func schedule(deadline: DispatchTime) {
        source.schedule(deadline: deadline)
    }

    func cancel() {
        source.cancel()
    }
}
