// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// Serializable cursor for `ActivitySegmentsSource`. Simpler than
/// `AppleHealthCursor`'s per-type anchor map: `queryActivityStarting`
/// is a plain range read (bounded by the OS's ~7-day retention), not
/// anchored/paged, so a single watermark date is enough for *querying*.
///
/// Building the daily document needs more than the watermark, though:
/// once `lastConfirmedStart` advances past a segment, that segment falls
/// out of every future `queryActivity` window, so a later sync has no way
/// to re-derive it from CoreMotion. `pendingSegments` is the durable
/// record of every closed segment not yet guaranteed permanently
/// finalized, carried across syncs specifically so the document can
/// always be rebuilt from a day's FULL history — not just whatever a
/// single sync's window happened to still contain — the same problem
/// Android's `ActivitySegmentsHistoryStore` solves with a local SQLite
/// table. `ActivitySegmentsSource` prunes a segment out once its whole
/// day falls before the watermark's day, since that day can never be
/// touched by a future sync again.
public struct ActivitySegmentsCursor: Sendable, Equatable {
    /// Start of the last CLOSED segment as of the previous sync — not
    /// its end. Re-querying from a closed segment's start (rather than
    /// past it) means a later CoreMotion refinement near that boundary
    /// is never missed; the gateway's upsert absorbs the resulting
    /// redundant re-upload as a no-op.
    public var lastConfirmedStart: Date?

    public var pendingSegments: [ActivitySegment]

    public init(lastConfirmedStart: Date? = nil, pendingSegments: [ActivitySegment] = []) {
        self.lastConfirmedStart = lastConfirmedStart
        self.pendingSegments = pendingSegments
    }

    public static func decode(from cursor: SyncCursor?) -> ActivitySegmentsCursor {
        guard let cursor else { return ActivitySegmentsCursor() }
        let start: Date? = {
            guard case .string(let raw) = cursor["lastConfirmedStart"] else { return nil }
            return iso8601.date(from: raw)
        }()
        let segments: [ActivitySegment] = {
            guard case .array(let raw) = cursor["pendingSegments"] else { return [] }
            return raw.compactMap(decodeSegment)
        }()
        return ActivitySegmentsCursor(lastConfirmedStart: start, pendingSegments: segments)
    }

    public func encode() -> SyncCursor {
        var result: SyncCursor = [:]
        if let lastConfirmedStart {
            result["lastConfirmedStart"] = .string(Self.iso8601.string(from: lastConfirmedStart))
        }
        if !pendingSegments.isEmpty {
            result["pendingSegments"] = .array(pendingSegments.map(Self.encodeSegment))
        }
        return result
    }

    private static func encodeSegment(_ segment: ActivitySegment) -> JSONValue {
        .object([
            "type": .string(segment.type.rawValue),
            "start": .string(iso8601.string(from: segment.start)),
            "end": .string(iso8601.string(from: segment.end)),
            "confidence": .int(Int64(segment.confidence.rawValue)),
        ])
    }

    private static func decodeSegment(_ value: JSONValue) -> ActivitySegment? {
        guard case .object(let obj) = value,
              case .string(let typeRaw)? = obj["type"],
              let type = MotionActivityType(rawValue: typeRaw),
              case .string(let startRaw)? = obj["start"],
              let start = iso8601.date(from: startRaw),
              case .string(let endRaw)? = obj["end"],
              let end = iso8601.date(from: endRaw),
              case .int(let confidenceRaw)? = obj["confidence"],
              let confidence = MotionActivityConfidence(rawValue: Int(confidenceRaw))
        else { return nil }
        return ActivitySegment(type: type, start: start, end: end, confidence: confidence)
    }

    private static let iso8601: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()
}
