// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// The clock a sync measures its deadline and its work against. Injected so
/// tests can run a whole background wake on simulated time.
public protocol SyncClock: Sendable {
    func now() -> Date
    /// Suspend until `date`, or return early when the task is cancelled.
    func sleep(until date: Date) async
}

public struct SystemSyncClock: SyncClock {
    public init() {}

    public func now() -> Date {
        Date()
    }

    public func sleep(until date: Date) async {
        let interval = date.timeIntervalSinceNow
        guard interval > 0 else { return }
        try? await Task.sleep(nanoseconds: UInt64(interval * 1_000_000_000))
    }
}

/// How long a sync may keep working before iOS suspends the app.
///
/// A background wake — an `HKObserverQuery` callback, a `BGAppRefreshTask` —
/// comes with tens of seconds, and anything still running when they run out
/// is frozen mid-read or mid-upload. Work therefore asks the budget before it
/// starts each unit (a page read, a batch upload) whether that unit can still
/// finish, rather than discovering at suspension that it could not. A
/// foreground sync is `unbounded`.
public struct SyncBudget: Sendable {
    /// Time held back from the deadline for the bookkeeping that follows the
    /// last unit of work: saving the cursor, publishing status, and telling
    /// iOS the wake is done.
    public static let safetyMargin: TimeInterval = 2

    public static let unbounded = SyncBudget(deadline: nil)

    public let clock: any SyncClock
    public let deadline: Date?

    public init(clock: any SyncClock = SystemSyncClock(), deadline: Date?) {
        self.clock = clock
        self.deadline = deadline
    }

    /// A budget that ends `seconds` from now on `clock`.
    public static func seconds(_ seconds: TimeInterval, clock: any SyncClock = SystemSyncClock()) -> SyncBudget {
        SyncBudget(clock: clock, deadline: clock.now().addingTimeInterval(seconds))
    }

    public var isBounded: Bool {
        deadline != nil
    }

    public func remaining() -> TimeInterval {
        guard let deadline else { return .infinity }
        return deadline.timeIntervalSince(clock.now())
    }

    /// Whether work expected to take `cost` seconds can finish in time,
    /// leaving the safety margin.
    public func allows(_ cost: TimeInterval) -> Bool {
        remaining() >= cost + Self.safetyMargin
    }

    /// The later of two budgets: the one a shared pass should honour when
    /// several wakes wait on it. Unbounded wins.
    public func extended(to other: SyncBudget) -> SyncBudget {
        guard let mine = deadline, let theirs = other.deadline else { return SyncBudget(clock: clock, deadline: nil) }
        return SyncBudget(clock: clock, deadline: max(mine, theirs))
    }
}

/// A running estimate of how long one unit of work takes, so a budget check
/// can ask about the next unit before starting it. Starts from a
/// conservative guess and follows what is measured, never below the most
/// recent observation.
struct WorkEstimate: Sendable {
    private(set) var expected: TimeInterval

    init(initial: TimeInterval) {
        expected = initial
    }

    mutating func record(_ duration: TimeInterval) {
        expected = max(duration, (expected + duration) / 2)
    }
}

/// Wait for `work` to finish, but no longer than `budget` allows.
///
/// Returns the work's value, or nil when the deadline (less the safety
/// margin) came first. The work is not cancelled: it bounds itself by the
/// same budget and winds down on its own, while the caller is free to tell
/// iOS the wake is over before iOS decides for it.
public func awaitWithinBudget<T: Sendable>(_ work: Task<T, Never>, budget: SyncBudget) async -> T? {
    guard let deadline = budget.deadline else { return await work.value }
    let cutoff = deadline.addingTimeInterval(-SyncBudget.safetyMargin)
    let clock = budget.clock
    let race = FirstOf<T?>()
    return await withCheckedContinuation { continuation in
        race.arm(continuation)
        let timer = Task {
            await clock.sleep(until: cutoff)
            race.resume(nil)
        }
        Task {
            let value = await work.value
            race.resume(value)
            timer.cancel()
        }
    }
}

/// Resumes one continuation with whichever of several racers answers first.
private final class FirstOf<T: Sendable>: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<T, Never>?

    func arm(_ continuation: CheckedContinuation<T, Never>) {
        lock.lock()
        self.continuation = continuation
        lock.unlock()
    }

    func resume(_ value: T) {
        lock.lock()
        let pending = continuation
        continuation = nil
        lock.unlock()
        pending?.resume(returning: value)
    }
}
