// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// Serializable cursor passed between CollectorCore and AppleHealthSource.
///
/// Structure:
///   - `cycleIndex` — which position in `TypeCatalog.v1` we're on in
///     the current rotation. When a rotation completes, we wrap back
///     to 0 on the next observer-driven sync.
///   - `anchorsByIdentifier` — per-type `HKQueryAnchor` encoded as
///     base64 (via `NSKeyedArchiver`) under the identifier key.
///   - `lastCycleCompletedAt` — ISO 8601 timestamp so we can display
///     "last full scan N minutes ago" in the UI.
///
/// The cursor is persisted server-side via `/sync-state/:sourceId`
/// (see `CursorStore`). Anchors survive app reinstalls if the gateway
/// cursor survives — which is the intent, since HealthKit on the new
/// iPhone has the same UUIDs (via iCloud sync) that the anchors refer to.
public struct AppleHealthCursor: Sendable, Equatable {
    public var cycleIndex: Int
    public var anchorsByIdentifier: [String: String]
    public var lastCycleCompletedAt: String?

    public init(
        cycleIndex: Int = 0,
        anchorsByIdentifier: [String: String] = [:],
        lastCycleCompletedAt: String? = nil
    ) {
        self.cycleIndex = cycleIndex
        self.anchorsByIdentifier = anchorsByIdentifier
        self.lastCycleCompletedAt = lastCycleCompletedAt
    }

    // MARK: - SyncCursor bridging

    /// Convert a `SyncCursor` (loaded from the gateway) into a typed
    /// cursor. Missing / malformed fields fall back to defaults.
    public static func decode(from cursor: SyncCursor?) -> AppleHealthCursor {
        guard let cursor else { return AppleHealthCursor() }

        var cycleIndex = 0
        if case .int(let i) = cursor["cycleIndex"] {
            cycleIndex = Int(i)
        }

        var anchors: [String: String] = [:]
        if case .object(let obj) = cursor["anchorsByIdentifier"] {
            for (key, value) in obj {
                if case .string(let s) = value {
                    anchors[key] = s
                }
            }
        }

        var lastCompleted: String?
        if case .string(let s) = cursor["lastCycleCompletedAt"] {
            lastCompleted = s
        }

        return AppleHealthCursor(
            cycleIndex: cycleIndex,
            anchorsByIdentifier: anchors,
            lastCycleCompletedAt: lastCompleted
        )
    }

    /// Encode back into the untyped `[String: JSONValue]` shape the
    /// gateway persists.
    public func encode() -> SyncCursor {
        var dict: [String: JSONValue] = [
            "cycleIndex": .int(Int64(cycleIndex)),
            "anchorsByIdentifier": .object(
                anchorsByIdentifier.mapValues { JSONValue.string($0) }
            ),
        ]
        if let lastCycleCompletedAt {
            dict["lastCycleCompletedAt"] = .string(lastCycleCompletedAt)
        }
        return dict
    }

    // MARK: - Helpers

    public mutating func setAnchor(_ encoded: String?, for identifier: String) {
        if let encoded {
            anchorsByIdentifier[identifier] = encoded
        } else {
            anchorsByIdentifier.removeValue(forKey: identifier)
        }
    }

    public func anchor(for identifier: String) -> String? {
        anchorsByIdentifier[identifier]
    }
}
