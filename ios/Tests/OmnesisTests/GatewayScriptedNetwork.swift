// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
import Network
@testable import Omnesis

/// Queued IO callbacks model callbacks already submitted by Network before close/cancel.
final class ScriptedGatewayConnection: GatewayByteConnection, @unchecked Sendable {
    struct Write {
        let data: Data?
        let final: Bool
        let completion: (NWError?) -> Void
    }

    var stateHandler: ((NWConnection.State) -> Void)?
    var queue: DispatchQueue?
    var reads: [(Data?, Bool, NWError?) -> Void] = []
    var writes: [Write] = []
    var cancellations = 0
    var starts = 0
    var receiveBounds: [(Int, Int)] = []

    func onState(_ handler: @escaping (NWConnection.State) -> Void) {
        stateHandler = handler
    }

    func start(queue: DispatchQueue) {
        self.queue = queue
        starts += 1
    }

    func cancel() {
        cancellations += 1
    }

    func receive(minimum: Int, maximum: Int, completion: @escaping (Data?, Bool, NWError?) -> Void) {
        receiveBounds.append((minimum, maximum))
        reads.append(completion)
    }

    func send(content: Data?, final: Bool, completion: @escaping (NWError?) -> Void) {
        writes.append(Write(data: content, final: final, completion: completion))
    }

    func state(_ value: NWConnection.State) {
        queue!.sync { stateHandler!(value) }
    }

    func read(_ data: Data?, complete: Bool = false, error: NWError? = nil) {
        queue!.sync {
            let completion = reads.removeFirst()
            completion(data, complete, error)
        }
    }

    func completeWrite(_ error: NWError? = nil) {
        queue!.sync {
            let write = writes.removeFirst()
            write.completion(error)
        }
    }

    func onQueue(_ body: () -> Void) {
        queue!.sync(execute: body)
    }

    func discardCallbacks() {
        reads.removeAll()
        writes.removeAll()
        stateHandler = nil
    }
}

final class ScriptedGatewayListener: GatewayByteListener, @unchecked Sendable {
    var port: UInt16? = 49151
    var stateHandler: ((NWListener.State) -> Void)?
    var connectionHandler: ((any GatewayByteConnection) -> Void)?
    var queue: DispatchQueue!
    var cancellations = 0
    private var accepted: [ScriptedGatewayConnection] = []
    deinit { accepted.forEach { $0.discardCallbacks() } }
    func onState(_ handler: @escaping (NWListener.State) -> Void) {
        stateHandler = handler
    }

    func onConnection(_ handler: @escaping (any GatewayByteConnection) -> Void) {
        connectionHandler = handler
    }

    func start(queue: DispatchQueue) {
        self.queue = queue
        queue.async { self.stateHandler!(.ready) }
    }

    func cancel() {
        cancellations += 1
    }

    func accept(_ connection: ScriptedGatewayConnection) {
        queue.sync { accepted.append(connection)
            connectionHandler!(connection)
        }
    }

    func state(_ value: NWListener.State) {
        queue.sync { stateHandler!(value) }
    }

    func onQueue(_ body: () -> Void) {
        queue.sync(execute: body)
    }
}

final class ScriptedGatewayNetwork: @unchecked Sendable {
    let listener = ScriptedGatewayListener()
    var connections: [ScriptedGatewayConnection]
    var endpoints: [NWEndpoint] = []
    private let owned: [ScriptedGatewayConnection]
    init(_ connections: [ScriptedGatewayConnection] = []) {
        self.connections = connections
        owned = connections
    }

    deinit { owned.forEach { $0.discardCallbacks() } }
    var transport: GatewayNetworkTransport {
        GatewayNetworkTransport(makeConnection: { endpoint, _ in
            self.endpoints.append(endpoint)
            return self.connections.removeFirst()
        }, makeListener: { _ in self.listener })
    }
}

final class ScriptedGatewayDeadline: GatewayDeadline, @unchecked Sendable {
    let queue: DispatchQueue
    let action: () -> Void
    private(set) var deadline = DispatchTime.distantFuture
    private(set) var cancelled = false
    private var queued = false
    init(queue: DispatchQueue, action: @escaping () -> Void) {
        self.queue = queue
        self.action = action
    }

    func schedule(deadline: DispatchTime) {
        self.deadline = deadline
        queued = false
    }

    func cancel() {
        cancelled = true
    }

    func queuedExpiry(at now: DispatchTime) -> () -> Void {
        queue.sync {
            precondition(!cancelled && !queued && deadline <= now)
            queued = true
            return action
        }
    }

    func deliver(_ callback: () -> Void) {
        queue.sync(execute: callback)
    }

    func expire(at now: DispatchTime) {
        let callback = queuedExpiry(at: now)
        deliver(callback)
    }
}

final class ScriptedGatewayClock: @unchecked Sendable {
    private var nanoseconds: UInt64 = 1_000_000_000
    private(set) var deadlines: [ScriptedGatewayDeadline] = []
    var now: DispatchTime {
        DispatchTime(uptimeNanoseconds: nanoseconds)
    }

    func advance(_ seconds: TimeInterval) {
        nanoseconds += UInt64(seconds * 1_000_000_000)
    }

    var clock: GatewayDeadlineClock {
        GatewayDeadlineClock(now: { self.now }, make: { queue, action in
            let deadline = ScriptedGatewayDeadline(queue: queue, action: action)
            self.deadlines.append(deadline)
            return deadline
        })
    }
}
