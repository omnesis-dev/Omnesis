// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// Bounds physical reads across screens. Cancelled consumers leave the queue;
/// an already running transport retains its slot until it actually finishes.
actor ScopeReadCoordinator {
    static let shared = ScopeReadCoordinator()
    private struct Entry {
        let id: UUID
        let task: Task<Data, Error>
        var consumers: Set<UUID>
        var started: Bool
    }

    private struct Waiting {
        let key: String
        let id: UUID
        let continuation: CheckedContinuation<Void, Error>
    }

    private var inFlight: [String: Entry] = [:]
    private var active = 0
    private var waiting: [Waiting] = []
    var queuedCount: Int {
        waiting.count
    }

    func read(key: String, operation: @escaping @Sendable () async throws -> Data) async throws -> Data {
        try Task.checkCancellation()
        let consumer = UUID()
        let id: UUID
        let task: Task<Data, Error>
        if var entry = inFlight[key] {
            entry.consumers.insert(consumer)
            inFlight[key] = entry
            id = entry.id
            task = entry.task
        } else {
            id = UUID()
            task = Task {
                try await acquire(key: key, id: id)
                do {
                    let data = try await operation()
                    finish(key: key, id: id)
                    return data
                } catch {
                    finish(key: key, id: id)
                    throw error
                }
            }
            inFlight[key] = Entry(id: id, task: task, consumers: [consumer], started: false)
        }
        return try await withTaskCancellationHandler {
            let data = try await task.value
            try Task.checkCancellation()
            return data
        } onCancel: {
            Task { await self.removeConsumer(key: key, id: id, consumer: consumer) }
        }
    }

    private func removeConsumer(key: String, id: UUID, consumer: UUID) {
        guard var entry = inFlight[key], entry.id == id else { return }
        entry.consumers.remove(consumer)
        if entry.consumers.isEmpty, !entry.started {
            inFlight[key] = nil
            if let index = waiting.firstIndex(where: { $0.key == key && $0.id == id }) {
                waiting.remove(at: index).continuation.resume(throwing: CancellationError())
            }
        } else { inFlight[key] = entry }
    }

    private func acquire(key: String, id: UUID) async throws {
        guard var entry = inFlight[key], entry.id == id, !entry.consumers.isEmpty else { throw CancellationError() }
        if active < 2 {
            active += 1
            entry.started = true
            inFlight[key] = entry
            return
        }
        try await withCheckedThrowingContinuation { waiting.append(.init(key: key, id: id, continuation: $0)) }
    }

    private func finish(key: String, id: UUID) {
        // Invalidate before the task completes and releases any of its waiters.
        if inFlight[key]?.id == id { inFlight[key] = nil }
        while !waiting.isEmpty {
            let next = waiting.removeFirst()
            if var entry = inFlight[next.key], entry.id == next.id, !entry.consumers.isEmpty {
                entry.started = true
                inFlight[next.key] = entry
                next.continuation.resume()
                return
            }
            next.continuation.resume(throwing: CancellationError())
        }
        active -= 1
    }
}
