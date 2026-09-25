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
#if canImport(UIKit)
import UIKit
#endif

/// `OmnesisSource` implementation for Apple Health.
///
/// One `sync(cursor:)` call advances by one `TypeEntry`: it runs an
/// anchored query for that type, emits a `SyncResult` with up to
/// `pageLimit` records, and returns `hasMore = true` until all types
/// in the catalog have been drained. When the full cycle completes,
/// `hasMore = false`; the next sync (triggered by an HKObserverQuery
/// or BG refresh) wraps back to cycle 0.
///
/// Why rotate types this way (instead of all-in-one mega-sync):
///   - Keeps each sync() call short enough to finish inside one
///     `HKObserverQuery` background callback (~30 s budget).
///   - Each batch → `/analytics/ingest` POST is a single DuckDB
///     table's worth of rows (matches gateway API shape).
///   - Progress is persisted per-page so a crash mid-cycle only loses
///     the in-flight type's current page, not the whole cycle.
@available(iOS 17.0, *)
public struct AppleHealthSource: OmnesisSource {
    public let id: String
    public let displayName: String
    public let analyticsSchemas: [AnalyticsTableSchema]
    public let multiDeviceMode: SourceMultiDeviceMode = .replicated

    /// Hardcoded suffix in the source id (`apple-health:local`) and
    /// in the per-record `account_id` analytics column.
    private static let accountId = "local"

    private let client: HealthKitClient
    private let catalog: [TypeEntry]
    private let pageLimit: Int

    public init(
        client: HealthKitClient = HealthKitClient(),
        catalog: [TypeEntry] = TypeCatalog.v1,
        pageLimit: Int = 500
    ) {
        self.id = "apple-health:\(Self.accountId)"
        self.displayName = "Apple Health"
        self.analyticsSchemas = HealthSchemas.all
        self.client = client
        self.catalog = catalog
        self.pageLimit = pageLimit
    }

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
        #if canImport(UIKit)
        let protectedAvailable = await MainActor.run { UIApplication.shared.isProtectedDataAvailable }
        if !protectedAvailable {
            return SyncResult(
                records: [], tableName: "health_body",
                schema: nil, cursor: typed.encode(), hasMore: false
            )
        }
        #endif

        let index = typed.cycleIndex % max(catalog.count, 1)
        guard index < catalog.count else {
            // Empty catalog — shouldn't happen in practice.
            return SyncResult(
                records: [], tableName: "health_body",
                schema: nil, cursor: typed.encode(), hasMore: false
            )
        }
        let entry = catalog[index]

        guard let sampleType = entry.sampleType else {
            // Skip unknown identifier.
            typed.cycleIndex = index + 1
            return SyncResult(
                records: [], tableName: entry.category.tableName,
                schema: HealthSchemas.schema(for: entry.category),
                cursor: typed.encode(),
                hasMore: typed.cycleIndex < catalog.count
            )
        }

        let decodedAnchor: HKQueryAnchor? = if let encoded = typed.anchor(for: entry.identifier) {
            AnchorCoder.decode(encoded)
        } else {
            nil
        }

        // Second defence: even when isProtectedDataAvailable was true at
        // the top, a race is possible (user locks mid-query). Catch the
        // specific HK "protected data inaccessible" error and bail out
        // gracefully — same semantics as the gate above.
        let queryResult: (samples: [HKSample], deletions: [HKDeletedObject], newAnchor: HKQueryAnchor?)
        do {
            queryResult = try await client.runAnchoredQuery(
                type: sampleType,
                anchor: decodedAnchor,
                limit: pageLimit
            )
        } catch let err as NSError where err.domain == HKErrorDomain && err.code == HKError.errorDatabaseInaccessible.rawValue {
            return SyncResult(
                records: [], tableName: entry.category.tableName,
                schema: HealthSchemas.schema(for: entry.category),
                cursor: typed.encode(), hasMore: false
            )
        }
        let samples = queryResult.samples
        let deletions = queryResult.deletions
        let newAnchor = queryResult.newAnchor

        let page = buildRecordsAndDocuments(from: samples, entry: entry)
        var documents = page.documents

        // Rebuild the full per-night document for every night this
        // page's sleep samples touched (see `SleepNightBucketer`). This
        // sits alongside the unchanged per-stage analytics rows above —
        // `health_sleep` itself gets no new columns or bound document.
        if entry.category == .sleep, !page.normalizedSamples.isEmpty {
            let nightDocuments = await rebuildTouchedSleepNights(
                entry: entry,
                sampleType: sampleType,
                pageSamples: page.normalizedSamples
            )
            documents.append(contentsOf: nightDocuments)
        }

        let deletedIds = deletions.map(\.uuid.uuidString)

        if let newAnchor, let encoded = AnchorCoder.encode(newAnchor) {
            typed.setAnchor(encoded, for: entry.identifier)
        }

        let advanced = advanceCycle(cursor: typed, index: index, sampleCount: samples.count)
        typed = advanced.cursor

        return SyncResult(
            records: page.records,
            tableName: entry.category.tableName,
            schema: HealthSchemas.schema(for: entry.category),
            cursor: typed.encode(),
            hasMore: advanced.hasMore,
            deletedIds: deletedIds,
            documents: documents
        )
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

    /// Advances the rotation cursor after one page: stays on the
    /// current type if it filled the page (more to read), otherwise
    /// moves to the next type, wrapping — and recording
    /// `lastCycleCompletedAt` — once the whole catalog has been drained.
    private func advanceCycle(
        cursor: AppleHealthCursor,
        index: Int,
        sampleCount: Int
    )
        -> (cursor: AppleHealthCursor, hasMore: Bool) {
        var typed = cursor
        let thisTypeHasMore = sampleCount >= pageLimit
        typed.cycleIndex = thisTypeHasMore ? index : index + 1

        guard typed.cycleIndex < catalog.count else {
            typed.lastCycleCompletedAt = ISO8601DateFormatter().string(from: Date())
            typed.cycleIndex = 0
            return (typed, false)
        }
        return (typed, true)
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
                let predicate = HKQuery.predicateForSamples(
                    withStart: window.start, end: window.end, options: .strictStartDate
                )
                let rawSamples = try await client.runSampleQuery(type: sampleType, predicate: predicate)
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
