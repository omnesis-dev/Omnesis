// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

/// The two records behind one watch, folded into the one list a reader sees.
///
/// The runtime records what a watch *caught*; the record that authorises its
/// egress records what it actually *sent*. Neither half alone answers "did it
/// fire, and was anyone told" — and a reader given both as separate lists has
/// to work out which is which and count one watch's firings twice.
final class WatchLedgerTests: XCTestCase {
    private func caught(_ seq: Int) -> WatchFiringRecord {
        WatchFiringRecord(seq: seq, firedAt: "2026-05-04T09:15:00.000Z", noticedAt: nil)
    }

    private func sent(_ id: String, seq: Int? = nil, createdAt: Int64 = 1) -> PrivacySubscriptionFiring {
        PrivacySubscriptionFiring(
            id: id,
            subscriptionId: "subscription-example",
            revisionId: "revision-example",
            workflowHandle: "workflow-example",
            createdAt: createdAt,
            deliveryStatus: "delivered",
            acceptedAt: nil,
            watchId: seq == nil ? nil : "watch-example",
            seq: seq
        )
    }

    func testAFiringCaughtAndAFiringSentBecomeOneRow() {
        let rows = mergeWatchFirings(caught: [caught(41)], sent: [sent("sf-41", seq: 41)])

        XCTAssertEqual(rows.count, 1)
        XCTAssertEqual(rows.first?.caught?.seq, 41)
        XCTAssertEqual(rows.first?.sent?.id, "sf-41")
    }

    func testNewestFirstWhateverOrderTheRouteArrivesIn() {
        let rows = mergeWatchFirings(caught: [caught(41), caught(99), caught(70)], sent: [])

        XCTAssertEqual(rows.compactMap(\.caught?.seq), [99, 70, 41])
    }

    /// A record written before the runtime stamped a firing with its own
    /// identity names no journal event, so nothing caught can be joined to it.
    /// Dropping it would understate what left the machine.
    func testASentFiringWithNoJournalEventStillGetsARow() {
        let rows = mergeWatchFirings(
            caught: [caught(41)],
            sent: [sent("sf-old", createdAt: 10), sent("sf-older", createdAt: 5)]
        )

        XCTAssertEqual(rows.map(\.id), ["seq:41", "sent:sf-old", "sent:sf-older"])
        XCTAssertNil(rows[1].caught)
    }

    func testASentFiringThatMatchesNothingCaughtIsNotSilentlyMerged() {
        // Its sequence names an event this page of the runtime ledger does not
        // hold, so it is its own row rather than folded into an unrelated one.
        let rows = mergeWatchFirings(caught: [caught(41)], sent: [sent("sf-77", seq: 77)])

        XCTAssertEqual(rows.count, 2)
        XCTAssertEqual(rows.map(\.id), ["seq:41", "sent:sf-77"])
    }

    /// Which watch is still doing something is the question the list answers,
    /// and each row states its own status — so ordering carries it and no
    /// heading has to.
    func testRunningWatchesSortAboveHeldAndFinishedOnes() {
        let watches = [
            watch(id: "done", status: "retired"),
            watch(id: "held", status: "paused"),
            watch(id: "first", status: "active"),
            watch(id: "second", status: "active"),
        ]

        XCTAssertEqual(
            orderedWatches(watches).map(\.id),
            ["first", "second", "held", "done"]
        )
    }

    func testAStatusThisBuildHasNeverHeardOfSortsWithTheFinished() {
        let watches = [watch(id: "hibernating", status: "hibernating"), watch(id: "live", status: "active")]

        XCTAssertEqual(orderedWatches(watches).map(\.id), ["live", "hibernating"])
    }

    private func watch(id: String, status: String) -> WatchRecord {
        WatchRecord(id: id, name: id, status: status, firings: 0, note: nil, request: nil)
    }
}
