// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// Mirrors `CMMotionActivityConfidence`. `Comparable` so a merge floor
/// can be expressed as `sample.confidence >= .medium`.
public enum MotionActivityConfidence: Int, Sendable, Comparable {
    case low = 0
    case medium = 1
    case high = 2

    public static func < (lhs: Self, rhs: Self) -> Bool {
        lhs.rawValue < rhs.rawValue
    }

    /// Short machine slug for the analytics column.
    public var slug: String {
        switch self {
        case .low: "low"
        case .medium: "medium"
        case .high: "high"
        }
    }
}

/// The single dominant activity `MotionActivitySample.dominantType`
/// resolves CoreMotion's independent type flags to.
public enum MotionActivityType: String, Sendable, CaseIterable {
    case stationary
    case walking
    case running
    case automotive
    case cycling
    case unknown
}

/// Platform-neutral mirror of one `CMMotionActivity` callback — a
/// plain struct rather than `CMMotionActivity` itself, so
/// `ActivitySegmentMerger` is testable without CoreMotion. `CMMotionActivity`
/// has no explicit end time; the "end" of sample *i* is implicitly the
/// start of sample *i+1* (or `now` for the last one) — the merger, not
/// this struct, encodes that rule.
public struct MotionActivitySample: Equatable, Sendable {
    public let startDate: Date
    public let unknown: Bool
    public let stationary: Bool
    public let walking: Bool
    public let running: Bool
    public let automotive: Bool
    public let cycling: Bool
    public let confidence: MotionActivityConfidence

    public init(
        startDate: Date,
        unknown: Bool = false,
        stationary: Bool = false,
        walking: Bool = false,
        running: Bool = false,
        automotive: Bool = false,
        cycling: Bool = false,
        confidence: MotionActivityConfidence
    ) {
        self.startDate = startDate
        self.unknown = unknown
        self.stationary = stationary
        self.walking = walking
        self.running = running
        self.automotive = automotive
        self.cycling = cycling
        self.confidence = confidence
    }

    /// CoreMotion's type flags aren't mutually exclusive (e.g. a train
    /// passenger can read `walking = true, automotive = true` at once)
    /// — collapse to the single most-specific signal. `automotive` is
    /// checked first because a moving vehicle is the flag most likely
    /// to co-occur with a spurious `walking`/`stationary` reading;
    /// `cycling`/`running` rarely trip alongside anything else;
    /// `stationary` is the catch-all fallback.
    public var dominantType: MotionActivityType {
        if unknown { return .unknown }
        if automotive { return .automotive }
        if cycling { return .cycling }
        if running { return .running }
        if walking { return .walking }
        if stationary { return .stationary }
        return .unknown
    }
}

/// Seam over `CMMotionActivityManager` so `ActivitySegmentsSource` is
/// testable without CoreMotion (which isn't available on macOS at all,
/// unlike HealthKit — see `CoreMotionActivityProvider`, gated to
/// `os(iOS)` below).
public protocol MotionActivityProviding: Sendable {
    func queryActivity(from: Date, to: Date) async throws -> [MotionActivitySample]
}

/// In-memory fake for tests — mirrors `DictionaryDefaults` in
/// `HealthSettings.swift`.
public final class FakeMotionActivityProvider: MotionActivityProviding, @unchecked Sendable {
    public var samples: [MotionActivitySample]
    /// Recorded so tests can assert the exact range `ActivitySegmentsSource`
    /// queried.
    public private(set) var lastRequestedRange: (from: Date, to: Date)?
    public var errorToThrow: Error?

    public init(samples: [MotionActivitySample] = []) {
        self.samples = samples
    }

    public func queryActivity(from: Date, to: Date) async throws -> [MotionActivitySample] {
        lastRequestedRange = (from, to)
        if let errorToThrow {
            throw errorToThrow
        }
        return samples.filter { $0.startDate >= from && $0.startDate < to }
    }
}

#if canImport(CoreMotion) && os(iOS)
import CoreMotion

/// Real `MotionActivityProviding` backed by `CMMotionActivityManager`.
/// `CMMotionActivityManager` (unlike `HKHealthStore`) is explicitly
/// `API_UNAVAILABLE(macos)`, so this whole type — not just individual
/// calls — is compiled out on macOS; the `swift test` logic lane never
/// sees it.
@available(iOS 17.0, *)
public final class CoreMotionActivityProvider: MotionActivityProviding, @unchecked Sendable {
    private let manager: CMMotionActivityManager

    /// Whether this device has the motion coprocessor CoreMotion's
    /// activity classification needs.
    public static var isAvailable: Bool {
        CMMotionActivityManager.isActivityAvailable()
    }

    /// Current Motion & Fitness permission. There is no explicit
    /// "request" call for Core Motion — the system prompt fires
    /// automatically the first time `queryActivity` actually runs.
    public static func authorizationStatus() -> CMAuthorizationStatus {
        CMMotionActivityManager.authorizationStatus()
    }

    public init(manager: CMMotionActivityManager = CMMotionActivityManager()) {
        self.manager = manager
    }

    public func queryActivity(from: Date, to: Date) async throws -> [MotionActivitySample] {
        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<[MotionActivitySample], Error>) in
            manager.queryActivityStarting(from: from, to: to, to: .main) { activities, error in
                if let error {
                    cont.resume(throwing: error)
                    return
                }
                cont.resume(returning: (activities ?? []).map(Self.convert))
            }
        }
    }

    private static func convert(_ activity: CMMotionActivity) -> MotionActivitySample {
        MotionActivitySample(
            startDate: activity.startDate,
            unknown: activity.unknown,
            stationary: activity.stationary,
            walking: activity.walking,
            running: activity.running,
            automotive: activity.automotive,
            cycling: activity.cycling,
            confidence: MotionActivityConfidence(rawValue: activity.confidence.rawValue) ?? .low
        )
    }
}
#endif
