// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
#if canImport(HealthKit)
import HealthKit
#endif

/// Developer probe over HealthKit: the most recent samples of every catalog
/// type, identified the way the sync pipeline identifies them
/// (`HKSample.uuid` is the `id` of the row a sample becomes). Two phones
/// sharing one Apple Health source each run the probe; comparing the reports
/// shows which samples both see and which only one does. Read-only.
public enum HealthSampleProbe {
    /// Samples read per type, newest end date first.
    public static let samplesPerType = 10

    /// The types the probe covers: the whole catalog, never a subset of it.
    ///
    /// The probe answers whether two devices are handed the same
    /// `HKSample.uuid` for the same sample, so it has to work on a device
    /// that hosts no Apple Health source and has every category toggle off.
    /// A fixed set also makes two devices' reports comparable without first
    /// matching their toggles.
    public static var catalog: [TypeEntry] {
        TypeCatalog.v1
    }

    public struct Row: Identifiable, Hashable, Sendable {
        /// `HKSample.uuid`, uppercase hyphenated.
        public let uuid: String
        /// Full HealthKit identifier, e.g. `HKQuantityTypeIdentifierHeartRate`.
        public let typeIdentifier: String
        public let endDate: Date

        public var id: String {
            uuid
        }

        public init(uuid: String, typeIdentifier: String, endDate: Date) {
            self.uuid = uuid
            self.typeIdentifier = typeIdentifier
            self.endDate = endDate
        }
    }

    public struct TypeGroup: Identifiable, Hashable, Sendable {
        public let typeIdentifier: String
        public let rows: [Row]

        public var id: String {
            typeIdentifier
        }
    }

    private static let iso8601: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    /// Exact, timezone-free rendering of a sample's end date, so two
    /// devices' reports line up character for character.
    public static func format(_ date: Date) -> String {
        iso8601.string(from: date)
    }

    /// Rows grouped by type in first-appearance order (the catalog's order
    /// when the rows came from `read`), each group newest first.
    public static func group(_ rows: [Row]) -> [TypeGroup] {
        var order: [String] = []
        var byType: [String: [Row]] = [:]
        for row in rows {
            if byType[row.typeIdentifier] == nil { order.append(row.typeIdentifier) }
            byType[row.typeIdentifier, default: []].append(row)
        }
        return order.map { type in
            TypeGroup(typeIdentifier: type, rows: byType[type, default: []].sorted { $0.endDate > $1.endDate })
        }
    }

    /// The whole probe as text for the clipboard: one header line per type,
    /// then one tab-separated `uuid<TAB>endDate` line per sample.
    public static func report(_ rows: [Row]) -> String {
        group(rows).map { group in
            ([group.typeIdentifier] + group.rows.map { "\($0.uuid)\t\(format($0.endDate))" })
                .joined(separator: "\n")
        }
        .joined(separator: "\n\n")
    }

    #if canImport(HealthKit)
    /// Ask for read access to every type in `catalog`, and nothing else.
    ///
    /// `HealthReadAuthorizing` is read-only, so this path cannot
    /// install observer queries, enable background delivery, prompt for
    /// notification permission, or record that Apple Health has been set up
    /// on this device. None of that state applies on a device running the
    /// probe as a pure diagnostic. Returns whether the request completed —
    /// which is not whether anything was granted, since Apple reports a
    /// per-type denial as an empty read rather than an error.
    @available(iOS 17.0, *)
    @discardableResult
    public static func requestReadAuthorization(_ authorizer: some HealthReadAuthorizing) async -> Bool {
        let types = Set(catalog.compactMap(\.sampleType).map { $0 as HKObjectType })
        guard !types.isEmpty else { return false }
        do {
            try await authorizer.requestAuthorization(for: types)
            return true
        } catch {
            return false
        }
    }

    /// Read the newest `samplesPerType` samples of every catalog type.
    /// A type HealthKit cannot query (unknown identifier, or a read HealthKit
    /// refuses) contributes no rows rather than failing the whole probe —
    /// Apple hides per-type denials as empty results anyway.
    @available(iOS 17.0, *)
    public static func read(client: HealthKitClient, catalog: [TypeEntry]) async -> [Row] {
        var rows: [Row] = []
        let newestFirst = [NSSortDescriptor(key: HKSampleSortIdentifierEndDate, ascending: false)]
        for entry in catalog {
            guard let type = entry.sampleType else { continue }
            let samples: [HKSample]
            do {
                samples = try await client.runSampleQuery(
                    type: type,
                    predicate: nil,
                    limit: samplesPerType,
                    sortDescriptors: newestFirst
                )
            } catch {
                continue
            }
            rows += samples.map {
                Row(uuid: $0.uuid.uuidString, typeIdentifier: entry.identifier, endDate: $0.endDate)
            }
        }
        return rows
    }
    #endif
}
