// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
import Network

/// A TCP forwarder in front of a live gateway, so a test can take the gateway
/// off the network and bring it back while the real TLS and WebSocket stack
/// runs: stopping it refuses connections and severs the open ones, and muting
/// leaves connections open with nothing behind them, like a dead route.
final class LoopbackForwarder: @unchecked Sendable {
    private final class Link: @unchecked Sendable {
        let inbound: NWConnection
        let outbound: NWConnection
        private let lock = NSLock()
        private var muted = false

        init(inbound: NWConnection, outbound: NWConnection) {
            self.inbound = inbound
            self.outbound = outbound
        }

        var isMuted: Bool {
            lock.withLock { muted }
        }

        func mute() {
            lock.withLock { muted = true }
        }

        func close() {
            inbound.cancel()
            outbound.cancel()
        }
    }

    private let target: NWEndpoint
    private let queue = DispatchQueue(label: "dev.omnesis.tests.forwarder")
    private let lock = NSLock()
    private var listener: NWListener?
    private var links: [Link] = []
    private var accepted = 0

    init(targetHost: String, targetPort: UInt16) {
        target = .hostPort(host: NWEndpoint.Host(targetHost), port: NWEndpoint.Port(rawValue: targetPort)!)
    }

    var acceptedConnections: Int {
        lock.withLock { accepted }
    }

    /// Listens on `port`, or on any free port when nil, and returns the port.
    /// Rebinding a port just released can take a moment, so it retries briefly.
    func start(port: UInt16? = nil) async throws -> UInt16 {
        var lastError: Error = POSIXError(.EADDRINUSE)
        for _ in 0 ..< 30 {
            do {
                return try await bind(port: port)
            } catch {
                lastError = error
                try await Task.sleep(for: .milliseconds(200))
            }
        }
        throw lastError
    }

    func stop() {
        let (listener, links) = lock.withLock {
            let current = (self.listener, self.links)
            self.listener = nil
            self.links = []
            return current
        }
        listener?.cancel()
        for link in links {
            link.close()
        }
    }

    func muteExistingConnections() {
        for link in lock.withLock({ links }) {
            link.mute()
        }
    }

    private func bind(port: UInt16?) async throws -> UInt16 {
        let parameters = NWParameters.tcp
        parameters.allowLocalEndpointReuse = true
        let endpointPort = port.flatMap(NWEndpoint.Port.init(rawValue:)) ?? .any
        let listener = try NWListener(using: parameters, on: endpointPort)
        listener.newConnectionHandler = { [weak self] connection in
            self?.accept(connection)
        }
        lock.withLock { self.listener = listener }
        return try await withCheckedThrowingContinuation { continuation in
            let once = ResumeOnce(continuation)
            listener.stateUpdateHandler = { state in
                switch state {
                case .ready:
                    once.resume(.success(listener.port?.rawValue ?? 0))
                case .failed(let error):
                    listener.cancel()
                    once.resume(.failure(error))
                default:
                    break
                }
            }
            listener.start(queue: queue)
        }
    }

    private func accept(_ inbound: NWConnection) {
        let outbound = NWConnection(to: target, using: .tcp)
        let link = Link(inbound: inbound, outbound: outbound)
        lock.withLock {
            accepted += 1
            links.append(link)
        }
        inbound.start(queue: queue)
        outbound.start(queue: queue)
        pump(from: inbound, to: outbound, link: link)
        pump(from: outbound, to: inbound, link: link)
    }

    private func pump(from source: NWConnection, to destination: NWConnection, link: Link) {
        source.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, isComplete, error in
            if let data, !data.isEmpty, !link.isMuted {
                destination.send(content: data, completion: .contentProcessed { _ in })
            }
            if isComplete || error != nil {
                link.close()
            } else {
                self?.pump(from: source, to: destination, link: link)
            }
        }
    }
}

private final class ResumeOnce: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<UInt16, Error>?

    init(_ continuation: CheckedContinuation<UInt16, Error>) {
        self.continuation = continuation
    }

    func resume(_ result: Result<UInt16, Error>) {
        let pending = lock.withLock { () -> CheckedContinuation<UInt16, Error>? in
            defer { continuation = nil }
            return continuation
        }
        pending?.resume(with: result)
    }
}
