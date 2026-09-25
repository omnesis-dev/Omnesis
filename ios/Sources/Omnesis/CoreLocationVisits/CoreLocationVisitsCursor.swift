// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// Serializable cursor for `CoreLocationVisitsSource`. Records which visit
/// arrivals have already been emitted, so a re-drained visit (the buffer is
/// pruned only by age, not on read) isn't re-uploaded or re-geocoded.
///
/// Keyed by arrival timestamp rather than a monotonic watermark on purpose:
/// Core Location can deliver a departure callback out of order or late, so a
/// simple "everything before T is done" watermark would silently drop a
/// straggler. A visit that failed to reverse-geocode is deliberately *not*
/// recorded here, so a later sync retries it while it's still in the buffer.
/// The set is pruned to the same retention window as `VisitStore`, so it
/// can't grow without bound and a pruned arrival can't reappear as fresh.
public struct CoreLocationVisitsCursor: Sendable, Equatable {
    /// ISO-8601 arrival timestamps of visits already emitted.
    public var emittedArrivals: Set<String>

    public init(emittedArrivals: Set<String> = []) {
        self.emittedArrivals = emittedArrivals
    }

    public static func decode(from cursor: SyncCursor?) -> CoreLocationVisitsCursor {
        guard let cursor, case .array(let raw)? = cursor["emittedArrivals"] else {
            return CoreLocationVisitsCursor()
        }
        let arrivals = raw.compactMap { value -> String? in
            guard case .string(let iso) = value else { return nil }
            return iso
        }
        return CoreLocationVisitsCursor(emittedArrivals: Set(arrivals))
    }

    public func encode() -> SyncCursor {
        guard !emittedArrivals.isEmpty else { return [:] }
        // Sorted for a stable serialization (the set's own order is
        // non-deterministic) — keeps the persisted cursor diff-friendly.
        return ["emittedArrivals": .array(emittedArrivals.sorted().map(JSONValue.string))]
    }

    /// Add newly-emitted arrivals and drop any now older than the retention
    /// window, keeping the set bounded and aligned with `VisitStore`'s prune.
    public func recording(
        _ arrivals: [String],
        now: Date = Date(),
        retentionDays: Int = CoreLocationVisitsRetention.days
    )
        -> CoreLocationVisitsCursor {
        let floor = now.addingTimeInterval(-Double(retentionDays) * 86400)
        let merged = emittedArrivals.union(arrivals)
        let kept = merged.filter { iso in
            // Keep anything we can't parse rather than silently dropping it;
            // a malformed entry is harmless (it just can't match a visit).
            guard let date = VisitTime.parse(iso) else { return true }
            return date >= floor
        }
        return CoreLocationVisitsCursor(emittedArrivals: kept)
    }
}
