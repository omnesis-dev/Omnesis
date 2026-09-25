// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// Serializable cursor passed between `CollectorCore` and `PhotosSource`.
///
/// Backfill priority order is a phased, mutually-exclusive partition of
/// the library:
///   1. `.screenshots` — every screenshot.
///   2. `.recent` — non-screenshot photos from the last 30 days.
///   3. `.backfill` — everything else (the remainder of the library).
///
/// Each phase is OCR + place + metadata only (the cheap backfill tier —
/// no captioning/labeling). Because the three predicates never overlap,
/// walking each phase's `PHFetchResult` to the end drains it exactly
/// once — unlike `AppleHealthCursor`, this cursor does NOT wrap back to
/// phase 0 on completion (a full re-OCR of the whole library on every
/// cycle would defeat the point of a one-time backfill). Once
/// `.backfill` drains, the cursor moves to `.steady` and stamps
/// `backfillCompletedAt`.
///
/// In `.steady`, the recent-album fast path runs alongside one page of
/// whole-library discovery per sync. The same compound resume key survives
/// restarts and wraps when the visible library ends, finding old imports
/// and newly selected Limited-access assets behind a prior watermark.
/// Delivery acknowledgments skip existing assets without re-analysis.
public struct PhotosCursor: Sendable, Equatable {
    public enum Phase: String, Sendable, Equatable {
        case screenshots
        case recent
        case backfill
        case steady
    }

    public var phase: Phase
    /// Resume point within the current backfill phase: the stable
    /// external id (see `StableAssetId`) of the last asset processed.
    /// Paired with `lastAssetDate` as a compound `(date, id)` key —
    /// `PHAsset.creationDate` alone can collide (burst photos share a
    /// timestamp), so resuming compares both, mirroring the
    /// `DATE > watermark OR (DATE = watermark AND id > lastId)` pattern
    /// used elsewhere in the codebase for cursors with non-unique
    /// timestamps. `nil` at the start of a phase.
    public var lastAssetId: String?
    /// ISO-8601 `creationDate` of the last asset processed within the
    /// current phase. See `lastAssetId`.
    public var lastAssetDate: String?
    /// ISO-8601 timestamp stamped once all three backfill phases have
    /// drained and the cursor first enters `.steady`.
    public var backfillCompletedAt: String?
    /// Monotonic local authorization generation. A Full-access restoration
    /// increments it, making an older steady cursor restart the full walk.
    public var accessEpoch: Int

    public init(
        phase: Phase = .screenshots,
        lastAssetId: String? = nil,
        lastAssetDate: String? = nil,
        backfillCompletedAt: String? = nil,
        accessEpoch: Int = 0
    ) {
        self.phase = phase
        self.lastAssetId = lastAssetId
        self.lastAssetDate = lastAssetDate
        self.backfillCompletedAt = backfillCompletedAt
        self.accessEpoch = accessEpoch
    }

    /// The single formatter every `Date ↔ String` conversion for this
    /// cursor's asset-resume bookkeeping goes through — encoding AND any
    /// comparison. Comparing a freshly-fetched `Date` against a
    /// round-tripped one is precision-asymmetric (the round-trip can
    /// lose sub-format precision the fresh value still has); formatting
    /// BOTH sides through this same formatter before comparing avoids
    /// that asymmetry (see `PhotoLibraryReading.fetchPage`).
    public static let dateFormatter: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    /// Missing creation dates use the distant-past key in the Swift pager.
    /// A PhotoKit date predicate would exclude those nil dates, so keep the
    /// fetch unfiltered until the cursor advances beyond their sentinel.
    static func fetchDateFloor(after dateString: String?) -> Date? {
        guard let dateString, dateString != dateFormatter.string(from: .distantPast) else { return nil }
        return dateFormatter.date(from: dateString)
    }

    /// The next phase in backfill priority order, or `.steady` once
    /// `.backfill` (the last phase) completes.
    public var nextPhase: Phase {
        switch phase {
        case .screenshots: .recent
        case .recent: .backfill
        case .backfill: .steady
        case .steady: .steady
        }
    }

    // MARK: - SyncCursor bridging

    /// Convert a `SyncCursor` (loaded from the gateway) into a typed
    /// cursor. Missing / malformed fields fall back to defaults (a
    /// fresh backfill from `.screenshots`).
    public static func decode(from cursor: SyncCursor?) -> PhotosCursor {
        guard let cursor else { return PhotosCursor() }

        var phase = Phase.screenshots
        if case .string(let raw) = cursor["phase"], let parsed = Phase(rawValue: raw) {
            phase = parsed
        }

        var lastAssetId: String?
        if case .string(let value) = cursor["lastAssetId"] {
            lastAssetId = value
        }

        var lastAssetDate: String?
        if case .string(let value) = cursor["lastAssetDate"] {
            lastAssetDate = value
        }

        var backfillCompletedAt: String?
        if case .string(let value) = cursor["backfillCompletedAt"] {
            backfillCompletedAt = value
        }

        var accessEpoch = 0
        if case .int(let value) = cursor["accessEpoch"] {
            accessEpoch = Int(value)
        }

        return PhotosCursor(
            phase: phase,
            lastAssetId: lastAssetId,
            lastAssetDate: lastAssetDate,
            backfillCompletedAt: backfillCompletedAt,
            accessEpoch: accessEpoch
        )
    }

    /// Encode back into the untyped `[String: JSONValue]` shape the
    /// gateway persists.
    public func encode() -> SyncCursor {
        var dict: [String: JSONValue] = ["phase": .string(phase.rawValue)]
        if let lastAssetId {
            dict["lastAssetId"] = .string(lastAssetId)
        }
        if let lastAssetDate {
            dict["lastAssetDate"] = .string(lastAssetDate)
        }
        if let backfillCompletedAt {
            dict["backfillCompletedAt"] = .string(backfillCompletedAt)
        }
        dict["accessEpoch"] = .int(Int64(accessEpoch))
        return dict
    }
}
