// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
#if canImport(HealthKit)
import HealthKit
#if canImport(UIKit)
import UIKit
#endif

/// One page of an anchored read.
public struct HealthAnchoredPage: Sendable {
    public let samples: [HKSample]
    /// UUIDs of samples deleted since the anchor.
    public let deletedIds: [String]
    /// Encoded anchor to resume from, nil when HealthKit returned none.
    public let anchor: String?

    public init(samples: [HKSample], deletedIds: [String], anchor: String?) {
        self.samples = samples
        self.deletedIds = deletedIds
        self.anchor = anchor
    }
}

/// The reads `AppleHealthSource` makes, kept narrow so tests can stand in
/// for HealthKit with invented samples.
public protocol HealthSampleReading: Sendable {
    /// False while the phone is locked and HealthKit's store is sealed.
    func isProtectedDataAvailable() async -> Bool

    /// Up to `limit` samples of `type` starting in `window`, inserted after
    /// `anchor`, plus deletions in the same range.
    func anchoredPage(
        type: HKSampleType,
        window: HealthSampleWindow,
        anchor: String?,
        limit: Int
    ) async throws
        -> HealthAnchoredPage

    /// Every sample of `type` starting in `window`.
    func samples(type: HKSampleType, window: HealthSampleWindow) async throws -> [HKSample]
}

@available(iOS 17.0, *)
extension HealthKitClient: HealthSampleReading {
    public func isProtectedDataAvailable() async -> Bool {
        #if canImport(UIKit)
        await MainActor.run { UIApplication.shared.isProtectedDataAvailable }
        #else
        true
        #endif
    }

    public func anchoredPage(
        type: HKSampleType,
        window: HealthSampleWindow,
        anchor: String?,
        limit: Int
    ) async throws
        -> HealthAnchoredPage {
        let result = try await runAnchoredQuery(
            type: type,
            predicate: Self.predicate(for: window),
            anchor: anchor.flatMap(AnchorCoder.decode),
            limit: limit
        )
        return HealthAnchoredPage(
            samples: result.samples,
            deletedIds: result.deletions.map(\.uuid.uuidString),
            anchor: result.newAnchor.flatMap(AnchorCoder.encode)
        )
    }

    public func samples(type: HKSampleType, window: HealthSampleWindow) async throws -> [HKSample] {
        try await runSampleQuery(type: type, predicate: Self.predicate(for: window))
    }

    /// `startDate` within `[start, end)`. Bounds on the start date alone, so
    /// adjacent windows never both claim a sample that spans their boundary.
    static func predicate(for window: HealthSampleWindow) -> NSPredicate? {
        var parts: [NSPredicate] = []
        if let start = window.start {
            parts.append(NSPredicate(format: "%K >= %@", HKPredicateKeyPathStartDate, start as NSDate))
        }
        if let end = window.end {
            parts.append(NSPredicate(format: "%K < %@", HKPredicateKeyPathStartDate, end as NSDate))
        }
        return parts.isEmpty ? nil : NSCompoundPredicate(andPredicateWithSubpredicates: parts)
    }
}
#endif
