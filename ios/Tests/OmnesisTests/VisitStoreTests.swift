// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

final class VisitStoreTests: XCTestCase {
    private var defaults: DictionaryDefaults!
    private var store: VisitStore!

    override func setUp() {
        super.setUp()
        defaults = DictionaryDefaults()
        store = VisitStore(defaults: defaults)
    }

    private func visit(arrival: Date, departure: Date) -> RawVisit {
        RawVisit(latitude: 37.77, longitude: -122.41, horizontalAccuracy: 25, arrival: arrival, departure: departure)
    }

    func testAppendPersistsAcrossInstances() {
        let arrival = Date(timeIntervalSince1970: 1_700_000_000)
        store.append(visit(arrival: arrival, departure: arrival.addingTimeInterval(3600)))
        let reloaded = VisitStore(defaults: defaults)
        XCTAssertEqual(reloaded.retained(now: arrival).count, 1)
    }

    func testAppendDedupsByArrivalKeepingNewest() {
        let arrival = Date(timeIntervalSince1970: 1_700_000_000)
        store.append(visit(arrival: arrival, departure: arrival.addingTimeInterval(600)))
        store.append(visit(arrival: arrival, departure: arrival.addingTimeInterval(3600)))
        let all = store.retained(now: arrival)
        XCTAssertEqual(all.count, 1)
        XCTAssertEqual(all[0].departure, arrival.addingTimeInterval(3600))
    }

    func testRetainedPrunesVisitsOlderThanRetention() {
        let now = Date(timeIntervalSince1970: 1_700_000_000)
        let old = now.addingTimeInterval(-Double(CoreLocationVisitsRetention.days + 1) * 86400)
        let recent = now.addingTimeInterval(-3600)
        store.append(visit(arrival: old, departure: old.addingTimeInterval(600)))
        store.append(visit(arrival: recent, departure: recent.addingTimeInterval(600)))
        let kept = store.retained(now: now)
        XCTAssertEqual(kept.count, 1)
        XCTAssertEqual(kept[0].arrival, recent)
        // The prune is persisted, not just filtered on read.
        XCTAssertEqual(VisitStore(defaults: defaults).retained(now: now).count, 1)
    }

    func testResetClearsBuffer() {
        let arrival = Date(timeIntervalSince1970: 1_700_000_000)
        store.append(visit(arrival: arrival, departure: arrival.addingTimeInterval(600)))
        store.reset()
        XCTAssertTrue(store.retained(now: arrival).isEmpty)
    }
}
