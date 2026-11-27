// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// A timed waiter never cancels or abandons the physical ownership operation it is observing.
@MainActor
public final class DesktopBackgroundDrain {
    public enum Result: Equatable, Sendable { case confirmed, blocked }
    private var finished: (time: ContinuousClock.Instant, proven: Bool)?
    private var waiters: [UUID: (CheckedContinuation<Result, Never>, ContinuousClock.Instant)] = [:]
    private var timers: [UUID: Task<Void, Never>] = [:]
    private var operation: Task<Void, Never>?

    public init(_ perform: @escaping @MainActor @Sendable () async -> Bool) {
        operation = Task { [self] in
            let proven = await perform()
            let completed = ContinuousClock.now
            finished = (completed, proven)
            let pending = waiters
            waiters.removeAll()
            for timer in timers.values {
                timer.cancel()
            }
            timers.removeAll()
            for (continuation, deadline) in pending.values {
                continuation.resume(returning: proven && completed < deadline ? .confirmed : .blocked)
            }
        }
    }

    public func join(until deadline: ContinuousClock.Instant) async -> Result {
        if Task.isCancelled { return .blocked }
        if let finished { return finished.proven && finished.time < deadline ? .confirmed : .blocked }
        guard ContinuousClock.now < deadline else { return .blocked }
        let id = UUID()
        return await withTaskCancellationHandler {
            await withCheckedContinuation { continuation in
                waiters[id] = (continuation, deadline)
                timers[id] = Task { [weak self] in
                    do { try await Task.sleep(until: deadline, clock: .continuous) }
                    catch { return }
                    self?.expire(id)
                }
                if Task.isCancelled { expire(id) }
            }
        } onCancel: {
            Task { @MainActor [weak self] in self?.expire(id) }
        }
    }

    private func expire(_ id: UUID) {
        timers.removeValue(forKey: id)?.cancel()
        waiters.removeValue(forKey: id)?.0.resume(returning: .blocked)
    }
}
