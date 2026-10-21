// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// Coalesces media-close requests until the gateway confirms its canonical lease is free.
@MainActor
final class RealtimeEndHandshake {
    enum Outcome: Equatable { case acknowledged, timedOut, cancelled }

    private struct Pending {
        let generation: UUID
        var waiters: [CheckedContinuation<Outcome, Never>]
    }

    private var pending: Pending?
    private var completed: (generation: UUID, outcome: Outcome)?
    private var deadline: Task<Void, Never>?

    func wait(
        generation: UUID,
        timeout: Duration = .seconds(5),
        send: () -> Void
    ) async
        -> Outcome {
        if let completed, completed.generation == generation { return completed.outcome }
        return await withCheckedContinuation { continuation in
            if pending?.generation == generation {
                pending?.waiters.append(continuation)
                return
            }
            if let old = pending { complete(generation: old.generation, outcome: .cancelled) }
            completed = nil
            pending = Pending(generation: generation, waiters: [continuation])
            deadline = Task { [weak self] in
                do { try await Task.sleep(for: timeout) } catch { return }
                self?.complete(generation: generation, outcome: .timedOut)
            }
            send()
        }
    }

    func acknowledge(generation: UUID) {
        complete(generation: generation, outcome: .acknowledged)
    }

    func cancel(generation: UUID) {
        complete(generation: generation, outcome: .cancelled)
    }

    func isWaiting(generation: UUID) -> Bool {
        pending?.generation == generation
    }

    private func complete(generation: UUID, outcome: Outcome) {
        guard let pending, pending.generation == generation else { return }
        self.pending = nil
        completed = (generation, outcome)
        deadline?.cancel()
        deadline = nil
        for waiter in pending.waiters {
            waiter.resume(returning: outcome)
        }
    }
}
