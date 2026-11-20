// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

final class AppleHealthCursorTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_780_000_000)
    private let types = ["TypeA", "TypeB", "TypeC"]

    /// Drain a pass's reads, answering "full page" for the first `fullPages`
    /// reads of each (type, tier), and return the order they were asked for.
    private func drain(_ cursor: inout AppleHealthCursor, fullPages: [String: Int] = [:]) -> [HealthRead] {
        var order: [HealthRead] = []
        var served: [String: Int] = [:]
        while let read = cursor.nextRead() {
            order.append(read)
            let key = "\(read.identifier)#\(read.tier)"
            let full = served[key, default: 0] < fullPages[key, default: 0]
            served[key, default: 0] += 1
            cursor.complete(read, anchor: "\(key)@\(served[key]!)", hasMore: full)
            XCTAssertLessThan(order.count, 1000, "a pass must terminate")
        }
        return order
    }

    func testEveryTypesRecentLaneIsReadBeforeAnyHistory() {
        var cursor = AppleHealthCursor()
        cursor.beginPass(identifiers: types, now: now)
        let order = drain(&cursor)

        XCTAssertEqual(order.count, types.count * HealthRecency.tierCount)
        let tiers = order.map(\.tier)
        XCTAssertEqual(tiers, tiers.sorted(), "no history read may come before a newer tier finishes")
        XCTAssertEqual(Set(order.prefix(types.count).map(\.identifier)), Set(types))
    }

    func testAFullRecentPageGoesToTheBackOfItsTierNotTheFront() {
        var cursor = AppleHealthCursor()
        cursor.beginPass(identifiers: types, now: now)
        // TypeA has three pages of last-day data; B and C have one.
        let order = drain(&cursor, fullPages: ["TypeA#0": 2])

        let recent = order.filter { $0.tier == 0 }.map(\.identifier)
        XCTAssertEqual(
            recent,
            ["TypeA", "TypeB", "TypeC", "TypeA", "TypeA"],
            "a deep type must not hold the others' recent data back"
        )
        XCTAssertEqual(order.prefix(5).map(\.tier), [0, 0, 0, 0, 0])
    }

    func testBackfillPagesAreRoundRobinAndEachLaneAdvancesItsOwnAnchor() {
        var cursor = AppleHealthCursor()
        cursor.beginPass(identifiers: types, now: now)
        let last = HealthRecency.tierCount - 1
        let order = drain(&cursor, fullPages: ["TypeA#\(last)": 1, "TypeB#\(last)": 1])

        let history = order.filter { $0.tier == last }.map(\.identifier)
        XCTAssertEqual(history, ["TypeA", "TypeB", "TypeC", "TypeA", "TypeB"])
        XCTAssertEqual(cursor.lanesByIdentifier["TypeA"]?[last].anchor, "TypeA#\(last)@2")
        XCTAssertEqual(cursor.lanesByIdentifier["TypeA"]?[0].anchor, "TypeA#0@1")
        XCTAssertFalse(cursor.isPassOpen)
    }

    func testANewPassStartsWithRecentDataAgainAfterAnInterruptedOne() throws {
        var cursor = AppleHealthCursor()
        cursor.beginPass(identifiers: types, now: now)
        // The wake ran out of time deep in history.
        for _ in 0 ..< 3 * types.count {
            let read = try XCTUnwrap(cursor.nextRead())
            cursor.complete(read, anchor: nil, hasMore: false)
        }
        XCTAssertEqual(cursor.nextRead()?.tier, 3)

        var resumed = AppleHealthCursor.decode(from: cursor.encode())
        resumed.beginPass(identifiers: types, now: now.addingTimeInterval(600))
        XCTAssertEqual(resumed.nextRead()?.tier, 0, "the next wake begins with recent samples")
    }

    func testHistoryResumesWhereAnInterruptedPassStoppedIt() throws {
        var cursor = AppleHealthCursor()
        cursor.beginPass(identifiers: types, now: now)
        // Recent tier done, then one history read before time ran out.
        for _ in 0 ..< types.count + 1 {
            let read = try XCTUnwrap(cursor.nextRead())
            cursor.complete(read, anchor: nil, hasMore: false)
        }
        let owed = cursor.pending.dropFirst().flatMap { $0 }

        cursor.beginPass(identifiers: types, now: now)
        XCTAssertEqual(cursor.pending[0].count, types.count, "recent lanes are polled again first")
        XCTAssertEqual(cursor.pending.dropFirst().flatMap { $0 }, owed, "history is not started over")

        _ = drain(&cursor)
        cursor.beginPass(identifiers: types, now: now)
        XCTAssertEqual(
            cursor.pending.dropFirst().map(\.count),
            Array(repeating: types.count, count: HealthRecency.tierCount - 1),
            "once the backlog is done, the next pass polls every older lane again"
        )
    }

    func testPassesRotateWhichTypeGoesFirst() {
        var cursor = AppleHealthCursor()
        var firsts: [String] = []
        for _ in 0 ..< types.count {
            cursor.beginPass(identifiers: types, now: now)
            firsts.append(cursor.nextRead()?.identifier ?? "")
        }
        XCTAssertEqual(Set(firsts), Set(types), "a short wake must not always favour the same type")
    }

    func testLaneWindowsPartitionTheTimeline() {
        let lanes = HealthRecency.lanes(at: now, startingFrom: nil)
        XCTAssertEqual(lanes.count, HealthRecency.tierCount)
        XCTAssertNil(lanes.first?.window.end, "the newest lane stays open for new samples")
        XCTAssertNil(lanes.last?.window.start, "the oldest lane reaches back to the beginning")
        for (newer, older) in zip(lanes, lanes.dropFirst()) {
            XCTAssertEqual(newer.window.start, older.window.end, "adjacent lanes share a boundary, so none is skipped")
        }
        let samples = stride(from: -400.0, through: 2.0, by: 0.25).map { now.addingTimeInterval($0 * 86400) }
        for date in samples {
            XCTAssertEqual(lanes.filter { $0.window.contains(date) }.count, 1, "\(date) must fall in exactly one lane")
        }
    }

    func testALegacyAnchorSeedsEveryLaneSoNothingIsReadTwiceOrSkipped() throws {
        let legacy: SyncCursor = [
            "cycleIndex": .int(4),
            "anchorsByIdentifier": .object(["TypeA": .string("legacy-anchor-a")]),
        ]
        var cursor = AppleHealthCursor.decode(from: legacy)
        cursor.beginPass(identifiers: types, now: now)

        let migrated = try XCTUnwrap(cursor.lanesByIdentifier["TypeA"])
        XCTAssertEqual(migrated.map(\.anchor), Array(repeating: "legacy-anchor-a", count: HealthRecency.tierCount))
        XCTAssertEqual(cursor.lanesByIdentifier["TypeB"]?.map(\.anchor), Array(repeating: nil, count: HealthRecency.tierCount))
        XCTAssertNil(cursor.encode()["anchorsByIdentifier"], "a migrated anchor is not carried forward")
    }

    func testRoundTripViaSyncCursor() {
        var cursor = AppleHealthCursor()
        cursor.beginPass(identifiers: types, now: now)
        _ = drain(&cursor, fullPages: ["TypeB#1": 1])
        cursor.beginPass(identifiers: types, now: now)
        if let read = cursor.nextRead() { cursor.complete(read, anchor: "fresh", hasMore: true) }

        XCTAssertEqual(AppleHealthCursor.decode(from: cursor.encode()), cursor)
    }

    /// Build 369 stored lanes uncompressed; a phone updating from it must
    /// carry on from those anchors.
    func testAPlainLanesCursorFromBuild369IsStillRead() {
        var cursor = AppleHealthCursor()
        cursor.beginPass(identifiers: types, now: now)
        _ = drain(&cursor, fullPages: ["TypeA#0": 1])
        var plain = cursor.encode()
        XCTAssertNotNil(plain.removeValue(forKey: "lanesZ"))
        plain["lanes"] = .object(cursor.lanesByIdentifier.mapValues { lanes in
            .array(lanes.map { lane in
                var obj: [String: JSONValue] = [:]
                if let start = lane.window.start { obj["start"] = .int(Int64(start.timeIntervalSince1970)) }
                if let end = lane.window.end { obj["end"] = .int(Int64(end.timeIntervalSince1970)) }
                if let anchor = lane.anchor { obj["anchor"] = .string(anchor) }
                return .object(obj)
            })
        })

        XCTAssertEqual(AppleHealthCursor.decode(from: plain), cursor)
    }

    /// Saved after every page, so it must stay small with every type
    /// enabled: four lanes a type, each anchor an archived `HKQueryAnchor`
    /// of ~550 base64 characters, most of them repeats.
    func testACursorWithEveryTypeEnabledStaysAFewKilobytes() throws {
        let token = String(repeating: "d5cb1bf77bf8096e10c9690a23e5779c", count: 4)
        let anchors = (0 ..< 42).map { row in
            Data("bplist00-archived-HKQueryAnchor-rowid-\(1_000_000 + row * 7919)-clientToken-\(token)".utf8)
                .base64EncodedString() + String(repeating: "A", count: 300)
        }
        var cursor = AppleHealthCursor()
        let identifiers = (0 ..< 76).map { "HKQuantityTypeIdentifier\($0)" }
        cursor.beginPass(identifiers: identifiers, now: now)
        var index = 0
        while let read = cursor.nextRead() {
            cursor.complete(read, anchor: anchors[index % anchors.count], hasMore: false)
            index += 1
        }

        let bytes = try JSONEncoder().encode(cursor.encode()).count
        XCTAssertLessThan(bytes, 16 * 1024, "the cursor is \(bytes) bytes")
        XCTAssertEqual(AppleHealthCursor.decode(from: cursor.encode()), cursor)
    }

    func testDecodeEmptyCursorGivesDefaults() {
        let cursor = AppleHealthCursor.decode(from: nil)
        XCTAssertTrue(cursor.lanesByIdentifier.isEmpty)
        XCTAssertFalse(cursor.isPassOpen)
        XCTAssertNil(cursor.lastCycleCompletedAt)
    }

    func testMalformedFieldsFallBackToDefaults() {
        let raw: SyncCursor = [
            "lanes": .object(["TypeA": .array([.string("not-a-lane")])]),
            "pending": .string("nope"),
            "anchorsByIdentifier": .array([]),
            "lastCycleCompletedAt": .int(42),
        ]
        let cursor = AppleHealthCursor.decode(from: raw)
        XCTAssertTrue(cursor.lanesByIdentifier.isEmpty)
        XCTAssertTrue(cursor.anchorsByIdentifier.isEmpty)
        XCTAssertFalse(cursor.isPassOpen)
        XCTAssertNil(cursor.lastCycleCompletedAt)
    }
}
