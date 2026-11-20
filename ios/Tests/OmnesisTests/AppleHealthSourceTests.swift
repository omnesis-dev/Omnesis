// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if canImport(HealthKit)
import HealthKit
@testable import Omnesis
import XCTest

/// `AppleHealthSource` against `FakeHealthStore`: recent samples first,
/// history after, every sample exactly once across passes and interruptions.
@available(iOS 17.0, macOS 14.0, *)
final class AppleHealthSourceTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_780_000_000)
    private let types = [FakeHealthStore.heartRate, FakeHealthStore.stepCount]
    private let day: TimeInterval = 86400

    private struct Pass {
        var pages: [SyncResult] = []
        var cursor: SyncCursor?
        var ids: [String] {
            pages.flatMap { $0.records.compactMap { if case .string(let id) = $0["id"] { id } else { nil } } }
        }

        var deletedIds: [String] {
            pages.flatMap(\.deletedIds)
        }
    }

    private func source(_ store: FakeHealthStore, pageLimit: Int = 4) -> AppleHealthSource {
        let now = now
        return AppleHealthSource(client: store, catalog: TypeCatalog.entries(types), pageLimit: pageLimit, now: { now })
    }

    /// Run one collector-style pass: `beginPass`, then `sync` until done or
    /// `maxPages` pages, the way `CollectorCore` drives a source.
    private func runPass(_ source: AppleHealthSource, from cursor: SyncCursor?, maxPages: Int = 500) async throws -> Pass {
        var pass = Pass()
        var current = source.beginPass(cursor: cursor)
        while pass.pages.count < maxPages {
            let page = try await source.sync(cursor: current)
            pass.pages.append(page)
            current = page.cursor
            if !page.hasMore { break }
        }
        pass.cursor = current
        return pass
    }

    /// A phone with two years of history saved long ago, then a day of new
    /// samples — the order HealthKit's insertion sequence holds them in.
    private struct Seeded {
        let store: FakeHealthStore
        let recent: Set<String>
        let all: Set<String>
    }

    private func seededStore(into store: FakeHealthStore = FakeHealthStore()) -> Seeded {
        var recent: Set<String> = []
        var all: Set<String> = []
        for type in types {
            for index in 0 ..< 20 {
                let sample = store.add(type, start: now.addingTimeInterval(-Double(730 - index * 30) * day))
                all.insert(sample.uuid.uuidString)
            }
        }
        for type in types {
            for hour in 1 ... 6 {
                let sample = store.add(type, start: now.addingTimeInterval(-Double(hour) * 3600))
                recent.insert(sample.uuid.uuidString)
                all.insert(sample.uuid.uuidString)
            }
        }
        return Seeded(store: store, recent: recent, all: all)
    }

    func testAFreshPairingReadsEveryTypesRecentSamplesBeforeAnyHistory() async throws {
        let seeded = seededStore()
        let (store, recent, all) = (seeded.store, seeded.recent, seeded.all)
        let pass = try await runPass(source(store), from: nil)

        let ids = pass.ids
        XCTAssertEqual(Set(ids.prefix(recent.count)), recent, "the last day of every type comes first")
        XCTAssertEqual(ids.count, all.count, "each sample is read exactly once")
        XCTAssertEqual(Set(ids), all)
        // Both types' recent data is in before either type's deep history.
        let firstPageTypes = Set(pass.pages.prefix(2).compactMap(\.tableName))
        XCTAssertEqual(firstPageTypes.count, 2, "the recent tier is round-robin across types")
    }

    func testAnInterruptedPassResumesWithoutRereadingOrSkippingAnything() async throws {
        let seeded = seededStore()
        let (store, all) = (seeded.store, seeded.all)
        let health = source(store)
        var cursor: SyncCursor?
        var seen: [String] = []
        // Short wakes: three pages each, cursor persisted in between.
        for _ in 0 ..< 40 {
            let pass = try await runPass(health, from: cursor, maxPages: 3)
            seen += pass.ids
            cursor = pass.cursor
            if seen.count >= all.count { break }
        }
        XCTAssertEqual(seen.count, Set(seen).count, "no sample is delivered twice")
        XCTAssertEqual(Set(seen), all, "no range is skipped")
    }

    func testLateArrivalsAndDeletionsInAnyRangeAreReadOnTheNextPass() async throws {
        let store = seededStore().store
        let health = source(store)
        let first = try await runPass(health, from: nil)

        let backdated = store.add(FakeHealthStore.stepCount, start: now.addingTimeInterval(-90 * day))
        let fresh = store.add(FakeHealthStore.heartRate, start: now.addingTimeInterval(-60))
        let lastWeek = store.add(FakeHealthStore.heartRate, start: now.addingTimeInterval(-3 * day))
        let delivered = try XCTUnwrap(first.pages.first { !$0.records.isEmpty })
        let doomedId = try XCTUnwrap(delivered.records.first?["id"]?.stringValue)
        let doomed = try XCTUnwrap(store.storedSample(uuid: doomedId))
        store.delete(doomed)

        let second = try await runPass(health, from: first.cursor)
        XCTAssertEqual(Set(second.ids), Set([backdated, fresh, lastWeek].map(\.uuid.uuidString)))
        XCTAssertEqual(second.deletedIds, [doomedId])
        XCTAssertEqual(second.ids.first, fresh.uuid.uuidString, "a new sample is read first")
    }

    func testACursorFromTheSingleAnchorBuildMigratesWithoutRereading() async throws {
        let seeded = seededStore()
        let (store, all) = (seeded.store, seeded.all)
        // An older build had read the first 25 samples with one anchor per type
        // (the fake's anchors are positions, so one anchor serves both).
        let legacy: SyncCursor = [
            "cycleIndex": .int(1),
            "anchorsByIdentifier": .object([
                FakeHealthStore.heartRate: .string("seq:25"),
                FakeHealthStore.stepCount: .string("seq:25"),
            ]),
        ]
        let pass = try await runPass(source(store), from: legacy)
        let alreadyRead = store.uuids(throughSequence: 25)
        XCTAssertTrue(Set(pass.ids).isDisjoint(with: alreadyRead), "nothing the old anchor delivered is re-read")
        XCTAssertEqual(Set(pass.ids), all.subtracting(alreadyRead), "everything after it is")
    }

    /// HealthKit fills a page with tombstones as readily as samples. A page
    /// of nothing but deletions is a full page, not a caught-up lane.
    func testAPageFullOfDeletionsDoesNotEndItsLane() async throws {
        let store = FakeHealthStore()
        for hour in 1 ... 12 {
            let doomed = store.add(FakeHealthStore.heartRate, start: now.addingTimeInterval(-Double(hour) * 60))
            store.delete(doomed)
        }
        let seeded = seededStore(into: store)
        let (recent, all) = (seeded.recent, seeded.all)
        let pass = try await runPass(source(store), from: nil)

        XCTAssertEqual(Set(pass.ids.prefix(recent.count)), recent, "tombstones must not push recent samples to a later pass")
        XCTAssertEqual(Set(pass.ids), all, "one pass reads every sample")
        XCTAssertEqual(pass.ids.count, all.count)
    }

    func testALockedPhoneEndsThePassWithoutReading() async throws {
        let store = seededStore().store
        store.protectedDataAvailable = false
        let pass = try await runPass(source(store), from: nil)
        XCTAssertEqual(pass.pages.count, 1)
        XCTAssertFalse(pass.pages[0].hasMore)
        XCTAssertEqual(store.anchoredReads, 0)
    }
}

extension JSONValue {
    fileprivate var stringValue: String? {
        if case .string(let text) = self { text } else { nil }
    }
}

#endif
