// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// A contiguous, closed run of the same `MotionActivityType`.
public struct ActivitySegment: Equatable, Sendable {
    public let type: MotionActivityType
    public let start: Date
    public let end: Date
    public let durationSeconds: TimeInterval
    public let confidence: MotionActivityConfidence

    public init(type: MotionActivityType, start: Date, end: Date, confidence: MotionActivityConfidence) {
        self.type = type
        self.start = start
        self.end = end
        self.durationSeconds = end.timeIntervalSince(start)
        self.confidence = confidence
    }
}

/// Result of one `ActivitySegmentMerger.merge` call.
public struct MergeOutcome: Equatable, Sendable {
    /// Fully-bounded runs — safe to emit as analytics rows / fold into
    /// a document.
    public let closedSegments: [ActivitySegment]

    /// Start of the still-open trailing run, if any. Held back rather
    /// than finalized: a later sync's newer sample is what confirms
    /// this run's actual end (or reveals it continues further).
    public let openTailStart: Date?

    public init(closedSegments: [ActivitySegment], openTailStart: Date?) {
        self.closedSegments = closedSegments
        self.openTailStart = openTailStart
    }
}

/// Turns a flat, chronological list of `MotionActivitySample`s into
/// merged `ActivitySegment`s. Pure — no CoreMotion import — so it's
/// testable on macOS like `HealthRecordBuilder` / `SleepNightBucketer`.
public enum ActivitySegmentMerger {
    /// Samples below this confidence are dropped before merging — a
    /// `.low`-confidence blip shouldn't seed or split a segment.
    public static let minimumConfidence: MotionActivityConfidence = .medium

    /// A merged run shorter than this is dropped as noise — e.g. a
    /// single sample briefly reclassified to a different type and back
    /// mints its own short-lived run, which this floor discards without
    /// re-stitching the runs on either side of it back together.
    public static let minimumSegmentSeconds: TimeInterval = 60

    /// Merges consecutive same-type samples into segments. The last
    /// run is always held back as `openTailStart` rather than closed —
    /// `CMMotionActivity` has no explicit end time, so the trailing
    /// run's "end" is only ever `now`, which the next sync may revise.
    public static func merge(samples: [MotionActivitySample], now: Date) -> MergeOutcome {
        let filtered = samples
            .filter { $0.confidence >= minimumConfidence }
            .sorted { $0.startDate < $1.startDate }
        guard !filtered.isEmpty else {
            return MergeOutcome(closedSegments: [], openTailStart: nil)
        }

        let runs = mergedRuns(filtered, now: now)
        guard let tail = runs.last else {
            return MergeOutcome(closedSegments: [], openTailStart: nil)
        }

        let closed = runs
            .dropLast()
            .filter { $0.end.timeIntervalSince($0.start) >= minimumSegmentSeconds }
            .map { ActivitySegment(type: $0.type, start: $0.start, end: $0.end, confidence: $0.confidence) }

        // `mergedRuns` only coalesces STRICTLY ADJACENT same-type samples,
        // so a brief different-type blip sitting between two same-type
        // stretches — even one too short to survive the floor above —
        // splits what's really one continuous period into separate runs.
        // Observed on-device with `CMMotionActivityManager`'s own wide
        // historical query: several runs came back reporting the exact
        // same (type, start, end), which this coalesce folds back into one
        // rather than emitting as distinct closed segments.
        return MergeOutcome(closedSegments: coalesceOverlapping(closed), openTailStart: tail.start)
    }

    /// Merges same-type segments that overlap, touch, or sit within
    /// `minimumSegmentSeconds` of each other into one, preserving
    /// disjoint segments (including other same-type segments elsewhere
    /// in the day) untouched. The gap tolerance matters as much as the
    /// overlap case: two runs of the same type from a single `merge()`
    /// call are, by construction, exactly adjacent (`mergedRuns` gives
    /// consecutive runs no gap and no overlap) — so a same-type run
    /// interrupted by a *different*-type blip too short to clear that
    /// floor doesn't overlap its neighbor, it sits a floor's-width away
    /// from it. Run independently per type so segments of different
    /// types never merge into each other.
    static func coalesceOverlapping(_ segments: [ActivitySegment]) -> [ActivitySegment] {
        var result: [ActivitySegment] = []
        for (type, group) in Dictionary(grouping: segments, by: { $0.type }) {
            let sorted = group.sorted { $0.start < $1.start }
            var merged: [ActivitySegment] = []
            for segment in sorted {
                if let last = merged.last, segment.start <= last.end.addingTimeInterval(minimumSegmentSeconds) {
                    merged[merged.count - 1] = ActivitySegment(
                        type: type,
                        start: min(last.start, segment.start),
                        end: max(last.end, segment.end),
                        confidence: min(last.confidence, segment.confidence)
                    )
                } else {
                    merged.append(segment)
                }
            }
            result.append(contentsOf: merged)
        }
        return result.sorted { $0.start < $1.start }
    }

