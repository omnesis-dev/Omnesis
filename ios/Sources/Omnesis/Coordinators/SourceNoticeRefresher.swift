// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// Brings source notices up to date after `sync.status` events.
///
/// An event carries no notices — the gateway composes them from stored state
/// when a status is read — so after an event that can change them the
/// statuses are read again and only their notices are adopted. Reads are
/// coalesced: one runs once events have been quiet for `delay`, and never
/// later than `maxWait` after the first event still waiting on it, so a
/// steady stream of transitions cannot postpone it for ever.
@MainActor
final class SourceNoticeRefresher {
    var delay: Duration = .seconds(1)
    var maxWait: Duration = .seconds(3)

    /// The read waiting out its delay. Once its read starts it is no longer
    /// here, so a later schedule queues the next read instead of abandoning
    /// one already under way.
    private var pending: Task<Void, Never>?
    private var firstPendingAt: ContinuousClock.Instant?
    /// Bumped by `cancel`, so a read already under way can recognise that
    /// what it would apply is older than what replaced it.
    private var epoch = 0

    /// Whether an event warrants a read: it moved the source or one of its
    /// devices into a new state or failure, or it reports a completed sync,
    /// which is when issues, coverage and replica disputes are recorded.
    /// Progress ticks do neither.
    static func shouldRead(eventState: String?, before: SourceSyncStatus?, after: SourceSyncStatus) -> Bool {
        eventState == "completed" || signature(before) != signature(after)
    }

    private static func signature(_ status: SourceSyncStatus?) -> [String] {
        guard let status else { return [] }
        let members = (status.members ?? []).map { "\($0.deviceId ?? "")|\($0.state)|\($0.errorMessage ?? "")" }
        return ["\(status.state)|\(status.errorMessage ?? "")"] + members.sorted()
    }

    /// Schedule a read. `read` fetches the statuses; `apply` receives them
    /// unless `cancel` has been called since. A failed read is dropped — the
    /// statuses keep what they show.
    func schedule(
        read: @escaping @Sendable () async throws -> [SourceSyncStatus],
        apply: @escaping @MainActor ([SourceSyncStatus]) -> Void
    ) {
        let clock = ContinuousClock()
        let now = clock.now
        let first = firstPendingAt ?? now
        firstPendingAt = first
        let deadline = min(now.advanced(by: delay), first.advanced(by: maxWait))
        let scheduledEpoch = epoch
        pending?.cancel()
        pending = Task { [weak self] in
            try? await Task.sleep(until: deadline, clock: clock)
            guard !Task.isCancelled, let self, self.epoch == scheduledEpoch else { return }
            self.pending = nil
            self.firstPendingAt = nil
            guard let fresh = try? await read(), self.epoch == scheduledEpoch else { return }
            apply(fresh)
        }
    }

    /// Drop any pending or running read, so it cannot land over state that
    /// is newer than it — a full refresh, or a cleared cache.
    func cancel() {
        pending?.cancel()
        pending = nil
        firstPendingAt = nil
        epoch += 1
    }
}
