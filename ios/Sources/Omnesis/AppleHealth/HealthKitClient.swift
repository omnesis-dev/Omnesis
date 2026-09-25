// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
#if canImport(HealthKit)
import HealthKit

/// Async wrapper around `HKHealthStore`. Callback-based HealthKit APIs
/// are wrapped in `withCheckedThrowingContinuation` so the rest of the
/// codebase can `await` them.
///
/// Exists only on iOS (HealthKit isn't available on macOS). The
/// `AppleHealthSource` that uses this is itself under
/// `#if canImport(HealthKit)`, so macOS tests don't see it.
@available(iOS 17.0, *)
public final class HealthKitClient: Sendable {
    private let store: HKHealthStore

    /// Indicates whether HealthKit is usable on the current device.
    /// Typical failure mode: iPhone Simulator before iOS 17, iPad
    /// without HealthKit, jailbroken devices with tweaked HealthKit.
    public static var isAvailable: Bool {
        HKHealthStore.isHealthDataAvailable()
    }

    public init() {
        self.store = HKHealthStore()
    }

    /// Whether asking for read access to `types` would show the Health sheet.
    public func shouldRequestAuthorization(for types: Set<HKObjectType>) async -> Bool {
        await (try? store.statusForAuthorizationRequest(toShare: [], read: types)) == .shouldRequest
    }

    /// Request combined read authorization for every type in the
    /// catalog. Apple presents a single system prompt where the user
    /// grants / denies each type individually.
    public func requestAuthorization(for types: Set<HKObjectType>) async throws {
        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
            store.requestAuthorization(toShare: nil, read: types) { _, error in
                if let error {
                    cont.resume(throwing: error)
                } else {
                    cont.resume()
                }
            }
        }
    }

    /// Paged read of samples + deletions for `type` since `anchor`.
    /// Returns up to `limit` additions. When `samples.count < limit`
    /// and the buffer is empty, the anchor represents "caught up."
    public func runAnchoredQuery(
        type: HKSampleType,
        anchor: HKQueryAnchor?,
        limit: Int = 1000
    ) async throws
        -> (samples: [HKSample], deletions: [HKDeletedObject], newAnchor: HKQueryAnchor?) {
        try await withCheckedThrowingContinuation {
            (cont: CheckedContinuation<(samples: [HKSample], deletions: [HKDeletedObject], newAnchor: HKQueryAnchor?), Error>) in
            let query = HKAnchoredObjectQuery(
                type: type,
                predicate: nil,
                anchor: anchor,
                limit: limit
            ) { _, samples, deletions, newAnchor, error in
                if let error {
                    cont.resume(throwing: error)
                } else {
                    cont.resume(returning: (samples ?? [], deletions ?? [], newAnchor))
                }
            }
            store.execute(query)
        }
    }

    /// Plain range read over `type` matching `predicate` — unlike
    /// `runAnchoredQuery`, this is not paged/anchored: it returns every
    /// matching sample in one shot (bounded by whatever range the
    /// predicate expresses), in `sortDescriptors` order (HealthKit's own
    /// order when nil). Used to rebuild a night's full sleep-stage
    /// picture from a `[noon, noon)` window predicate, independent of
    /// the anchored cursor driving the per-type sync rotation, and by the
    /// developer sample probe for the most recent samples of a type.
    public func runSampleQuery(
        type: HKSampleType,
        predicate: NSPredicate?,
        limit: Int = HKObjectQueryNoLimit,
        sortDescriptors: [NSSortDescriptor]? = nil
    ) async throws
        -> [HKSample] {
        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<[HKSample], Error>) in
            let query = HKSampleQuery(
                sampleType: type,
                predicate: predicate,
                limit: limit,
                sortDescriptors: sortDescriptors
            ) { _, samples, error in
                if let error {
                    cont.resume(throwing: error)
                } else {
                    cont.resume(returning: samples ?? [])
                }
            }
            store.execute(query)
        }
    }

    /// Install an observer query for this type. The supplied handler
    /// runs each time HealthKit reports new data, including while the
    /// app is in the background after `enableBackgroundDelivery` is on.
    ///
    /// Returns the query so the caller can `stop()` it on unpair.
    @discardableResult
    public func installObserver(
        type: HKSampleType,
        handler: @escaping @Sendable () async -> Void
    )
        -> HKObserverQuery {
        let query = HKObserverQuery(sampleType: type, predicate: nil) { _, completion, _ in
            Task {
                await handler()
                completion()
            }
        }
        store.execute(query)
        return query
    }

    public func stop(_ query: HKQuery) {
        store.stop(query)
    }

    /// Turn on background delivery for `type`. The OS decides actual
    /// wake cadence based on the frequency hint; `.immediate` is the
    /// right default for responsive health sync.
    public func enableBackgroundDelivery(
        for type: HKObjectType,
        frequency: HKUpdateFrequency = .immediate
    ) async throws {
        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
            store.enableBackgroundDelivery(for: type, frequency: frequency) { _, error in
                if let error {
                    cont.resume(throwing: error)
                } else {
                    cont.resume()
                }
            }
        }
    }
}

/// The one HealthKit capability the developer sample probe needs beyond
/// reading samples: a request for read access.
///
/// Deliberately a single method wide. A caller holding this cannot install
/// observer queries, turn on background delivery, or reach any persisted
/// state — so a read-only diagnostic screen cannot start sync-adjacent work
/// on a device that hosts no Apple Health source.
public protocol HealthReadAuthorizing: Sendable {
    /// Ask the user for read access to `types`. Never requests share
    /// (write) access.
    func requestAuthorization(for types: Set<HKObjectType>) async throws
    /// Whether asking for read access to `types` would show the Health sheet.
    func shouldRequestAuthorization(for types: Set<HKObjectType>) async -> Bool
}

@available(iOS 17.0, *)
extension HealthKitClient: HealthReadAuthorizing {}

// MARK: - HKQueryAnchor encoding helpers

/// Serialize / deserialize an `HKQueryAnchor` through `NSKeyedArchiver`
/// into a base64 string so it can live inside our generic `SyncCursor`
/// JSON map.
@available(iOS 17.0, *)
public enum AnchorCoder {
    public static func encode(_ anchor: HKQueryAnchor) -> String? {
        guard let data = try? NSKeyedArchiver.archivedData(
            withRootObject: anchor, requiringSecureCoding: true
        ) else { return nil }
        return data.base64EncodedString()
    }

    public static func decode(_ encoded: String) -> HKQueryAnchor? {
        guard let data = Data(base64Encoded: encoded) else { return nil }
        return try? NSKeyedUnarchiver.unarchivedObject(
            ofClass: HKQueryAnchor.self, from: data
        )
    }
}
#endif
