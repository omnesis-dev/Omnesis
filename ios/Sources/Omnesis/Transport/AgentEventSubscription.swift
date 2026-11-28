// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// One event iterator and its exact producer/watchdog lifetime.
/// Joining covers these application tasks, not private Foundation callbacks or kernel sockets.
public struct AgentEventSubscription: Sendable {
    public let stream: AsyncThrowingStream<AgentStreamItem, Error>
    private let lifetime: AgentEventLifetime

    init(stream: AsyncThrowingStream<AgentStreamItem, Error>, lifetime: AgentEventLifetime) {
        self.stream = stream
        self.lifetime = lifetime
    }

    public func cancel() {
        lifetime.cancel()
    }

    /// Cancel first when ending a live subscription. Cancellation of the joining caller
    /// does not abandon the retained task handles.
    public func join() async {
        await lifetime.join()
    }
}

/// Installation is synchronous before a subscription escapes. Termination can race installation.
final class AgentEventLifetime: @unchecked Sendable {
    private let lock = NSLock()
    private var cancelled = false
    private var tasks: [Task<Void, Never>] = []
    private var transport: URLSessionTask?

    func install(producer: Task<Void, Never>, watchdog: Task<Void, Never>) {
        let shouldCancel = lock.withLock {
            precondition(tasks.isEmpty)
            tasks = [producer, watchdog]
            return cancelled
        }
        if shouldCancel { producer.cancel()
            watchdog.cancel()
        }
    }

    func install(transport: URLSessionTask) {
        let shouldCancel = lock.withLock {
            precondition(self.transport == nil)
            self.transport = transport
            return cancelled
        }
        if shouldCancel { transport.cancel() }
    }

    func cancel() {
        let owned = lock.withLock {
            cancelled = true
            return (tasks, transport)
        }
        owned.0.forEach { $0.cancel() }
        owned.1?.cancel()
    }

    func join() async {
        let owned = lock.withLock { tasks }
        precondition(owned.count == 2, "A subscription must install both tasks before publication")
        for task in owned {
            await task.value
        }
    }
}
