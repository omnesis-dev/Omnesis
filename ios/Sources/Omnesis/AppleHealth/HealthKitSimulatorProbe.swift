// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if DEBUG && canImport(UIKit) && canImport(HealthKit)
import HealthKit
import SwiftUI

/// Debug-only check of Apple Health sync against the simulator's real
/// HealthKit store, driven by `OmnesisHealthKitUITests` (launch environment
/// `DEMO_HEALTHKIT_PROBE=1`). The unit tests stand a fake in for HealthKit;
/// this proves the parts only HealthKit can answer: that anchored queries
/// restricted to a start-date window page, resume and report deletions the
/// way the recency lanes assume, that an anchor taken without a window can
/// seed windowed lanes, and that a wake delivers recent samples first through
/// the real collector and uploader.
///
/// It writes invented samples tagged with a probe metadata key, and judges
/// only those, so it neither needs nor touches anyone's Health data.
@available(iOS 17.0, *)
enum HealthKitSimulatorProbe {
    struct Check: Codable, Equatable {
        let name: String
        let passed: Bool
        let detail: String
    }

    private static let marker = "OmnesisSimulatorProbe"
    private static let heartRate = HKQuantityType(.heartRate)
    private static let stepCount = HKQuantityType(.stepCount)
    private static let day: TimeInterval = 86400

    static func run() async -> [Check] {
        let store = HKHealthStore()
        let types: Set<HKSampleType> = [heartRate, stepCount]
        do {
            // Write the two probe types; read the whole catalog, as a phone
            // with every category enabled does.
            try await store.requestAuthorization(toShare: types, read: TypeCatalog.allObjectTypes.union(types))
            try await clean(store)
        } catch {
            return [Check(name: "authorization", passed: false, detail: String(describing: error))]
        }
        var checks: [Check] = []
        do {
            checks += try await lanesAndDeletions(store)
            try await checks.append(legacyAnchorMigration(store))
            try await checks.append(anchorAfterTombstones(store))
            try await checks.append(fullCatalogCursor())
            try await checks.append(wakeThroughCollector(store))
            try await checks.append(observerAwaitsSync(store))
        } catch {
            checks.append(Check(name: "probe", passed: false, detail: String(describing: error)))
        }
        try? await clean(store)
        return checks
    }

    // MARK: - Scenarios

    /// A fresh pairing reads recent samples first and every sample once;
    /// late arrivals in any range and deletions surface on the next pass;
    /// interrupted passes neither re-read nor skip.
    private static func lanesAndDeletions(_ store: HKHealthStore) async throws -> [Check] {
        let seeded = try await seed(store)
        let source = probeSource()
        let first = try await runPass(source, from: nil)
        let firstIds = first.ids.filter(seeded.all.contains)
        var checks = [
            Check(
                name: "recent-first",
                passed: Set(firstIds.prefix(seeded.recent.count)) == seeded.recent,
                detail: "first \(seeded.recent.count) of \(firstIds.count) probe samples"
            ),
            Check(
                name: "exactly-once",
                passed: firstIds.count == seeded.all.count && Set(firstIds) == seeded.all,
                detail: "\(firstIds.count) read, \(Set(firstIds).count) distinct, \(seeded.all.count) saved"
            ),
        ]

        let now = Date()
        let backdated = try await save(store, stepCount, at: now.addingTimeInterval(-90 * day))
        let lastWeek = try await save(store, heartRate, at: now.addingTimeInterval(-3 * day))
        let fresh = try await save(store, heartRate, at: now.addingTimeInterval(-60))
        let doomed = try unwrap(seeded.samples.first { seeded.recent.contains($0.uuid.uuidString) })
        try await store.delete(doomed)
        let second = try await runPass(source, from: first.cursor)
        let added = Set([backdated, lastWeek, fresh].map(\.uuid.uuidString))
        let secondIds = second.ids.filter { seeded.all.contains($0) || added.contains($0) }
        checks.append(Check(
            name: "late-arrivals",
            passed: Set(secondIds) == added && secondIds.count == added.count,
            detail: "\(secondIds.count) read on the next pass, expected \(added.count)"
        ))
        checks.append(Check(
            name: "deletions-in-windowed-lanes",
            passed: second.deletedIds.contains(doomed.uuid.uuidString),
            detail: "\(second.deletedIds.count) deletions reported"
        ))

        let quiet = try await runPass(source, from: second.cursor)
        checks.append(Check(
            name: "quiet-pass",
            passed: quiet.pages == 1 && quiet.ids.filter { seeded.all.contains($0) || added.contains($0) }.isEmpty,
            detail: "\(quiet.pages) page(s) for a pass with nothing new"
        ))

        var cursor: SyncCursor?
        var seen: [String] = []
        let everything = seeded.all.union(added).subtracting([doomed.uuid.uuidString])
        for _ in 0 ..< 200 {
            let pass = try await runPass(source, from: cursor, maxPages: 3)
            seen += pass.ids.filter(everything.contains)
            cursor = pass.cursor
            if Set(seen) == everything { break }
        }
        checks.append(Check(
            name: "interrupted-passes",
            passed: Set(seen) == everything && seen.count == everything.count,
            detail: "\(seen.count) read across short passes, \(everything.count) expected"
        ))
        return checks
    }

