// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

public let appleHealthHostedSourceContract = HostedSourceContract(
    sourceType: "apple-health",
    multiDeviceMode: .replicated,
    replicaVersionPolicy: "source-updated-at"
)

#if canImport(HealthKit)
import HealthKit

/// `OmnesisSource` implementation for Apple Health.
///
/// A pass reads every enabled type newest-first: each `sync(cursor:)`
/// call reads one page of one recency lane (see `HealthRecency` and
/// `AppleHealthCursor`) — the last day of every type, round-robin, then
/// the week before, the month before, and finally older history — and
/// returns `hasMore = true` until every lane of every type is caught up.
/// `beginPass(cursor:)` restarts that order at each collector pass, so a
/// background wake always spends its first seconds on recent data and only
/// what is left on backfill.
///
/// Why one page per call (instead of all-in-one mega-sync):
///   - The collector checks the wake's remaining time between pages and
///     delivers each page before reading the next.
///   - Each batch → `/analytics/ingest` POST is a single DuckDB
///     table's worth of rows (matches gateway API shape).
///   - Progress is persisted per page, so an interrupted pass loses at
///     most the page in flight.
@available(iOS 17.0, *)
public struct AppleHealthSource: OmnesisSource {
    public let id: String
    public let displayName: String
    public let analyticsSchemas: [AnalyticsTableSchema]
    public let multiDeviceMode: SourceMultiDeviceMode = .replicated

    /// Hardcoded suffix in the source id (`apple-health:local`) and
    /// in the per-record `account_id` analytics column.
    private static let accountId = "local"

    private let reader: any HealthSampleReading
    private let catalog: [TypeEntry]
    private let pageLimit: Int
    private let now: @Sendable () -> Date

    public init(
        client: any HealthSampleReading = HealthKitClient(),
        catalog: [TypeEntry] = TypeCatalog.v1,
        pageLimit: Int = 500,
        now: @escaping @Sendable () -> Date = { Date() }
    ) {
        self.id = "apple-health:\(Self.accountId)"
        self.displayName = "Apple Health"
        self.analyticsSchemas = HealthSchemas.all
        self.reader = client
        self.catalog = catalog
        self.pageLimit = pageLimit
        self.now = now
    }

    public func beginPass(cursor: SyncCursor?) -> SyncCursor? {
        var typed = AppleHealthCursor.decode(from: cursor)
        typed.beginPass(identifiers: catalog.map(\.identifier), now: now())
        return typed.encode()
    }

    // swiftlint:disable:next function_body_length
    public func sync(cursor: SyncCursor?) async throws -> SyncResult {
        var typed = AppleHealthCursor.decode(from: cursor)

        // Protected-data gate. HealthKit samples are file-protection-class
        // encrypted — queries against a locked phone fail with
        // `HKError.errorDatabaseInaccessible` (domain=com.apple.healthkit,
        // code=6, "Protected health data is inaccessible"). We don't want
        // that to surface as a sync error (which would flip the source
        // to SYNC ERROR in the portal + CLI) because it's a transient,
        // expected condition: the HKObserver wake most often fires while
        // the phone is idle + locked. End the sync cycle cleanly and
        // wait for `UIApplication.protectedDataDidBecomeAvailable` to
        // fire another sync (wired in AppStore).
        guard await reader.isProtectedDataAvailable() else {
            return emptyPage(typed, hasMore: false)
        }

        if !typed.isPassOpen {
            typed.beginPass(identifiers: catalog.map(\.identifier), now: now())
        }
        let entries = Dictionary(catalog.map { ($0.identifier, $0) }, uniquingKeysWith: { first, _ in first })
        // Reads this OS cannot make (a type it does not know, a type no
        // longer enabled) are dropped from the pass without a round-trip.
        var next = typed.nextRead()
        while let read = next, entries[read.identifier]?.sampleType == nil || typed.lane(for: read) == nil {
            typed.skip(read)
            next = typed.nextRead()
        }
        guard let read = next,
              let entry = entries[read.identifier],
              let sampleType = entry.sampleType,
              let lane = typed.lane(for: read) else {
            typed.closePass(at: now())
            return emptyPage(typed, hasMore: false)
        }

        // Second defence: even when isProtectedDataAvailable was true at
        // the top, a race is possible (user locks mid-query). Catch the
        // specific HK "protected data inaccessible" error and bail out
        // gracefully — same semantics as the gate above.
        let page: HealthAnchoredPage
        do {
            page = try await reader.anchoredPage(
                type: sampleType,
                window: lane.window,
                anchor: lane.anchor,
                limit: pageLimit
            )
        } catch let err as NSError where err.domain == HKErrorDomain && err.code == HKError.errorDatabaseInaccessible.rawValue {
            return emptyPage(typed, hasMore: false)
        }

        let built = buildRecordsAndDocuments(from: page.samples, entry: entry)
        var documents = built.documents

        // Rebuild the full per-night document for every night this
        // page's sleep samples touched (see `SleepNightBucketer`). This
        // sits alongside the unchanged per-stage analytics rows above —
        // `health_sleep` itself gets no new columns or bound document.
        if entry.category == .sleep, !built.normalizedSamples.isEmpty {
            let nightDocuments = await rebuildTouchedSleepNights(
                entry: entry,
                sampleType: sampleType,
                pageSamples: built.normalizedSamples
            )
            documents.append(contentsOf: nightDocuments)
        }

        // HealthKit counts deleted objects toward the limit, so a page can be
        // full of tombstones with few or no samples; it is the objects, not
        // the samples, that say whether the lane has more.
        let pageWasFull = page.samples.count + page.deletedIds.count >= pageLimit
        typed.complete(read, anchor: page.anchor, hasMore: pageWasFull)
        let hasMore = typed.nextRead() != nil
        if !hasMore {
            typed.closePass(at: now())
        }

        return SyncResult(
            records: built.records,
            tableName: entry.category.tableName,
            schema: HealthSchemas.schema(for: entry.category),
            cursor: typed.encode(),
            hasMore: hasMore,
            deletedIds: page.deletedIds,
            documents: documents
        )
    }

