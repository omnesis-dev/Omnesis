// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// Samples whose start date falls in `[start, end)`. A nil bound is open.
public struct HealthSampleWindow: Equatable, Sendable {
    public var start: Date?
    public var end: Date?

    public init(start: Date?, end: Date?) {
        self.start = start
        self.end = end
    }

    public func contains(_ date: Date) -> Bool {
        if let start, date < start { return false }
        if let end, date >= end { return false }
        return true
    }
}

/// One anchored read stream over a type: the samples in `window`, read in
/// HealthKit's insertion order from `anchor` onwards.
public struct HealthLane: Equatable, Sendable {
    public var window: HealthSampleWindow
    /// Encoded `HKQueryAnchor`, nil before the first read.
    public var anchor: String?

    public init(window: HealthSampleWindow, anchor: String?) {
        self.window = window
        self.anchor = anchor
    }
}

/// How a type's samples are split so the newest arrive first.
///
/// HealthKit hands an anchored query its samples oldest-inserted first, so
/// one anchor per type serves a new pairing years of history before last
/// night's sleep. Instead each type gets one lane per recency tier — the last
/// day, the week before it, the month before that, and everything older —
/// with boundaries fixed when the lanes are made. The windows partition the
/// timeline, so between them the lanes read every sample exactly once, and
/// each keeps its own anchor so late arrivals in any range (a watch that
/// syncs yesterday's data today, a backdated entry) are still picked up.
public enum HealthRecency {
    private static let day: TimeInterval = 24 * 60 * 60

    /// Tier boundaries as ages, newest first.
    public static let tierAges: [TimeInterval] = [1 * day, 7 * day, 30 * day]

    public static var tierCount: Int {
        tierAges.count + 1
    }

    /// Fresh lanes for one type, with boundaries measured back from `now`
    /// (whole seconds, so they survive the cursor's encoding exactly).
    ///
    /// `anchor` seeds every lane. A type that a single anchor already read
    /// part of passes that anchor here: every lane then starts where the old
    /// read stopped, so nothing it delivered is read twice and nothing after
    /// it is skipped.
    public static func lanes(at now: Date, startingFrom anchor: String?) -> [HealthLane] {
        let origin = Date(timeIntervalSince1970: now.timeIntervalSince1970.rounded(.down))
        let bounds = tierAges.map { origin.addingTimeInterval(-$0) }
        var lanes: [HealthLane] = []
        var upper: Date?
        for lower in bounds {
            lanes.append(HealthLane(window: HealthSampleWindow(start: lower, end: upper), anchor: anchor))
            upper = lower
        }
        lanes.append(HealthLane(window: HealthSampleWindow(start: nil, end: upper), anchor: anchor))
        return lanes
    }
}

/// One read the current pass still owes: `tier` of `identifier`.
public struct HealthRead: Equatable, Sendable {
    public let identifier: String
    public let tier: Int
}

/// Serializable cursor passed between CollectorCore and AppleHealthSource.
///
/// Structure:
///   - `lanesByIdentifier` — per type, one `HealthLane` per recency tier
///     (see `HealthRecency`), newest first. Stored deflated (`lanesZ`);
///     the plain `lanes` object is still read.
///   - `pending` — the reads the current pass still owes, one queue per
///     tier. A pass reads tier 0 of every type, round-robin a page at a
///     time, then tier 1, and so on: every type is brought up to date with
///     its recent samples before any time goes to history. A type whose
///     page came back full goes to the back of its tier's queue. Each pass
///     starts the newest tier afresh (`beginPass`), rotated so that a wake
///     that runs out of time does not always favour the same types, and
///     resumes the older tiers where the previous pass stopped.
///   - `anchorsByIdentifier` — the single per-type anchor older builds kept.
///     Read once, to seed that type's lanes, then dropped.
///   - `lastCycleCompletedAt` — ISO 8601 time of the last complete pass.
///
/// The cursor is persisted server-side via `/sync-state/:sourceId`
/// (see `CursorStore`), per device for this replicated source: anchors are
/// positions in this phone's own HealthKit database.
public struct AppleHealthCursor: Sendable, Equatable {
    public var lanesByIdentifier: [String: [HealthLane]]
    public var pending: [[String]]
    public var passCount: Int
    public var anchorsByIdentifier: [String: String]
    public var lastCycleCompletedAt: String?