    /// A cursor from the single-anchor build, part-way through history:
    /// lanes seeded from its anchors re-read nothing it delivered and miss
    /// nothing after it.
    private static func legacyAnchorMigration(_ store: HKHealthStore) async throws -> Check {
        try await clean(store)
        let client = HealthKitClient()
        // Read to the end of the store first, so the old build's anchor
        // lands among samples rather than among earlier probes' tombstones.
        var start: [HKSampleType: HKQueryAnchor] = [:]
        for type in [heartRate, stepCount] {
            start[type] = try await client.runAnchoredQuery(type: type, anchor: nil, limit: HKObjectQueryNoLimit).newAnchor
        }
        let seeded = try await seed(store)
        var anchors: [String: JSONValue] = [:]
        var alreadyRead: Set<String> = []
        for type in [heartRate, stepCount] {
            let page = try await client.runAnchoredQuery(type: type, anchor: start[type], limit: 7)
            alreadyRead.formUnion(page.samples.map(\.uuid.uuidString))
            if let anchor = page.newAnchor.flatMap(AnchorCoder.encode) {
                anchors[type.identifier] = .string(anchor)
            }
        }
        let legacy: SyncCursor = ["cycleIndex": .int(0), "anchorsByIdentifier": .object(anchors)]
        let pass = try await runPass(probeSource(), from: legacy)
        let ids = pass.ids.filter(seeded.all.contains)
        let expected = seeded.all.subtracting(alreadyRead)
        return Check(
            name: "legacy-anchor-migration",
            passed: alreadyRead.count == 14 && Set(ids) == expected && ids.count == expected.count,
            detail: "\(alreadyRead.count) read by the old anchor, \(ids.count) after it, \(expected.count) expected"
        )
    }

    /// An anchor whose page held only tombstones still resumes in place:
    /// windowed lanes seeded from it read what a plain anchored read from it
    /// reads.
    private static func anchorAfterTombstones(_ store: HKHealthStore) async throws -> Check {
        // Two probe runs' worth of tombstones ahead of the live samples.
        try await clean(store)
        _ = try await seed(store)
        try await clean(store)
        let reseeded = try await seed(store)
        let client = HealthKitClient()
        var anchors: [String: JSONValue] = [:]
        var plain = 0
        var firstPages: [String] = []
        for type in [heartRate, stepCount] {
            let page = try await client.runAnchoredQuery(type: type, anchor: nil, limit: 3)
            firstPages.append("\(page.samples.count)s/\(page.deletions.count)d")
            let rest = try await client.runAnchoredQuery(type: type, anchor: page.newAnchor, limit: HKObjectQueryNoLimit)
            plain += rest.samples.filter { reseeded.all.contains($0.uuid.uuidString) }.count
            if let anchor = page.newAnchor.flatMap(AnchorCoder.encode) {
                anchors[type.identifier] = .string(anchor)
            }
        }
        let legacy: SyncCursor = ["cycleIndex": .int(0), "anchorsByIdentifier": .object(anchors)]
        let pass = try await runPass(probeSource(), from: legacy)
        let laned = pass.ids.filter(reseeded.all.contains).count
        return Check(
            name: "anchor-after-tombstones",
            passed: laned == plain,
            detail: "first pages \(firstPages.joined(separator: " ")); plain read after: \(plain), lanes: \(laned)"
        )
    }

