// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
import Network

/// One WebSocket connection as `DeviceSocket` uses it.
protocol DeviceSocketConnection: AnyObject, Sendable {
    func send(_ text: String) async throws
    func receive() async throws -> URLSessionWebSocketTask.Message
    /// Calls `completion` when the peer answers. A connection whose peer is gone
    /// may never call it, so callers bound the wait themselves.
    func sendPing(_ completion: @escaping @Sendable (Error?) -> Void)
    func cancel()
    /// The HTTP status of the upgrade response, once one arrived.
    var handshakeStatus: Int? { get }
}

/// Opens the connections for one `DeviceSocket`.
protocol DeviceSocketConnector: Sendable {
    func open(_ request: URLRequest) -> any DeviceSocketConnection
}

/// Opens every connection on the one session the socket was given, so a retry
/// always carries the pairing's TLS trust.
struct URLSessionDeviceSocketConnector: DeviceSocketConnector {
    let session: URLSession
    var ping: @Sendable (URLSessionWebSocketTask, @escaping @Sendable (Error?) -> Void) -> Void = { task, completion in
        task.sendPing(pongReceiveHandler: completion)
    }

    func open(_ request: URLRequest) -> any DeviceSocketConnection {
        let task = session.webSocketTask(with: request)
        task.resume()
        return URLSessionDeviceSocketConnection(task: task, ping: ping)
    }
}

private final class URLSessionDeviceSocketConnection: DeviceSocketConnection, @unchecked Sendable {
    private let task: URLSessionWebSocketTask

    private let ping: @Sendable (URLSessionWebSocketTask, @escaping @Sendable (Error?) -> Void) -> Void
    init(task: URLSessionWebSocketTask, ping: @escaping @Sendable (URLSessionWebSocketTask, @escaping @Sendable (Error?) -> Void) -> Void) {
        self.task = task
        self.ping = ping
    }

    func send(_ text: String) async throws {
        try await task.send(.string(text))
    }

    func receive() async throws -> URLSessionWebSocketTask.Message {
        try await task.receive()
    }

    func sendPing(_ completion: @escaping @Sendable (Error?) -> Void) {
        ping(task, completion)
    }

    func cancel() {
        task.cancel(with: .goingAway, reason: nil)
    }

    var handshakeStatus: Int? {
        (task.response as? HTTPURLResponse)?.statusCode
    }
}

/// Time as `DeviceSocket` schedules with it: a duration since an arbitrary
/// origin, and a cancellable sleep.
protocol DeviceSocketClock: Sendable {
    var now: Duration { get }
    func sleep(for duration: Duration) async throws
}

/// Keeps counting while the device sleeps, so a retry that fell due during a
/// suspension runs as soon as the app can.
struct ContinuousDeviceSocketClock: DeviceSocketClock {
    private let clock = ContinuousClock()
    private let origin = ContinuousClock().now

    var now: Duration {
        origin.duration(to: clock.now)
    }

    func sleep(for duration: Duration) async throws {
        try await clock.sleep(for: duration)
    }
}

/// What the system says about the network. It is advisory in both directions: a
/// usable path does not prove the gateway is reachable, and an unusable one does
/// not stop the socket's own bounded retries.
struct NetworkPathSnapshot: Equatable, Sendable {
    enum Interface: Hashable, Sendable {
        case wifi, cellular, wired, other
    }

    /// How a new snapshot differs from the previous one.
    enum Transition: Equatable, Sendable {
        case unchanged, lost, restored
    }

    let isUsable: Bool
    let interfaces: Set<Interface>

    /// A usable path with a different set of interfaces counts as restored:
    /// joining Wi-Fi or bringing up a VPN can give the gateway a route that the
    /// previous path did not have.
    func transition(from previous: Self?) -> Transition {
        guard let previous, previous != self else { return .unchanged }
        if !isUsable { return previous.isUsable ? .lost : .unchanged }
        return .restored
    }
}

protocol NetworkPathObserving: Sendable {
    /// Current path, then each change, until the stream is released.
    func paths() -> AsyncStream<NetworkPathSnapshot>
}

struct SystemNetworkPathObserver: NetworkPathObserving {
    func paths() -> AsyncStream<NetworkPathSnapshot> {
        AsyncStream { continuation in
            let monitor = NWPathMonitor()
            monitor.pathUpdateHandler = { path in
                continuation.yield(Self.snapshot(of: path))
            }
            continuation.onTermination = { _ in monitor.cancel() }
            monitor.start(queue: DispatchQueue(label: "dev.omnesis.transport.path"))
        }
    }

    private static func snapshot(of path: NWPath) -> NetworkPathSnapshot {
        let interfaces: [NetworkPathSnapshot.Interface] = path.availableInterfaces.compactMap { interface in
            switch interface.type {
            case .wifi: .wifi
            case .cellular: .cellular
            case .wiredEthernet: .wired
            case .other: .other
            case .loopback: nil
            @unknown default: .other
            }
        }
        return NetworkPathSnapshot(isUsable: path.status == .satisfied, interfaces: Set(interfaces))
    }
}
