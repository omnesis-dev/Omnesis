// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if canImport(HealthKit)
import Foundation
import HealthKit
@testable import Omnesis

/// An in-memory stand-in for HealthKit's store, with the anchored-query
/// semantics `AppleHealthSource` relies on: every saved or deleted object
/// takes the next position in one insertion sequence, an anchor is a
/// position, and a read returns matching objects after its anchor in that
/// order. Samples are invented.
final class FakeHealthStore: HealthSampleReading, @unchecked Sendable {
    private struct Stored {
        let sequence: Int
        let sample: HKSample
    }

    private struct Deletion {
        let sequence: Int
        let typeIdentifier: String
        let uuid: String
        let startDate: Date
    }

    private let lock = NSLock()
    private var sequence = 0
    private var stored: [Stored] = []
    private var deletions: [Deletion] = []
    private(set) var anchoredReads = 0
    var protectedDataAvailable = true
    /// Called on every anchored read, before it is answered — tests advance
    /// a fake clock here to make reads cost time.
    var onRead: (@Sendable () -> Void)?

    static let heartRate = "HKQuantityTypeIdentifierHeartRate"
    static let stepCount = "HKQuantityTypeIdentifierStepCount"

    /// Save one invented quantity sample that starts at `start`.
    @discardableResult
    func add(_ identifier: String, start: Date, value: Double = 1) -> HKSample {
        let type = HKQuantityType(HKQuantityTypeIdentifier(rawValue: identifier))
        let unit: HKUnit = identifier == Self.heartRate ? .count().unitDivided(by: .minute()) : .count()
        let sample = HKQuantitySample(
            type: type,
            quantity: HKQuantity(unit: unit, doubleValue: value),
            start: start,
            end: start.addingTimeInterval(60)
        )
        lock.withLock {
            sequence += 1
            stored.append(Stored(sequence: sequence, sample: sample))
        }
        return sample
    }

    /// Delete a saved sample, leaving a tombstone in the sequence.
    func delete(_ sample: HKSample) {
        lock.withLock {
            stored.removeAll { $0.sample.uuid == sample.uuid }
            sequence += 1
            deletions.append(Deletion(
                sequence: sequence,
                typeIdentifier: sample.sampleType.identifier,
                uuid: sample.uuid.uuidString,
                startDate: sample.startDate
            ))
        }
    }

    func storedSample(uuid: String) -> HKSample? {
        lock.withLock { stored.first { $0.sample.uuid.uuidString == uuid }?.sample }
    }

    /// UUIDs of the samples saved at or before `position`.
    func uuids(throughSequence position: Int) -> Set<String> {
        lock.withLock { Set(stored.filter { $0.sequence <= position }.map(\.sample.uuid.uuidString)) }
    }

    func isProtectedDataAvailable() async -> Bool {
        protectedDataAvailable
    }

    func anchoredPage(
        type: HKSampleType,
        window: HealthSampleWindow,
        anchor: String?,
        limit: Int
    ) async throws
        -> HealthAnchoredPage {
        onRead?()
        return lock.withLock {
            anchoredReads += 1
            let after = anchor.flatMap { Int($0.dropFirst("seq:".count)) } ?? 0
            // Samples and tombstones share one sequence and, as in HealthKit,
            // both count toward the limit.
            let samples = stored
                .filter { $0.sequence > after && $0.sample.sampleType == type && window.contains($0.sample.startDate) }
                .map { (sequence: $0.sequence, sample: Optional($0.sample), deleted: String?.none) }
            let removed = deletions
                .filter { $0.sequence > after && $0.typeIdentifier == type.identifier && window.contains($0.startDate) }
                .map { (sequence: $0.sequence, sample: HKSample?.none, deleted: Optional($0.uuid)) }
            let page = (samples + removed).sorted { $0.sequence < $1.sequence }.prefix(limit)
            // A full page stops at its last object; a short one has seen
            // everything up to the end of the sequence.
            let reached = page.count == limit ? page.last?.sequence ?? after : sequence
            return HealthAnchoredPage(
                samples: page.compactMap(\.sample),
                deletedIds: page.compactMap(\.deleted),
                anchor: "seq:\(reached)"
            )
        }
    }

    func samples(type: HKSampleType, window: HealthSampleWindow) async throws -> [HKSample] {
        lock.withLock {
            stored.filter { $0.sample.sampleType == type && window.contains($0.sample.startDate) }.map(\.sample)
        }
    }
}

extension TypeCatalog {
    /// Catalog entries for the fake store's types, in this order.
    static func entries(_ identifiers: [String]) -> [TypeEntry] {
        identifiers.compactMap { id in v1.first { $0.identifier == id } }
    }
}
#endif