    public init(
        lanesByIdentifier: [String: [HealthLane]] = [:],
        pending: [[String]] = [],
        passCount: Int = 0,
        anchorsByIdentifier: [String: String] = [:],
        lastCycleCompletedAt: String? = nil
    ) {
        self.lanesByIdentifier = lanesByIdentifier
        self.pending = pending
        self.passCount = passCount
        self.anchorsByIdentifier = anchorsByIdentifier
        self.lastCycleCompletedAt = lastCycleCompletedAt
    }

    // MARK: - Passes

    /// Open a pass over `identifiers` (the enabled catalog, in order):
    /// make lanes for any type that has none, queue the newest tier of
    /// every type afresh, and carry on with the older tiers where the last
    /// pass stopped — or queue them all again once that backlog is done.
    ///
    /// Restarting only the newest tier is what keeps history moving: a wake
    /// too short to get past re-reading every type's recent lane would
    /// otherwise begin the same history read again and again.
    public mutating func beginPass(identifiers: [String], now: Date) {
        for identifier in identifiers where lanesByIdentifier[identifier] == nil {
            let legacy = anchorsByIdentifier.removeValue(forKey: identifier)
            lanesByIdentifier[identifier] = HealthRecency.lanes(at: now, startingFrom: legacy)
        }
        let rotation = identifiers.isEmpty ? 0 : passCount % identifiers.count
        let order = Array(identifiers[rotation...] + identifiers[..<rotation])
        var queues = Array(repeating: order, count: HealthRecency.tierCount)
        let history = pending.dropFirst()
        if pending.count == HealthRecency.tierCount, history.contains(where: { !$0.isEmpty }) {
            queues.replaceSubrange(1..., with: history)
        }
        pending = queues
        passCount += 1
    }

    public var isPassOpen: Bool {
        pending.contains { !$0.isEmpty }
    }

    /// The next read the open pass owes, or nil when it is done.
    public func nextRead() -> HealthRead? {
        for (tier, queue) in pending.enumerated() {
            if let identifier = queue.first {
                return HealthRead(identifier: identifier, tier: tier)
            }
        }
        return nil
    }

    public func lane(for read: HealthRead) -> HealthLane? {
        guard let lanes = lanesByIdentifier[read.identifier], lanes.indices.contains(read.tier) else { return nil }
        return lanes[read.tier]
    }

    /// Record a finished read: its lane moves to `anchor`, and the type goes
    /// to the back of its tier's queue while it has more to give.
    public mutating func complete(_ read: HealthRead, anchor: String?, hasMore: Bool) {
        if let anchor, lanesByIdentifier[read.identifier]?.indices.contains(read.tier) == true {
            lanesByIdentifier[read.identifier]?[read.tier].anchor = anchor
        }
        dequeue(read)
        if hasMore {
            pending[read.tier].append(read.identifier)
        }
    }

    /// Drop a read the pass cannot make (a type this OS cannot query).
    public mutating func skip(_ read: HealthRead) {
        dequeue(read)
    }

    public mutating func closePass(at now: Date) {
        pending = []
        lastCycleCompletedAt = Self.timestamp.string(from: now)
    }

    private mutating func dequeue(_ read: HealthRead) {
        guard pending.indices.contains(read.tier),
              let index = pending[read.tier].firstIndex(of: read.identifier) else { return }
        pending[read.tier].remove(at: index)
    }

    private static let timestamp = ISO8601DateFormatter()

    // MARK: - SyncCursor bridging

