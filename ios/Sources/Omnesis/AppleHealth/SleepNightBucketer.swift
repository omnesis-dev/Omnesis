// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// Pure helper that groups sleep-stage `NormalizedSample`s into nights
/// and rolls each night up into a `SleepNightSummary`. No HealthKit
/// import — testable on macOS like `HealthRecordBuilder` /
/// `HealthDocumentBuilder`.
///
/// A "night" is the `[noon, next noon)` window in the caller's
/// calendar, keyed by the calendar day at its start. Real sleep never
/// straddles local noon, and bucketing on noon rather than midnight
/// sidesteps DST transitions, which happen at 1-3am.
public enum SleepNightBucketer {
    /// Buckets a sample's start time into the night it belongs to:
    /// shift back 12 hours, then take the calendar day. The returned
    /// key is a stable `YYYY-MM-DD` string in `calendar`'s time zone —
    /// use it as a grouping key and pass it to `window(forBucket:)` to
    /// get back the exact `[noon, noon)` interval it stands for.
    public static func nightBucket(forStart start: Date, calendar: Calendar) -> String {
        let shifted = start.addingTimeInterval(-halfDaySeconds)
        let dayStart = calendar.startOfDay(for: shifted)
        return bucketKey(forDayStart: dayStart, calendar: calendar)
    }

    /// The exact `[noon, next noon)` interval a bucket key maps back to
    /// — the precise inverse of `nightBucket`, so a range-query
    /// predicate built from this interval can never disagree with the
    /// bucketing decision that produced the key. `nil` for a
    /// malformed key.
    public static func window(forBucket bucket: String, calendar: Calendar) -> DateInterval? {
        guard let dayStart = date(forBucketKey: bucket, calendar: calendar),
              let noon = calendar.date(byAdding: .hour, value: 12, to: dayStart),
              let nextNoon = calendar.date(byAdding: .day, value: 1, to: noon)
        else { return nil }
        return DateInterval(start: noon, end: nextNoon)
    }

    /// Rolls up one night's sleep-stage samples. Returns `nil` if the
    /// qualifying duration (total asleep time if any stage was logged,
    /// otherwise the total in-bed span) falls short of
    /// `minimumAsleepSeconds` — filters out stray naps that got bucketed
    /// into a night with no real sleep.
    public static func summarize(
        bucketDate: String,
        samples: [NormalizedSample],
        minimumAsleepSeconds: TimeInterval = 3600
    )
        -> SleepNightSummary? {
        let intervals: [StageInterval] = samples.compactMap { sample in
            guard let stage = sample.sleep?.stage,
                  let start = parseISO8601(sample.startTime),
                  let end = parseISO8601(sample.endTime)
            else { return nil }
            return StageInterval(start: start, end: end, stage: stage)
        }
        guard let inBedStart = intervals.map(\.start).min(),
              let inBedEnd = intervals.map(\.end).max()
        else { return nil }

        let core = duration(of: "asleepCore", in: intervals)
        let deep = duration(of: "asleepDeep", in: intervals)
        let rem = duration(of: "asleepREM", in: intervals)
        let unspecified = duration(of: "asleepUnspecified", in: intervals)
        let awake = duration(of: "awake", in: intervals)
        let totalAsleep = core + deep + rem + unspecified

        let qualifyingDuration = totalAsleep > 0 ? totalAsleep : inBedEnd.timeIntervalSince(inBedStart)
        guard qualifyingDuration >= minimumAsleepSeconds else { return nil }

        return SleepNightSummary(
            bucketDate: bucketDate,
            inBedStart: format(inBedStart),
            inBedEnd: format(inBedEnd),
            coreSeconds: core,
            deepSeconds: deep,
            remSeconds: rem,
            unspecifiedAsleepSeconds: unspecified,
            awakeSeconds: awake,
            totalAsleepSeconds: totalAsleep,
            awakeningsCount: awakeningsCount(in: intervals),
            isStaged: core > 0 || deep > 0 || rem > 0
        )
    }

    // MARK: - Internals

    private static let halfDaySeconds: TimeInterval = 12 * 60 * 60
    private static let asleepStages: Set<String> = ["asleepCore", "asleepDeep", "asleepREM", "asleepUnspecified"]

    private struct StageInterval {
        let start: Date
        let end: Date
        let stage: String
    }

