// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
import Network

public enum GatewayConnectionPath: String, Codable, Equatable, Sendable {
    case local
    case relay
    case reconnecting
}

/// Session-owned opaque TCP adapter; URLSession continues owning TLS, Host, SNI and credentials.
public final class GatewayRoutingProxy: @unchecked Sendable {
    struct Limits {
        let handshake: TimeInterval
        let attempt: TimeInterval
        let lanBudget: TimeInterval
        let fallback: TimeInterval
        let idle: TimeInterval
        static let production = Limits(handshake: 5, attempt: 0.75, lanBudget: 5, fallback: 10, idle: 120)
    }

    private let route: GatewayDirectRoute
    private var candidates: [GatewayDirectCandidate]
    private let limits: Limits
    private let relayEndpoint: NWEndpoint?
    private let queue = DispatchQueue(label: "omnesis.gateway.routing")
    private let queueKey = DispatchSpecificKey<Bool>()
    private let notificationQueue = DispatchQueue(label: "omnesis.gateway.routing.status")
    private let listener: any GatewayByteListener
    private let transport: GatewayNetworkTransport
    private let clock: GatewayDeadlineClock
    private let username: String
    private let password: String
    private var streams: [UUID: Stream] = [:]
    private var closed = false
    private var port: UInt16 = 0
    private var path = GatewayConnectionPath.reconnecting
    private var observers: [UUID: @Sendable (GatewayConnectionPath) -> Void] = [:]

    public convenience init(route: GatewayDirectRoute) throws {
        try self.init(route: route, limits: .production, listenPort: 0)
    }

    /// An injected endpoint lets isolated network tests resolve the canonical relay name locally.
    init(
        route: GatewayDirectRoute,
        limits: Limits,
        listenPort: UInt16,
        relayEndpoint: NWEndpoint? = nil,
        transport: GatewayNetworkTransport = .live,
        clock: GatewayDeadlineClock = .live,
        credentials: () -> (String, String) = {
            let username = UUID().uuidString.replacingOccurrences(of: "-", with: "")
            let password = UUID().uuidString + UUID().uuidString
            return (username, password)
        }
    ) throws {
        self.route = route
        candidates = route.candidates
        self.limits = limits
        self.relayEndpoint = relayEndpoint
        self.transport = transport
        self.clock = clock
        let credential = credentials()
        username = credential.0
        password = credential.1
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = .hostPort(
            host: "127.0.0.1",
            port: listenPort == 0 ? .any : NWEndpoint.Port(rawValue: listenPort)!
        )
        listener = try transport.makeListener(parameters)
        queue.setSpecific(key: queueKey, value: true)
        let ready = DispatchSemaphore(value: 0)
        listener.onState { [weak self] state in
            guard let self, !closed else { return }
            switch state {
            case .ready:
                // A ready TCP listener created with a local port has a bound port.
                port = listener.port!
                ready.signal()
            case .failed, .cancelled:
                ready.signal()
                closeOnQueue()
            default: break
            }
        }
        listener.onConnection { [weak self] connection in
            guard let self, !closed, streams.count < 16 else { connection.cancel()
                return
            }
            let stream = Stream(owner: self, client: connection)
            streams[stream.id] = stream
            stream.start()
        }
        listener.start(queue: queue)
        guard ready.wait(timeout: .now() + 2) == .success, withState({ !closed && port > 0 }) else {
            close()
            throw GatewayRoutingError.listenerUnavailable
        }
    }

    deinit { close() }

    /// A closed proxy keeps its closed endpoint: it never falls back to a direct unpinned session.
    public func configure(_ configuration: URLSessionConfiguration) {
        let proxyPort = withState { port }
        var proxy = ProxyConfiguration(socksv5Proxy: .hostPort(
            host: "127.0.0.1", port: NWEndpoint.Port(rawValue: proxyPort)!
        ))
        proxy.applyCredential(username: username, password: password)
        proxy.allowFailover = false
        configuration.proxyConfigurations = [proxy]
    }

