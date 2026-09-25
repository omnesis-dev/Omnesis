// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

/// When an event earns a status read, and how reads coalesce.
@MainActor
final class SourceNoticeRefresherTests: XCTestCase {
    private final class Counter: @unchecked Sendable {
        private let lock = NSLock()
        private var value = 0

        func bump() {
            lock.lock()
            value += 1
            lock.unlock()
        }

        var count: Int {
            lock.lock()
            defer { lock.unlock() }
            return value
        }
    }

    private func status(
        state: String,
        errorMessage: String? = nil,
        members: [SourceSyncStatus]? = nil,
        deviceId: String? = nil
    )
        -> SourceSyncStatus {
        SourceSyncStatus(
            sourceId: "notes:shared",
            deviceId: deviceId,
            members: members,
            state: state,
            unitName: nil,
            progress: nil,
            startedAt: nil,
            lastSyncAt: nil,
            errorMessage: errorMessage,
            erroredAt: nil,
            lastUpdated: nil
        )
    }

    func testOnlyATransitionOrACompletionEarnsARead() {
        let syncing = status(state: "syncing")
        XCTAssertFalse(SourceNoticeRefresher.shouldRead(eventState: "syncing", before: syncing, after: syncing))
        XCTAssertTrue(SourceNoticeRefresher.shouldRead(eventState: "completed", before: nil, after: syncing))
        XCTAssertTrue(
            SourceNoticeRefresher.shouldRead(eventState: "completed", before: syncing, after: syncing),
            "a completed sync records issues and coverage even when the state holds"
        )
        XCTAssertTrue(
            SourceNoticeRefresher.shouldRead(eventState: "error", before: syncing, after: status(state: "error"))
        )
        XCTAssertTrue(
            SourceNoticeRefresher.shouldRead(
                eventState: "error",
                before: status(state: "error", errorMessage: "Disk full"),
                after: status(state: "error", errorMessage: "Disk unreadable")
            )
        )
    }

    func testAMemberTransitionEarnsAReadEvenWhenTheAggregateHolds() {
        let before = status(
            state: "syncing",
            members: [status(state: "syncing", deviceId: "dev-1")]
        )
        let after = status(
            state: "syncing",
            members: [status(state: "error", deviceId: "dev-1")]
        )
        XCTAssertTrue(SourceNoticeRefresher.shouldRead(eventState: "error", before: before, after: after))
    }

    func testReadsCoalesceAndApplyOnce() async {
        let refresher = SourceNoticeRefresher()
        refresher.delay = .milliseconds(100)
        let reads = Counter()
        var applied = 0
        for _ in 0 ..< 5 {
            refresher.schedule(
                read: {
                    reads.bump()
                    return []
                },
                apply: { _ in applied += 1 }
            )
        }
        try? await Task.sleep(nanoseconds: 400_000_000)
        XCTAssertEqual(reads.count, 1)
        XCTAssertEqual(applied, 1)
    }

    func testASteadyStreamStillReadsByTheMaximumWait() async {
        let refresher = SourceNoticeRefresher()
        refresher.delay = .milliseconds(200)
        refresher.maxWait = .milliseconds(300)
        let reads = Counter()
        let started = Date()
        var firstReadAfter: TimeInterval?
        // Every 50ms for 700ms: the quiet delay alone would never elapse.
        for _ in 0 ..< 14 {
            refresher.schedule(
                read: {
                    reads.bump()
                    return []
                },
                apply: { _ in
                    if firstReadAfter == nil { firstReadAfter = Date().timeIntervalSince(started) }
                }
            )
            try? await Task.sleep(nanoseconds: 50_000_000)
        }
        let readDuringStream = firstReadAfter
        XCTAssertNotNil(readDuringStream, "a read must land while events keep coming")
        XCTAssertLessThan(readDuringStream ?? .infinity, 0.65)
        refresher.cancel()
    }

    func testCancelDropsAPendingRead() async {
        let refresher = SourceNoticeRefresher()
        refresher.delay = .milliseconds(100)
        let reads = Counter()
        refresher.schedule(
            read: {
                reads.bump()
                return []
            },
            apply: { _ in }
        )
        refresher.cancel()
        try? await Task.sleep(nanoseconds: 300_000_000)
        XCTAssertEqual(reads.count, 0)
    }

    func testACancelledRunningReadIsNotApplied() async {
        let refresher = SourceNoticeRefresher()
        refresher.delay = .milliseconds(10)
        var applied = 0
        refresher.schedule(
            read: {
                try await Task.sleep(nanoseconds: 200_000_000)
                return []
            },
            apply: { _ in applied += 1 }
        )
        try? await Task.sleep(nanoseconds: 80_000_000)
        refresher.cancel()
        try? await Task.sleep(nanoseconds: 300_000_000)
        XCTAssertEqual(applied, 0)
    }

    func testNoticesWithoutADeviceAreKeptUnderNoDevice() throws {
        let json = """
        {"sourceId":"a:b","state":"synced","members":[
          {"sourceId":"a:b","state":"error","errorMessage":"Disk unreadable"},
          {"sourceId":"a:b","deviceId":"dev-1","state":"synced","notices":[]}
        ]}
        """
        let decoded = try JSONDecoder().decode(SourceSyncStatus.self, from: Data(json.utf8))
        let groups = decoded.noticesByDevice(fallbackDeviceId: "dev-1")
        XCTAssertEqual(groups.map(\.deviceId), [nil, "dev-1"])
        XCTAssertEqual(groups.first?.notices.first?.title, "The last sync failed")
    }
}