    private static func duration(of stage: String, in intervals: [StageInterval]) -> TimeInterval {
        intervals
            .filter { $0.stage == stage }
            .reduce(0) { $0 + $1.end.timeIntervalSince($1.start) }
    }

    /// Count of `awake` intervals strictly between the first
    /// asleep-onset and the last asleep-offset — excludes the
    /// falling-asleep latency at the start of the night and the final
    /// wake at the end, neither of which is a mid-night "awakening".
    private static func awakeningsCount(in intervals: [StageInterval]) -> Int {
        let asleep = intervals.filter { asleepStages.contains($0.stage) }
        guard let firstOnset = asleep.map(\.start).min(),
              let lastOffset = asleep.map(\.end).max()
        else { return 0 }
        return intervals.count {
            $0.stage == "awake" && $0.start > firstOnset && $0.end < lastOffset
        }
    }

    private static func bucketKey(forDayStart dayStart: Date, calendar: Calendar) -> String {
        let components = calendar.dateComponents([.year, .month, .day], from: dayStart)
        return String(format: "%04d-%02d-%02d", components.year ?? 0, components.month ?? 0, components.day ?? 0)
    }

    private static func date(forBucketKey key: String, calendar: Calendar) -> Date? {
        let parts = key.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3 else { return nil }
        var components = DateComponents()
        components.year = parts[0]
        components.month = parts[1]
        components.day = parts[2]
        components.hour = 0
        components.minute = 0
        components.second = 0
        return calendar.date(from: components)
    }

    /// Tries fractional-seconds ISO 8601 first (what `HKSampleExtractor`
    /// emits), then falls back to whole-second — so this also accepts
    /// the shorter strings used in tests elsewhere in this target.
    private static func parseISO8601(_ value: String) -> Date? {
        iso8601WithFractionalSeconds.date(from: value) ?? iso8601.date(from: value)
    }

    private static func format(_ date: Date) -> String {
        iso8601WithFractionalSeconds.string(from: date)
    }

    private static let iso8601WithFractionalSeconds: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    private static let iso8601: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter
    }()
}

/// Roll-up of one night's sleep-stage samples, produced by
/// `SleepNightBucketer.summarize`. Consumed by
/// `HealthDocumentBuilder.sleepNightDocument`.
public struct SleepNightSummary: Equatable, Sendable {
    /// The `YYYY-MM-DD` bucket key this summary rolls up.
    public let bucketDate: String

    /// Earliest sample start across every stage in the night, ISO 8601.
    public let inBedStart: String

    /// Latest sample end across every stage in the night, ISO 8601.
    public let inBedEnd: String

    public let coreSeconds: TimeInterval
    public let deepSeconds: TimeInterval
    public let remSeconds: TimeInterval
    public let unspecifiedAsleepSeconds: TimeInterval
    public let awakeSeconds: TimeInterval

    /// `coreSeconds + deepSeconds + remSeconds + unspecifiedAsleepSeconds`.
    public let totalAsleepSeconds: TimeInterval

    /// Mid-night wake-ups — `awake` intervals strictly between the
    /// first asleep-onset and the last asleep-offset.
    public let awakeningsCount: Int

    /// `true` if any core/deep/REM stage was present — a staged night
    /// from a wearable, vs. a coarse in-bed/asleep-only log.
    public let isStaged: Bool

    public init(
        bucketDate: String,
        inBedStart: String,
        inBedEnd: String,
        coreSeconds: TimeInterval,
        deepSeconds: TimeInterval,
        remSeconds: TimeInterval,
        unspecifiedAsleepSeconds: TimeInterval,
        awakeSeconds: TimeInterval,
        totalAsleepSeconds: TimeInterval,
        awakeningsCount: Int,
        isStaged: Bool
    ) {
        self.bucketDate = bucketDate
        self.inBedStart = inBedStart
        self.inBedEnd = inBedEnd
        self.coreSeconds = coreSeconds
        self.deepSeconds = deepSeconds
        self.remSeconds = remSeconds
        self.unspecifiedAsleepSeconds = unspecifiedAsleepSeconds
        self.awakeSeconds = awakeSeconds
        self.totalAsleepSeconds = totalAsleepSeconds
        self.awakeningsCount = awakeningsCount
        self.isStaged = isStaged
    }
}