    /// Hints affect only future TCP selections. The canonical HTTPS identity and open streams remain unchanged.
    public func updateCandidates(_ hints: [GatewayDirectCandidate]) throws {
        let validated = try GatewayDirectRoute(origin: route.origin, candidates: hints)?.candidates ?? []
        try withState {
            guard !closed else { throw GatewayRoutingError.listenerUnavailable }
            candidates = validated
        }
    }

    /// TCP selection is advisory; callers show "connected" only after authenticated protocol establishment.
    public var connectionPath: GatewayConnectionPath {
        withState { path }
    }

    @discardableResult
    public func observePath(_ callback: @escaping @Sendable (GatewayConnectionPath) -> Void) -> UUID {
        let id = UUID()
        withState {
            if !closed { observers[id] = callback }
            notify(callback, path: path)
        }
        return id
    }

    public func removePathObserver(_ id: UUID) {
        _ = withState { observers.removeValue(forKey: id) }
    }

    public func close() {
        withState { closeOnQueue() }
    }

    var activeStreamCount: Int {
        withState { streams.count }
    }

    var listeningPort: UInt16 {
        withState { port }
    }

    private func withState<T>(_ body: () throws -> T) rethrows -> T {
        if DispatchQueue.getSpecific(key: queueKey) == true { return try body() }
        return try queue.sync(execute: body)
    }

    private func notify(_ callback: @escaping @Sendable (GatewayConnectionPath) -> Void, path: GatewayConnectionPath) {
        notificationQueue.async { callback(path) }
    }

    private func updatePath(_ next: GatewayConnectionPath) {
        guard path != next else { return }
        path = next
        for observer in observers.values {
            notify(observer, path: next)
        }
    }

    private func streamClosed(_ id: UUID) {
        streams.removeValue(forKey: id)
        guard !closed else { return }
        let paths = streams.values.compactMap(\.selectedPath)
        updatePath(paths.contains(.local) ? .local : (paths.contains(.relay) ? .relay : .reconnecting))
    }

    private func closeOnQueue() {
        guard !closed else { return }
        closed = true
        listener.cancel()
        for stream in Array(streams.values) {
            stream.close()
        }
        updatePath(.reconnecting)
        observers.removeAll()
    }

    final class Stream {
        let id = UUID()
        private weak var owner: GatewayRoutingProxy?
        private let route: GatewayDirectRoute
        private let candidates: [GatewayDirectCandidate]
        private let limits: Limits
        private let relayEndpoint: NWEndpoint?
        private let queue: DispatchQueue
        private let transport: GatewayNetworkTransport
        private let clock: GatewayDeadlineClock
        private let client: any GatewayByteConnection
        private var upstream: (any GatewayByteConnection)?
        private var handshake: GatewaySOCKSHandshake
        private var closed = false
        private var forwarding = false
        private(set) var selectedPath: GatewayConnectionPath?
        private var timer: (any GatewayDeadline)?
        private var attemptTimer: (any GatewayDeadline)?
        private var halfClosed = 0
        private var candidate = 0
        private var lanDeadline = DispatchTime(uptimeNanoseconds: 0)

        init(owner: GatewayRoutingProxy, client: any GatewayByteConnection) {
            self.owner = owner
            transport = owner.transport
            clock = owner.clock
            route = owner.route
            candidates = owner.candidates
            limits = owner.limits
            relayEndpoint = owner.relayEndpoint
            queue = owner.queue
            self.client = client
            handshake = GatewaySOCKSHandshake(
                hostname: owner.route.host,
                port: owner.route.port,
                username: owner.username,
                password: owner.password
            )
        }

        func start() {
            guard !closed else { return }
            timer = makeTimer(limits.handshake) { [weak self] in self?.close() }
            client.onState { [weak self] state in
                guard let self else { return }
                switch state {
                case .ready: receiveHandshake()
                case .failed, .cancelled: close()
                default: break
                }
            }
            client.start(queue: queue)
        }

        private func makeTimer(_ seconds: TimeInterval, action: @escaping () -> Void) -> any GatewayDeadline {
            let timer = clock.make(queue, action)
            timer.schedule(deadline: clock.now() + seconds)
            return timer
        }

