// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

public let activitySegmentsHostedSourceContract = HostedSourceContract(
    sourceType: "activity-segments",
    multiDeviceMode: .partitioned
)

#if os(iOS)

/// `OmnesisSource` implementation for iPhone motion-activity logging —
/// the first non-HealthKit source in the app. Gated to `os(iOS)`
/// (rather than `canImport(CoreMotion)`) because `CMMotionActivityManager`,
/// which the default `provider` wraps, is explicitly unavailable on
/// macOS; gating on the framework's mere importability wouldn't compile
/// out the reference to that class for the `swift test` logic lane.
///
/// Unlike `AppleHealthSource`'s per-type anchored rotation,
/// `queryActivityStarting` is a single plain range read bounded by the
/// OS's own ~7-day retention — so `sync(cursor:)` always finishes in
/// one page (`hasMore` is always `false`) and the cursor is a single
/// watermark (`ActivitySegmentsCursor`) rather than a per-type anchor
/// map.
@available(iOS 17.0, *)
public struct ActivitySegmentsSource: OmnesisSource {
    public let id: String
    public let displayName: String
    public let analyticsSchemas: [AnalyticsTableSchema]
    public let multiDeviceMode: SourceMultiDeviceMode = .partitioned

    /// Hardcoded suffix in the source id (`activity-segments:local`)
    /// and in the per-record `account_id` analytics column — mirrors
    /// `AppleHealthSource`.
    private static let accountId = "local"

    /// `CMMotionActivityManager`'s own retention window. Querying
    /// further back returns nothing, so backfill can never reach past
    /// it regardless of what the cursor says.
    private static let retentionDays = 7

    private let provider: MotionActivityProviding

    public init(provider: MotionActivityProviding = CoreMotionActivityProvider()) {
        self.id = "activity-segments:\(Self.accountId)"
        self.displayName = "Activity Segments"
        self.analyticsSchemas = [ActivitySegmentSchema.table]
        self.provider = provider
    }

    public func sync(cursor: SyncCursor?) async throws -> SyncResult {
        let typed = ActivitySegmentsCursor.decode(from: cursor)
        let now = Date()
        let retentionFloor = now.addingTimeInterval(-Double(Self.retentionDays) * 86400)
        let from = max(typed.lastConfirmedStart ?? retentionFloor, retentionFloor)

        let samples = try await provider.queryActivity(from: from, to: now)
        let outcome = ActivitySegmentMerger.merge(samples: samples, now: now)

        let records = outcome.closedSegments.map { ActivitySegmentSchema.record(from: $0, accountId: Self.accountId) }

        // `outcome.closedSegments` is only what THIS sync's window still
        // contains — once the cursor watermark advances past a segment,
        // it falls out of every future window. `ActivitySegmentAccumulator`
        // (pure, testable independently of this os(iOS)-gated type) carries
        // history across syncs so the document is always built from a
        // day's full history, not just this slice.
        let calendar = Calendar.current
        let accumulated = ActivitySegmentAccumulator.apply(
            newlyClosed: outcome.closedSegments,
            pending: typed.pendingSegments,
            previousWatermark: typed.lastConfirmedStart,
            calendar: calendar
        )

        // Built from the WHOLE accumulator in one call so `splitByDay`
        // clips any single segment straddling midnight into its two
        // per-day pieces once, rather than this method re-deriving that
        // same split independently per day and racing itself.
        let documents = ActivitySegmentDocumentBuilder.dailyDocuments(
            from: accumulated.forDocuments,
            calendar: calendar,
            providerId: id,
            sourceId: id
        )

        let advanced = ActivitySegmentsCursor(
            lastConfirmedStart: accumulated.newWatermark,
            pendingSegments: accumulated.newPending
        )

        return SyncResult(
            records: records,
            tableName: ActivitySegmentSchema.table.tableName,
            schema: ActivitySegmentSchema.table,
            cursor: advanced.encode(),
            hasMore: false,
            documents: documents
        )
    }
}
#endif
