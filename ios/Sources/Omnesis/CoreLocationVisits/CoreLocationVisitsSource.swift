// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

public let coreLocationVisitsHostedSourceContract = HostedSourceContract(
    sourceType: "core-location-visits",
    multiDeviceMode: .partitioned
)

/// `OmnesisSource` for iPhone location visits — completed dwells captured by
/// Core Location visit monitoring, each reverse-geocoded on-device into a
/// named place before it reaches the index. Coordinates never feed the
/// searchable content; the agent reasons over place names.
///
/// Unlike `ActivitySegmentsSource` this struct is not `os(iOS)`-gated: it
/// depends only on the `CoreLocationVisitProviding` / `VisitPlaceResolving`
/// seams (both platform-neutral), so the whole `sync(cursor:)` flow —
/// draining, geocoding, cursor advance — is exercised on the macOS logic
/// lane with fakes. The real CoreLocation-backed provider and resolver are
/// injected on iOS from `AppStore`.
public struct CoreLocationVisitsSource: OmnesisSource {
    public let id: String
    public let displayName: String
    public let analyticsSchemas: [AnalyticsTableSchema]
    public let multiDeviceMode: SourceMultiDeviceMode = .partitioned

    /// Hardcoded suffix in the source id (`core-location-visits:local`) and
    /// the per-record `account_id` — mirrors the other iOS-local sources.
    public static let accountId = "local"

    private let provider: any CoreLocationVisitProviding
    private let resolver: any VisitPlaceResolving
    /// What time it is, as this source is told.
    ///
    /// Injected because the retention window a sync prunes against is measured
    /// from it, so a test's fixtures and the clock they are judged by have to
    /// be able to move together. Given a wall clock and fixtures pinned to a
    /// date, a suite passes until the window slides past them and then fails
    /// on every run afterwards — which is not a flake, and moving the date
    /// forward only re-arms it.
    private let now: () -> Date

    public init(
        provider: any CoreLocationVisitProviding,
        resolver: any VisitPlaceResolving,
        now: @escaping () -> Date = Date.init
    ) {
        self.id = "core-location-visits:\(Self.accountId)"
        self.displayName = "Location Visits"
        self.analyticsSchemas = [VisitSchema.table]
        self.provider = provider
        self.resolver = resolver
        self.now = now
    }

    public func sync(cursor: SyncCursor?) async throws -> SyncResult {
        let typed = CoreLocationVisitsCursor.decode(from: cursor)
        let now = now()
        let calendar = Calendar.current

        let buffered = await provider.drainVisits()
        let fresh = VisitMerger.selectFresh(raw: buffered, alreadyEmittedArrivals: typed.emittedArrivals)

        var resolved: [ResolvedVisit] = []
        var emittedArrivals: [String] = []
        resolved.reserveCapacity(fresh.count)
        for visit in fresh {
            guard let departure = visit.departure else { continue }
            // A coordinate that can't be named (offline / throttled) is left
            // unrecorded so a later sync retries it — nothing is indexed as a
            // bare coordinate.
            guard let place = await resolver.resolve(latitude: visit.latitude, longitude: visit.longitude) else {
                continue
            }
            resolved.append(
                ResolvedVisit(
                    arrival: visit.arrival,
                    departure: departure,
                    latitude: visit.latitude,
                    longitude: visit.longitude,
                    horizontalAccuracy: visit.horizontalAccuracy,
                    place: place
                )
            )
            emittedArrivals.append(VisitTime.iso.string(from: visit.arrival))
        }

        let records = resolved.map { VisitSchema.record(from: $0, accountId: Self.accountId) }
        let documents = resolved.map {
            VisitDocumentBuilder.document(
                from: $0,
                providerId: id,
                sourceId: id,
                accountId: Self.accountId,
                calendar: calendar
            )
        }
        let advanced = typed.recording(emittedArrivals, now: now)

        return SyncResult(
            records: records,
            tableName: VisitSchema.table.tableName,
            schema: VisitSchema.table,
            cursor: advanced.encode(),
            hasMore: false,
            documents: documents
        )
    }
}