    /// Convert a `SyncCursor` (loaded from the gateway) into a typed
    /// cursor. Missing / malformed fields fall back to defaults.
    public static func decode(from cursor: SyncCursor?) -> AppleHealthCursor {
        guard let cursor else { return AppleHealthCursor() }
        var typed = AppleHealthCursor()

        if case .object(let obj) = cursor["anchorsByIdentifier"] {
            for (key, value) in obj {
                if case .string(let anchor) = value {
                    typed.anchorsByIdentifier[key] = anchor
                }
            }
        }
        // Compressed lanes first; the plain form is what build 369 wrote.
        let lanes: JSONValue? = if case .string(let packed) = cursor["lanesZ"] {
            unpack(packed)
        } else {
            cursor["lanes"]
        }
        if case .object(let obj) = lanes {
            for (identifier, value) in obj {
                guard case .array(let rawLanes) = value else { continue }
                let decoded = rawLanes.compactMap(decodeLane)
                if decoded.count == rawLanes.count, decoded.count == HealthRecency.tierCount {
                    typed.lanesByIdentifier[identifier] = decoded
                }
            }
        }
        if case .array(let tiers) = cursor["pending"] {
            typed.pending = tiers.map { tier in
                guard case .array(let ids) = tier else { return [] }
                return ids.compactMap { if case .string(let identifier) = $0 { identifier } else { nil } }
            }
        }
        if case .int(let count) = cursor["passCount"] {
            typed.passCount = Int(count)
        }
        if case .string(let completedAt) = cursor["lastCycleCompletedAt"] {
            typed.lastCycleCompletedAt = completedAt
        }
        return typed
    }

    /// Encode back into the untyped `[String: JSONValue]` shape the
    /// gateway persists.
    public func encode() -> SyncCursor {
        let lanes = JSONValue.object(lanesByIdentifier.mapValues { .array($0.map(Self.encodeLane)) })
        var dict: [String: JSONValue] = [
            "version": .int(2),
            "pending": .array(pending.map { .array($0.map(JSONValue.string)) }),
            "passCount": .int(Int64(passCount)),
        ]
        if let packed = Self.pack(lanes) {
            dict["lanesZ"] = .string(packed)
        } else {
            dict["lanes"] = lanes
        }
        if !anchorsByIdentifier.isEmpty {
            dict["anchorsByIdentifier"] = .object(anchorsByIdentifier.mapValues(JSONValue.string))
        }
        if let lastCycleCompletedAt {
            dict["lastCycleCompletedAt"] = .string(lastCycleCompletedAt)
        }
        return dict
    }

    /// The lanes, deflated and base64-encoded. The cursor is saved on the
    /// gateway after every page, and its anchors — four per type, each an
    /// archived `HKQueryAnchor` of several hundred bytes, mostly repeats of
    /// one another — make it some 185 KB with every type enabled; deflated
    /// it is a few KB.
    private static func pack(_ lanes: JSONValue) -> String? {
        let encoder = JSONEncoder()
        encoder.outputFormatting = .sortedKeys
        guard let json = try? encoder.encode(lanes),
              let deflated = try? (json as NSData).compressed(using: .zlib) else { return nil }
        return (deflated as Data).base64EncodedString()
    }

    private static func unpack(_ packed: String) -> JSONValue? {
        guard let deflated = Data(base64Encoded: packed),
              let json = try? (deflated as NSData).decompressed(using: .zlib) else { return nil }
        return try? JSONDecoder().decode(JSONValue.self, from: json as Data)
    }

    private static func encodeLane(_ lane: HealthLane) -> JSONValue {
        var obj: [String: JSONValue] = [:]
        if let start = lane.window.start { obj["start"] = .int(Int64(start.timeIntervalSince1970)) }
        if let end = lane.window.end { obj["end"] = .int(Int64(end.timeIntervalSince1970)) }
        if let anchor = lane.anchor { obj["anchor"] = .string(anchor) }
        return .object(obj)
    }

    private static func decodeLane(_ value: JSONValue) -> HealthLane? {
        guard case .object(let obj) = value else { return nil }
        func date(_ key: String) -> Date? {
            if case .int(let seconds) = obj[key] { Date(timeIntervalSince1970: TimeInterval(seconds)) } else { nil }
        }
        let anchor: String? = if case .string(let encoded) = obj["anchor"] { encoded } else { nil }
        return HealthLane(window: HealthSampleWindow(start: date("start"), end: date("end")), anchor: anchor)
    }
}