        func receiveHandshake() {
            guard !closed else { return }
            client.receive(minimum: 1, maximum: 2048) { [weak self] data, complete, error in
                guard let self, !closed else { return }
                guard error == nil, !complete, let data, !data.isEmpty else { close()
                    return
                }
                apply(handshake.receive(data), index: 0)
            }
        }

        func apply(_ effects: [GatewaySOCKSHandshake.Effect], index: Int) {
            guard !closed else { return }
            guard index < effects.count else { receiveHandshake()
                return
            }
            switch effects[index] {
            case .reply(let bytes):
                client.send(content: bytes, final: false) { [weak self] error in
                    guard let self else { return }
                    if error != nil { close() } else { apply(effects, index: index + 1) }
                }
            case .reject(let bytes):
                client.send(content: bytes, final: false) { [weak self] _ in self?.close() }
            case .connect:
                timer?.cancel()
                lanDeadline = clock.now() + limits.lanBudget
                connectNext()
            }
        }

        func connectNext() {
            guard !closed else { return }
            if candidate < candidates.count, clock.now() >= lanDeadline {
                candidate = candidates.count
            }
            guard candidate <= candidates.count else {
                client.send(content: Data([5, 4, 0, 1, 0, 0, 0, 0, 0, 0]), final: false) { [weak self] _ in self?.close() }
                return
            }
            let isLocal = candidate < candidates.count
            let destination = isLocal ? candidates[candidate] : GatewayDirectCandidate(address: route.host, port: Int(route.port))
            candidate += 1
            let endpoint = (!isLocal ? relayEndpoint : nil) ?? .hostPort(
                host: NWEndpoint.Host(destination.address),
                port: NWEndpoint.Port(rawValue: UInt16(destination.port))!
            )
            let connection = transport.makeConnection(endpoint, .tcp)
            upstream = connection
            let remainingLAN = max(0, Double(lanDeadline.uptimeNanoseconds) - Double(clock.now().uptimeNanoseconds)) / 1_000_000_000
            attemptTimer = makeTimer(isLocal ? min(limits.attempt, remainingLAN) : limits.fallback) { [weak self, weak connection] in
                guard let self, let connection, upstream === connection, !closed, !forwarding else { return }
                upstream = nil
                connection.cancel()
                connectNext()
            }
            connection.onState { [weak self, weak connection] state in
                guard let self, let connection, upstream === connection, !closed else { return }
                switch state {
                case .ready:
                    attemptTimer?.cancel()
                    forwarding = true
                    selectedPath = isLocal ? .local : .relay
                    owner?.updatePath(selectedPath!)
                    timer = makeTimer(limits.idle) { [weak self] in self?.close() }
                    client.send(content: Data([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]), final: false) { [weak self] error in
                        guard let self, !closed else { return }
                        if error != nil { close()
                            return
                        }
                        pump(client, to: connection)
                        pump(connection, to: client)
                    }
                case .failed, .cancelled:
                    attemptTimer?.cancel()
                    if forwarding { close() } else { upstream = nil
                        connection.cancel()
                        connectNext()
                    }
                default: break
                }
            }
            connection.start(queue: queue)
        }

        func pump(_ source: any GatewayByteConnection, to destination: any GatewayByteConnection) {
            guard !closed else { return }
            source.receive(minimum: 1, maximum: 16384) { [weak self] data, complete, error in
                guard let self, !closed else { return }
                guard error == nil, data != nil || complete else { close()
                    return
                }
                timer?.schedule(deadline: clock.now() + limits.idle)
                destination.send(content: data, final: complete) { [weak self] error in
                    guard let self, !closed else { return }
                    if error != nil { close()
                        return
                    }
                    if complete {
                        halfClosed += 1
                        if halfClosed == 2 { close() }
                    } else { pump(source, to: destination) }
                }
            }
        }

        func close() {
            guard !closed else { return }
            closed = true
            timer?.cancel()
            attemptTimer?.cancel()
            client.cancel()
            upstream?.cancel()
            owner?.streamClosed(id)
        }
    }
}