    /// Splits (clips) a set of already-closed segments by calendar day
    /// in `calendar`, so a segment spanning midnight contributes a
    /// separate, boundary-clipped piece to each day it touches. Feeds
    /// the "one document per day" aggregation in
    /// `ActivitySegmentDocumentBuilder`.
    public static func splitByDay(
        _ segments: [ActivitySegment],
        calendar: Calendar
    )
        -> [(day: Date, segments: [ActivitySegment])] {
        var byDay: [Date: [ActivitySegment]] = [:]
        for segment in segments {
            var cursor = segment.start
            while cursor < segment.end {
                let dayStart = calendar.startOfDay(for: cursor)
                let nextDayStart = calendar.date(byAdding: .day, value: 1, to: dayStart) ?? segment.end
                let pieceEnd = min(segment.end, nextDayStart)
                guard pieceEnd > cursor else { break }
                let piece = ActivitySegment(type: segment.type, start: cursor, end: pieceEnd, confidence: segment.confidence)
                byDay[dayStart, default: []].append(piece)
                cursor = pieceEnd
            }
        }
        return byDay.sorted { $0.key < $1.key }.map { (day: $0.key, segments: $0.value) }
    }

    // MARK: - Internals

    private struct Run {
        var type: MotionActivityType
        var start: Date
        var end: Date
        var confidence: MotionActivityConfidence
    }

    /// Pairs each sample's implicit end (the next sample's start, or
    /// `now` for the last one) with it, then merges consecutive
    /// same-type intervals. A run's confidence is the lowest confidence
    /// among the samples that formed it — conservative, since one
    /// weaker sample makes the whole span less certain.
    private static func mergedRuns(_ samples: [MotionActivitySample], now: Date) -> [Run] {
        var runs: [Run] = []
        for (index, sample) in samples.enumerated() {
            let end = index + 1 < samples.count ? samples[index + 1].startDate : now
            let type = sample.dominantType
            if var last = runs.last, last.type == type {
                last.end = end
                last.confidence = min(last.confidence, sample.confidence)
                runs[runs.count - 1] = last
            } else {
                runs.append(Run(type: type, start: sample.startDate, end: end, confidence: sample.confidence))
            }
        }
        return runs
    }
}

/// Carries closed segments across syncs so a day's document can always be
/// rebuilt from that day's FULL history, not just whatever the current
/// sync's `queryActivity` window still contains. Pure — no CoreMotion
/// import — so, unlike `ActivitySegmentsSource` itself (`os(iOS)`-gated),
/// this is testable on macOS.
///
/// Why this is needed at all: `ActivitySegmentsCursor.lastConfirmedStart`
/// advances to the start of the most recently closed segment each sync, so
/// that segment's own predecessors fall out of every future
/// `queryActivity` window. Without an independent record, a later sync
/// rebuilding a day's document from only its own newly-closed segments
/// would silently drop everything an earlier sync had already recorded
/// for that day — the same problem Android's `ActivitySegmentsHistoryStore`
/// solves with a local SQLite table.
public enum ActivitySegmentAccumulator {
    /// Result of one `apply` call.
    public struct Outcome: Equatable {
        /// Every segment to build this sync's document(s) from —
        /// `pending` merged with `newlyClosed`, excluding days finalized
        /// by a previous sync but before this sync's pending-state pruning.
        public let forDocuments: [ActivitySegment]

        /// The new cursor watermark: the latest newly-closed segment's
        /// start, never earlier than the previous watermark.
        public let newWatermark: Date?

        /// The accumulator to carry into the next sync — `forDocuments`
        /// clipped to `newWatermark`'s day and later. Earlier days are
        /// finalized by this sync and must not be rebuilt from partial
        /// history in a later sync.
        public let newPending: [ActivitySegment]
    }

    /// Merges `newlyClosed` into `pending`, folding a re-derived segment
    /// into any existing entry of the same type it overlaps or touches
    /// (rather than appending a second copy) — matched by interval
    /// overlap, not exact start equality, because `CMMotionActivityManager`
    /// can revise a recent classification's exact boundary by a few
    /// seconds between reads even though it's the same real-world period.
    /// A start-equality match would miss that jitter and accumulate an
    /// unbounded run of near-duplicate segments for any long-running
    /// activity (observed on-device: a single continuous stationary
    /// stretch produced the same displayed segment seven times over).
    public static func apply(
        newlyClosed: [ActivitySegment],
        pending: [ActivitySegment],
        previousWatermark: Date?,
        calendar: Calendar
    )
        -> Outcome {
        // Native queries can re-derive an overnight interval with its
        // original start, or revise a midnight boundary slightly backwards.
        // Never rebuild finalized days from these partial rereads. This
        // clips only the document projection, not the original analytics.
        let documentSegments = clipped(
            pending + newlyClosed,
            from: previousWatermark.map { calendar.startOfDay(for: $0) }
        )
        let forDocuments = ActivitySegmentMerger.coalesceOverlapping(documentSegments)
        let newWatermark = (newlyClosed.map(\.start) + [previousWatermark].compactMap { $0 }).max()

        let pruned = clipped(forDocuments, from: newWatermark.map { calendar.startOfDay(for: $0) })

        return Outcome(forDocuments: forDocuments, newWatermark: newWatermark, newPending: pruned)
    }

    /// Retain the current-day part of overnight intervals, while excluding
    /// partial previous days from subsequent document builds.
    private static func clipped(_ segments: [ActivitySegment], from dayStart: Date?) -> [ActivitySegment] {
        guard let dayStart else { return segments }
        return segments.compactMap { segment in
            guard segment.end > dayStart else { return nil }
            guard segment.start < dayStart else { return segment }
            return ActivitySegment(
                type: segment.type,
                start: dayStart,
                end: segment.end,
                confidence: segment.confidence
            )
        }
    }
}