    /// Every catalog type, as on a phone with every category enabled: the
    /// cursor saved after each page stays a few KB, and a pass with nothing
    /// new costs a handful of pages rather than one per lane.
    private static func fullCatalogCursor() async throws -> Check {
        let source = AppleHealthSource(client: HealthKitClient(), catalog: TypeCatalog.v1, pageLimit: 500)
        let first = try await runPass(source, from: nil)
        let quiet = try await runPass(source, from: first.cursor)
        let bytes = try JSONEncoder().encode(quiet.cursor ?? [:]).count
        let types = TypeCatalog.v1.filter { $0.sampleType != nil }.count
        return Check(
            name: "full-catalog-cursor",
            passed: bytes < 16 * 1024 && quiet.pages <= 8,
            detail: "\(types) types: cursor \(bytes) bytes; first pass \(first.pages) pages, quiet pass \(quiet.pages)"
        )
    }

    /// One bounded wake through the real collector, buffer and uploader: the
    /// last day of both types is delivered, and before any history.
    private static func wakeThroughCollector(_ store: HKHealthStore) async throws -> Check {
        try await clean(store)
        let seeded = try await seed(store)
        let session = RecordingGateway()
        let gateway = try GatewayClient(baseURL: unwrap(URL(string: "https://gateway.invalid")), token: "probe", session: session)
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("health-probe-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: directory) }
        let buffer = OfflineBuffer(directory: directory)
        let core = CollectorCore(
            gateway: gateway,
            buffer: buffer,
            cursorStore: CursorStore(gateway: gateway),
            uploader: Uploader(gateway: gateway, buffer: buffer),
            sources: [probeSource()]
        )
        let summary = await core.sync(sourceId: "apple-health:local", budget: .seconds(20))
        let delivered = session.ingestedIds.filter(seeded.all.contains)
        let queued = try await buffer.count()
        return Check(
            name: "wake-recent-first",
            passed: Set(delivered.prefix(seeded.recent.count)) == seeded.recent && queued == 0,
            detail: "\(delivered.count) delivered in ingest order, \(queued) left queued; "
                + "error: \(summary?.error ?? "none"); gateway: \(session.lastFailure ?? "no failure")"
        )
    }

    /// HealthKit's observer callback waits for the sync it triggers: the
    /// handler `installObserver` awaits runs the collector to completion.
    private static func observerAwaitsSync(_ store: HKHealthStore) async throws -> Check {
        try await clean(store)
        let client = HealthKitClient()
        let log = ObserverLog()
        let query = client.installObserver(type: heartRate) {
            await log.record("start")
            try? await Task.sleep(nanoseconds: 300_000_000)
            await log.record("end")
        }
        defer { client.stop(query) }
        // The first callback reports the query's installation; the one that
        // matters follows a save.
        try await Task.sleep(nanoseconds: 1_000_000_000)
        await log.reset()
        _ = try await save(store, heartRate, at: Date())
        for _ in 0 ..< 100 where await log.events.last != "end" {
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        let events = await log.events
        return Check(
            name: "observer-callback",
            passed: events.starts(with: ["start", "end"]),
            detail: events.joined(separator: ",")
        )
    }

    // MARK: - Helpers

    private struct Seeded {
        var samples: [HKSample] = []
        var recent: Set<String> = []
        var all: Set<String> = []
    }

    private struct Pass {
        var pages = 0
        var ids: [String] = []
        var deletedIds: [String] = []
        var cursor: SyncCursor?
    }

    private static func probeSource() -> AppleHealthSource {
        let catalog = TypeCatalog.v1.filter { [heartRate.identifier, stepCount.identifier].contains($0.identifier) }
        return AppleHealthSource(client: HealthKitClient(), catalog: catalog, pageLimit: 5)
    }

    /// Two years of history saved first, then a day of recent samples —
    /// the insertion order a phone's store has after months of use.
    private static func seed(_ store: HKHealthStore) async throws -> Seeded {
        var seeded = Seeded()
        let now = Date()
        for type in [heartRate, stepCount] {
            for index in 0 ..< 24 {
                let sample = try await save(store, type, at: now.addingTimeInterval(-Double(730 - index * 30) * day))
                seeded.samples.append(sample)
                seeded.all.insert(sample.uuid.uuidString)
            }
        }
        for type in [heartRate, stepCount] {
            for hour in 1 ... 6 {
                let sample = try await save(store, type, at: now.addingTimeInterval(-Double(hour) * 3600))
                seeded.samples.append(sample)
                seeded.recent.insert(sample.uuid.uuidString)
                seeded.all.insert(sample.uuid.uuidString)
            }
        }
        return seeded
    }

    private static func save(_ store: HKHealthStore, _ type: HKQuantityType, at start: Date) async throws -> HKSample {
        let unit: HKUnit = type == heartRate ? .count().unitDivided(by: .minute()) : .count()
        let sample = HKQuantitySample(
            type: type,
            quantity: HKQuantity(unit: unit, doubleValue: type == heartRate ? 62 : 120),
            start: start,
            end: start.addingTimeInterval(60),
            metadata: [marker: true]
        )
        try await store.save(sample)
        return sample
    }

    private static func clean(_ store: HKHealthStore) async throws {
        let predicate = HKQuery.predicateForObjects(withMetadataKey: marker)
        for type in [heartRate, stepCount] {
            _ = try await store.deleteObjects(of: type, predicate: predicate)
        }
    }

    private static func runPass(_ source: AppleHealthSource, from cursor: SyncCursor?, maxPages: Int = 500) async throws -> Pass {
        var pass = Pass()
        var current = source.beginPass(cursor: cursor)
        for _ in 0 ..< maxPages {
            let page = try await source.sync(cursor: current)
            pass.pages += 1
            pass.ids += page.records.compactMap { if case .string(let id) = $0["id"] { id } else { nil } }
            pass.deletedIds += page.deletedIds
            current = page.cursor
            if !page.hasMore { break }
        }
        pass.cursor = current
        return pass
    }

    private struct Missing: Error {}

    private static func unwrap<T>(_ value: T?) throws -> T {
        guard let value else { throw Missing() }
        return value
    }

    private actor ObserverLog {
        private(set) var events: [String] = []
        func record(_ event: String) {
            events.append(event)
        }

        func reset() {
            events.removeAll()
        }
    }

    /// Accepts every cursor write and ingest, remembering ingested row ids
    /// in arrival order.
    private final class RecordingGateway: URLSessionLike, @unchecked Sendable {
        private let lock = NSLock()
        private var ids: [String] = []
        private var failure: String?

        var ingestedIds: [String] {
            lock.withLock { ids }
        }

        var lastFailure: String? {
            lock.withLock { failure }
        }

        func data(for request: URLRequest) async throws -> (Data, URLResponse) {
            let url = request.url ?? URL(fileURLWithPath: "/")
            var status = 200
            var body = "{\"ok\":true}"
            if url.path.hasPrefix("/sync-state/"), request.httpMethod == "GET" {
                status = 404
                body = ""
            } else if url.path.hasSuffix("/lease") {
                body = "{\"granted\":true}"
            } else if url.path == "/analytics/ingest" {
                do {
                    let json = try JSONSerialization.jsonObject(with: request.httpBody ?? Data()) as? [String: Any]
                    let rows = (json?["records"] as? [[String: Any]] ?? []).compactMap { $0["id"] as? String }
                    lock.withLock { ids += rows }
                    body = "{\"ingested\":\(rows.count),\"deleted\":0}"
                } catch {
                    lock.withLock { failure = "ingest body: \(error)" }
                    throw error
                }
            }
            let response = HTTPURLResponse(
                url: url,
                statusCode: status,
                httpVersion: "HTTP/1.1",
                headerFields: ["Content-Type": "application/json"]
            )
            return (Data(body.utf8), response ?? URLResponse())
        }
    }
}

/// The probe's screen: one line the UI test reads, `PASS` or `FAIL` followed
/// by every check.
@available(iOS 17.0, *)
struct HealthKitProbeRoot: View {
    @State private var report = "RUNNING"

    var body: some View {
        ScrollView {
            Text(report)
                .font(.footnote.monospaced())
                .accessibilityIdentifier("healthkit-probe-result")
                .padding()
        }
        .task {
            let checks = await HealthKitSimulatorProbe.run()
            let verdict = !checks.isEmpty && checks.allSatisfy(\.passed) ? "PASS" : "FAIL"
            let lines = checks.map { "\($0.passed ? "ok" : "FAILED") \($0.name): \($0.detail)" }
            report = ([verdict] + lines).joined(separator: "\n")
        }
    }
}
#endif
