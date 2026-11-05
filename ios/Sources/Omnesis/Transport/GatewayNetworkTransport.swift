// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
import Network

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