    private func emptyPage(_ cursor: AppleHealthCursor, hasMore: Bool) -> SyncResult {
        SyncResult(records: [], tableName: "health_body", schema: nil, cursor: cursor.encode(), hasMore: hasMore)
    }

    /// One page's raw `HKSample`s converted into analytics rows +
    /// summary documents, as produced by `buildRecordsAndDocuments`.
    private struct PageResult {
        let records: [[String: JSONValue]]
        let documents: [DocumentInput]
        let normalizedSamples: [NormalizedSample]
    }

    /// Converts one page's raw `HKSample`s into analytics rows +
    /// summary documents. For the episodic, nameable tables
    /// (workouts + mindful + mood) we also mint a searchable summary
    /// `DocumentInput` per sample, bound 1:1 to its analytics row via
    /// `externalId == row.id` + the table's `boundDocument` spec. The 6
    /// tall sample tables get no document. The normalized samples are
    /// also returned so the sleep-specific night rebuild (see
    /// `rebuildTouchedSleepNights`) doesn't have to re-extract them.
    private func buildRecordsAndDocuments(from samples: [HKSample], entry: TypeEntry) -> PageResult {
        var records: [[String: JSONValue]] = []
        var documents: [DocumentInput] = []
        var normalizedSamples: [NormalizedSample] = []
        records.reserveCapacity(samples.count)
        normalizedSamples.reserveCapacity(samples.count)
        let emitsDocuments: Bool = [.workouts, .mindful, .mood].contains(entry.category)

        for sample in samples {
            guard let normalised = HKSampleExtractor.extract(sample, entry: entry) else { continue }
            records.append(HealthRecordBuilder.record(from: normalised, accountId: Self.accountId))
            if emitsDocuments,
               let document = HealthDocumentBuilder.document(from: normalised, providerId: id, sourceId: id) {
                documents.append(document)
            }
            normalizedSamples.append(normalised)
        }
        return PageResult(records: records, documents: documents, normalizedSamples: normalizedSamples)
    }

    /// Rebuilds the night document for every distinct night this page's
    /// sleep samples started in. Each bucket is queried fresh via a
    /// plain `[noon, next noon)` range read (not the anchored/paged
    /// cursor above) and rolled up with `SleepNightBucketer.summarize`;
    /// re-uploading the same night as more historical data trickles in
    /// during backfill is expected and correct — the gateway's upsert
    /// on `externalId` supersedes rather than duplicates. No cursor
    /// state is added for this: correctness relies entirely on that
    /// idempotency, not on remembering which nights were already built.
    ///
    /// Known gap: a deleted sleep sample can't be traced back to its
    /// night (`HKDeletedObject` carries no start time), so a stale
    /// night document can persist until that night is touched again by
    /// new data.
    private func rebuildTouchedSleepNights(
        entry: TypeEntry,
        sampleType: HKSampleType,
        pageSamples: [NormalizedSample]
    ) async
        -> [DocumentInput] {
        let calendar = Calendar.current
        let buckets = Set(pageSamples.compactMap { sample in
            Self.parseSampleStart(sample.startTime).map {
                SleepNightBucketer.nightBucket(forStart: $0, calendar: calendar)
            }
        })

        var documents: [DocumentInput] = []
        for bucket in buckets {
            // One bad bucket (e.g. a transient HK query failure) must
            // not sink the rest of this page's analytics rows — the
            // next sync that touches this night retries the rebuild.
            do {
                guard let window = SleepNightBucketer.window(forBucket: bucket, calendar: calendar) else { continue }
                let rawSamples = try await reader.samples(
                    type: sampleType,
                    window: HealthSampleWindow(start: window.start, end: window.end)
                )
                let nightSamples = rawSamples.compactMap { HKSampleExtractor.extract($0, entry: entry) }
                guard let summary = SleepNightBucketer.summarize(bucketDate: bucket, samples: nightSamples) else {
                    continue
                }
                documents.append(
                    HealthDocumentBuilder.sleepNightDocument(from: summary, providerId: id, sourceId: id)
                )
            } catch {
                continue
            }
        }
        return documents
    }

    private static let sampleStartFormatter: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    private static func parseSampleStart(_ value: String) -> Date? {
        sampleStartFormatter.date(from: value)
    }
}
#endif
