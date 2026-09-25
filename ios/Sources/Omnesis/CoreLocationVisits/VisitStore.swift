// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// Durable buffer of completed visits, persisted so a visit delivered while
/// the app is backgrounded (or that relaunched the app) survives until the
/// collector next syncs.
///
/// Core Location visit monitoring is push-only with no history API: a
/// `didVisit` callback is delivered exactly once and can never be re-queried
/// (unlike `CMMotionActivityManager`'s ~7-day retention, which lets
/// `ActivitySegmentsSource` stay stateless and just re-read). So a visit
/// must be persisted the instant it arrives, before any sync runs. The
/// source drains this buffer, dedups against its own cursor, and the gateway
/// upserts idempotently — so returning an already-seen visit is harmless,
/// and entries are pruned only once they age past the retention window.
public final class VisitStore: @unchecked Sendable {
    private static let key = "omnesis.coreLocationVisits.buffer"

    private let defaults: KeyValueDefaults
    private let lock = NSLock()

    public init(defaults: KeyValueDefaults = UserDefaults.standard) {
        self.defaults = defaults
    }

    /// Append a completed visit, keeping one entry per arrival (a later
    /// callback for the same arrival only refines its departure, so the
    /// newest wins).
    public func append(_ visit: RawVisit) {
        lock.lock()
        defer { lock.unlock() }
        var all = load()
        all.removeAll { $0.arrival == visit.arrival }
        all.append(visit)
        save(all)
    }

    /// Return every retained visit, pruning any that arrived more than
    /// `retentionDays` ago so the buffer stays bounded. Kept in sync with the
    /// cursor's own pruning horizon so a pruned visit can never reappear as a
    /// spurious "fresh" one.
    public func retained(retentionDays: Int = CoreLocationVisitsRetention.days, now: Date = Date()) -> [RawVisit] {
        lock.lock()
        defer { lock.unlock() }
        let floor = now.addingTimeInterval(-Double(retentionDays) * 86400)
        let all = load()
        let kept = all.filter { $0.arrival >= floor }
        if kept.count != all.count {
            save(kept)
        }
        return kept.sorted { $0.arrival < $1.arrival }
    }

    /// Wipe the buffer — called on unpair so a fresh pairing doesn't inherit
    /// a previous session's pending visits.
    public func reset() {
        lock.lock()
        defer { lock.unlock() }
        defaults.removeObject(forKey: Self.key)
    }

    // MARK: - Persistence

    private func load() -> [RawVisit] {
        guard let data = defaults.object(forKey: Self.key) as? Data else { return [] }
        return (try? JSONDecoder().decode([RawVisit].self, from: data)) ?? []
    }

    private func save(_ visits: [RawVisit]) {
        guard let data = try? JSONEncoder().encode(visits) else { return }
        defaults.set(data, forKey: Self.key)
    }
}
