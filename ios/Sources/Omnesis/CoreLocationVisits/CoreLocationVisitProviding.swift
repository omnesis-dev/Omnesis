// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// Seam over Core Location visit monitoring so `CoreLocationVisitsSource` is
/// testable without CoreLocation: a fake returns a canned list, the real
/// impl below buffers `CLLocationManagerDelegate.didVisit` callbacks to a
/// durable `VisitStore`. The source calls `drainVisits()` each sync and
/// dedups against its cursor, so returning already-seen visits is harmless.
public protocol CoreLocationVisitProviding: Sendable {
    func drainVisits() async -> [RawVisit]
}

/// In-memory fake for tests — returns whatever it was seeded with.
public final class FakeVisitProvider: CoreLocationVisitProviding, @unchecked Sendable {
    public var visits: [RawVisit]

    public init(visits: [RawVisit] = []) {
        self.visits = visits
    }

    public func drainVisits() async -> [RawVisit] {
        visits
    }
}

#if os(iOS) && canImport(CoreLocation)
@preconcurrency import CoreLocation

/// Real `CoreLocationVisitProviding` backed by `CLLocationManager` visit
/// monitoring. Gated to `os(iOS)`: visit monitoring is an iOS capability and
/// the whole type is compiled out on the macOS logic lane (which drives the
/// source through the fake instead).
///
/// Visit monitoring is low-power and delivers in the background — iOS even
/// relaunches the app to hand off a visit — so no `location` background mode
/// is needed, only `Always` authorization. Each completed visit is persisted
/// the instant it arrives (there is no history to re-query) and a sync is
/// nudged so the buffer drains promptly.
public final class CoreLocationVisitProvider: NSObject, CoreLocationVisitProviding,
    CLLocationManagerDelegate, @unchecked Sendable {
    private let manager: CLLocationManager
    private let store: VisitStore
    private var onVisit: (@Sendable () -> Void)?
    private var onAuthorizationChanged: (@Sendable () -> Void)?

    public init(store: VisitStore = VisitStore(), manager: CLLocationManager = CLLocationManager()) {
        self.manager = manager
        self.store = store
        super.init()
        manager.delegate = self
    }

    /// Begin monitoring. `onVisit` is invoked after each completed visit is
    /// buffered so the caller can trigger a sync. Safe to call repeatedly.
    /// Never asks for location access: `LocationVisitsAuthorization` does
    /// that when the user turns Places on.
    public func start(
        onVisit: @escaping @Sendable () -> Void,
        onAuthorizationChanged: @escaping @Sendable () -> Void = {}
    ) {
        self.onVisit = onVisit
        self.onAuthorizationChanged = onAuthorizationChanged
        manager.startMonitoringVisits()
    }

    public func stop() {
        manager.stopMonitoringVisits()
        onVisit = nil
        onAuthorizationChanged = nil
    }

    public func drainVisits() async -> [RawVisit] {
        store.retained()
    }

    public func locationManager(_: CLLocationManager, didVisit visit: CLVisit) {
        // An arrival-only callback (still there) carries no dwell window —
        // wait for the departure callback, which re-delivers the visit fully
        // bounded.
        guard visit.departureDate != .distantFuture else { return }
        // `arrivalDate` is `.distantPast` when Core Location doesn't know when
        // the dwell began (e.g. it was already underway when monitoring
        // started). Arrival is this source's whole time anchor and identity —
        // a visit without a real one can't be placed on the timeline or
        // de-duplicated, so drop it rather than index an undated stay.
        guard visit.arrivalDate != .distantPast else { return }
        // A negative accuracy marks an invalid coordinate — nothing to name.
        guard visit.horizontalAccuracy >= 0 else { return }
        store.append(
            RawVisit(
                latitude: visit.coordinate.latitude,
                longitude: visit.coordinate.longitude,
                horizontalAccuracy: visit.horizontalAccuracy,
                arrival: visit.arrivalDate,
                departure: visit.departureDate
            )
        )
        onVisit?()
    }

    public func locationManagerDidChangeAuthorization(_: CLLocationManager) {
        onAuthorizationChanged?()
    }
}
#endif
