// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// Pure record builder — takes a `NormalizedSample` (already extracted
/// from HKSample on iOS or constructed in tests on macOS) and returns a
/// `[String: JSONValue]` row ready to POST to the gateway's
/// `/analytics/ingest`.
///
/// No HealthKit imports — keeps this file testable on macOS without a
/// simulator.
public enum HealthRecordBuilder {
    public static func record(
        from sample: NormalizedSample,
        accountId: String
    )
        -> [String: JSONValue] {
        switch sample.category {
        case .sleep:
            sleepRecord(from: sample, accountId: accountId)
        case .mindful:
            mindfulRecord(from: sample, accountId: accountId)
        case .workouts:
            workoutRecord(from: sample, accountId: accountId)
        case .mood:
            moodRecord(from: sample, accountId: accountId)
        case .body, .activity, .vitals, .nutrition, .environment:
            rowPerSampleRecord(from: sample, accountId: accountId)
        }
    }

    // MARK: - Row shapes

    private static func rowPerSampleRecord(
        from sample: NormalizedSample,
        accountId: String
    )
        -> [String: JSONValue] {
        var row: [String: JSONValue] = [
            "id": .string(sample.id),
            "account_id": .string(accountId),
            "metric": .string(sample.metric),
            "metric_slug": .string(TypeCatalog.entry(for: sample.metric)?.metricSlug ?? sample.metric),
            "start_time": .string(sample.startTime),
            "end_time": .string(sample.endTime),
        ]
        row["value"] = sample.value.map { .double($0) } ?? .null
        row["unit"] = sample.unit.map { .string($0) } ?? .null
        row["source_app"] = sample.sourceApp.map { .string($0) } ?? .null
        row["source_device"] = sample.sourceDevice.map { .string($0) } ?? .null
        row["metadata"] = sample.metadata ?? .null
        return row
    }

    private static func sleepRecord(
        from sample: NormalizedSample,
        accountId: String
    )
        -> [String: JSONValue] {
        [
            "id": .string(sample.id),
            "account_id": .string(accountId),
            "stage": .string(sample.sleep?.stage ?? "asleepUnspecified"),
            "start_time": .string(sample.startTime),
            "end_time": .string(sample.endTime),
            "source_app": sample.sourceApp.map { .string($0) } ?? .null,
            "source_device": sample.sourceDevice.map { .string($0) } ?? .null,
            "metadata": sample.metadata ?? .null,
        ]
    }

    private static func mindfulRecord(
        from sample: NormalizedSample,
        accountId: String
    )
        -> [String: JSONValue] {
        let duration = durationSeconds(start: sample.startTime, end: sample.endTime)
        return [
            "id": .string(sample.id),
            "account_id": .string(accountId),
            "start_time": .string(sample.startTime),
            "end_time": .string(sample.endTime),
            "duration_seconds": .int(Int64(duration)),
            "source_app": sample.sourceApp.map { .string($0) } ?? .null,
            "source_device": sample.sourceDevice.map { .string($0) } ?? .null,
            "metadata": sample.metadata ?? .null,
        ]
    }

    private static func workoutRecord(
        from sample: NormalizedSample,
        accountId: String
    )
        -> [String: JSONValue] {
        let workout = sample.workout
        return [
            "id": .string(sample.id),
            "account_id": .string(accountId),
            "workout_type": .string(workout?.workoutType ?? "unknown"),
            "start_time": .string(sample.startTime),
            "end_time": .string(sample.endTime),
            "duration_seconds": .int(Int64(workout?.durationSeconds ?? 0)),
            "total_distance_m": workout?.totalDistanceMeters.map { .double($0) } ?? .null,
            "total_energy_kcal": workout?.totalEnergyKcal.map { .double($0) } ?? .null,
            "source_app": sample.sourceApp.map { .string($0) } ?? .null,
            "source_device": sample.sourceDevice.map { .string($0) } ?? .null,
            "metadata": sample.metadata ?? .null,
        ]
    }

    private static func moodRecord(
        from sample: NormalizedSample,
        accountId: String
    )
        -> [String: JSONValue] {
        let mood = sample.mood
        return [
            "id": .string(sample.id),
            "account_id": .string(accountId),
            "kind": .string(mood?.kind ?? "unknown"),
            "valence": .double(mood?.valence ?? 0),
            "labels": .array((mood?.labels ?? []).map { .string($0) }),
            "associations": .array((mood?.associations ?? []).map { .string($0) }),
            "start_time": .string(sample.startTime),
            "end_time": .string(sample.endTime),
            "source_app": sample.sourceApp.map { .string($0) } ?? .null,
        ]
    }

    // MARK: - Helpers

    private static let iso8601: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    private static func durationSeconds(start: String, end: String) -> Int {
        guard let startDate = iso8601.date(from: start),
              let endDate = iso8601.date(from: end)
        else { return 0 }
        return Int(endDate.timeIntervalSince(startDate).rounded())
    }
}

/// Mints the searchable per-session summary `DocumentInput` for the
/// episodic, nameable Health tables — workouts, mindful sessions, and
/// State of Mind logs (#640). The 6 tall sample tables (body/activity/
/// vitals/sleep/nutrition/environment) are aggregate-only and get NO
/// document.
///
/// `externalId` is the same HealthKit UUID the analytics row uses as its
/// primary key, so `health_workouts.boundDocument { externalIdColumns:
/// ["id"] }` (and `health_mindful`, `health_mood`) resolve the 1:1
/// doc↔row edge.
///
/// No HealthKit imports — testable on macOS like `HealthRecordBuilder`.
public enum HealthDocumentBuilder {
    /// Returns a `DocumentInput` for workout / mindful / mood samples,
    /// `nil` for every other category (no document minted).
    public static func document(
        from sample: NormalizedSample,
        providerId: String,
        sourceId: String
    )
        -> DocumentInput? {
        switch sample.category {
        case .workouts:
            workoutDocument(from: sample, providerId: providerId, sourceId: sourceId)
        case .mindful:
            mindfulDocument(from: sample, providerId: providerId, sourceId: sourceId)
        case .mood:
            moodDocument(from: sample, providerId: providerId, sourceId: sourceId)
        case .body, .activity, .vitals, .sleep, .nutrition, .environment:
            nil
        }
    }

    // MARK: - Workout

    private static func workoutDocument(
        from sample: NormalizedSample,
        providerId: String,
        sourceId: String
    )
        -> DocumentInput {
        let workout = sample.workout
        let typeSlug = workout?.workoutType ?? "unknown"
        let title = workoutTitle(typeSlug: typeSlug, start: sample.startTime)

        // Summary line, e.g. "Morning Run — 9.2 km, 612 kcal, 48 min".
        var stats: [String] = []
        if let meters = workout?.totalDistanceMeters, meters > 0 {
            stats.append(formatDistance(meters))
        }
        if let kcal = workout?.totalEnergyKcal, kcal > 0 {
            stats.append("\(Int(kcal.rounded())) kcal")
        }
        let durationSec = workout?.durationSeconds ?? durationSeconds(start: sample.startTime, end: sample.endTime)
        if durationSec > 0 {
            stats.append(formatDuration(seconds: durationSec))
        }

        var content = title
        if !stats.isEmpty {
            content += " — " + stats.joined(separator: ", ")
        }

        var extra: [String: JSONValue] = ["workoutType": .string(typeSlug)]
        if let meters = workout?.totalDistanceMeters {
            extra["totalDistanceMeters"] = .double(meters)
        }
        if let kcal = workout?.totalEnergyKcal {
            extra["totalEnergyKcal"] = .double(kcal)
        }
        extra["durationSeconds"] = .int(Int64(durationSec))

        let metadata = DocumentMetadata(
            documentType: "activity",
            tags: ["workout", typeSlug],
            extra: extra
        )

        return DocumentInput(
            providerId: providerId,
            sourceId: sourceId,
            externalId: sample.id,
            title: title,
            content: content,
            contentHash: DocumentInput.computeContentHash(content),
            metadata: metadata,
            sourceCreatedAt: sample.startTime,
            sourceUpdatedAt: sample.endTime
        )
    }

    // MARK: - Mindful

    private static func mindfulDocument(
        from sample: NormalizedSample,
        providerId: String,
        sourceId: String
    )
        -> DocumentInput {
        let durationSec = durationSeconds(start: sample.startTime, end: sample.endTime)
        let title = "Mindful Session — \(timeOfDay(from: sample.startTime))"
        var content = title
        if durationSec > 0 {
            content += " — " + formatDuration(seconds: durationSec)
        }

        let metadata = DocumentMetadata(
            documentType: "activity",
            tags: ["mindful"],
            extra: ["durationSeconds": .int(Int64(durationSec))]
        )

        return DocumentInput(
            providerId: providerId,
            sourceId: sourceId,
            externalId: sample.id,
            title: title,
            content: content,
            contentHash: DocumentInput.computeContentHash(content),
            metadata: metadata,
            sourceCreatedAt: sample.startTime,
            sourceUpdatedAt: sample.endTime
        )
    }

    // MARK: - Mood

    private static func moodDocument(
        from sample: NormalizedSample,
        providerId: String,
        sourceId: String
    )
        -> DocumentInput {
        let mood = sample.mood
        let labels = mood?.labels ?? []
        let associations = mood?.associations ?? []
        let valence = mood?.valence ?? 0
        let kind = mood?.kind ?? "momentaryEmotion"

        let title = moodTitle(labels: labels, kind: kind)

        var stats: [String] = [valenceDescription(valence)]
        if !associations.isEmpty {
            stats.append("associated with " + associations.map(humanizeMoodSlug).joined(separator: ", "))
        }
        let content = title + " — " + stats.joined(separator: ", ")

        var extra: [String: JSONValue] = [
            "kind": .string(kind),
            "valence": .double(valence),
        ]
        if !labels.isEmpty { extra["labels"] = .array(labels.map { .string($0) }) }
        if !associations.isEmpty { extra["associations"] = .array(associations.map { .string($0) }) }

        let metadata = DocumentMetadata(
            documentType: "activity",
            tags: ["mood"] + labels,
            extra: extra
        )

        return DocumentInput(
            providerId: providerId,
            sourceId: sourceId,
            externalId: sample.id,
            title: title,
            content: content,
            contentHash: DocumentInput.computeContentHash(content),
            metadata: metadata,
            sourceCreatedAt: sample.startTime,
            sourceUpdatedAt: sample.endTime
        )
    }

    /// "Feeling Happy, Grateful" when labels were selected; otherwise a
    /// generic title keyed on the log kind.
    private static func moodTitle(labels: [String], kind: String) -> String {
        guard !labels.isEmpty else {
            return kind == "dailyMood" ? "Daily Mood" : "Momentary Emotion"
        }
        let humanLabels = labels.map { $0.prefix(1).uppercased() + $0.dropFirst() }.joined(separator: ", ")
        return "Feeling \(humanLabels)"
    }

    /// Five-bucket pleasantness description + the raw signed value, e.g.
    /// "pleasant (valence 0.6)".
    private static func valenceDescription(_ valence: Double) -> String {
        let word = switch valence {
        case ..<(-0.6): "very unpleasant"
        case ..<(-0.2): "unpleasant"
        case -0.2 ... 0.2: "neutral"
        case ...0.6: "pleasant"
        default: "very pleasant"
        }
        return "\(word) (valence \(trimDecimal((valence * 100).rounded() / 100)))"
    }

    /// "currentEvents" → "current events", "selfCare" → "self care".
    private static func humanizeMoodSlug(_ slug: String) -> String {
        var result = ""
        for char in slug {
            if char.isUppercase {
                result += " " + char.lowercased()
            } else {
                result.append(char)
            }
        }
        return result
    }

    // MARK: - Sleep night rollup

    /// One synthesized document per night, built from a
    /// `SleepNightSummary` rather than a single `NormalizedSample` — it
    /// aggregates every stage-interval sample bucketed into that night
    /// (see `SleepNightBucketer`). Unlike the workout/mindful/mood
    /// documents, this is not dispatched through `document(from:)`;
    /// `AppleHealthSource` calls it directly once per night touched by
    /// a sync page. `externalId` is stable across rebuilds
    /// (`sleep-night:<bucketDate>`), so re-uploading the same night as
    /// more historical data trickles in supersedes via upsert rather
    /// than duplicating.
    public static func sleepNightDocument(
        from summary: SleepNightSummary,
        providerId: String,
        sourceId: String
    )
        -> DocumentInput {
        let title = "Night of \(humanNightDate(summary.bucketDate))"
        let inBedRange = "\(formatClockTime(summary.inBedStart)) → \(formatClockTime(summary.inBedEnd))"

        let content: String = if summary.isStaged {
            stagedSleepContent(title: title, inBedRange: inBedRange, summary: summary)
        } else {
            coarseSleepContent(title: title, inBedRange: inBedRange, summary: summary)
        }

        let metadata = DocumentMetadata(
            documentType: "activity",
            tags: ["sleep"],
            extra: sleepSummaryExtra(summary),
            rollingAggregate: true
        )

        return DocumentInput(
            providerId: providerId,
            sourceId: sourceId,
            externalId: "sleep-night:\(summary.bucketDate)",
            title: title,
            content: content,
            contentHash: DocumentInput.computeContentHash(content),
            metadata: metadata,
            sourceCreatedAt: summary.inBedStart,
            sourceUpdatedAt: summary.inBedEnd
        )
    }

    /// "Night of April 18 — in bed 23:02 → 07:14, asleep 7h 32m ·
    /// Deep 1h 20m · REM 1h 45m · Core 4h 10m · Awake 17m · 2 awakenings"
    /// — a stage segment only appears if its seconds are > 0, and the
    /// trailing awakenings clause is omitted entirely when zero.
    private static func stagedSleepContent(title: String, inBedRange: String, summary: SleepNightSummary) -> String {
        var segments: [String] = []
        if summary.deepSeconds > 0 { segments.append("Deep \(formatHoursMinutes(summary.deepSeconds))") }
        if summary.remSeconds > 0 { segments.append("REM \(formatHoursMinutes(summary.remSeconds))") }
        if summary.coreSeconds > 0 { segments.append("Core \(formatHoursMinutes(summary.coreSeconds))") }
        if summary.awakeSeconds > 0 { segments.append("Awake \(formatHoursMinutes(summary.awakeSeconds))") }

        var content = "\(title) — in bed \(inBedRange), asleep \(formatHoursMinutes(summary.totalAsleepSeconds))"
        if !segments.isEmpty {
            content += " · " + segments.joined(separator: " · ")
        }
        if summary.awakeningsCount > 0 {
            let word = summary.awakeningsCount == 1 ? "awakening" : "awakenings"
            content += " · \(summary.awakeningsCount) \(word)"
        }
        return content
    }

    /// Degraded case for a source with no stage breakdown at all (a
    /// coarse in-bed/asleep-only log): "Night of April 18 — in bed
    /// 23:02 → 07:14, asleep 7h 45m".
    private static func coarseSleepContent(title: String, inBedRange: String, summary: SleepNightSummary) -> String {
        let asleepSeconds = summary.unspecifiedAsleepSeconds > 0
            ? summary.unspecifiedAsleepSeconds
            : inBedSpanSeconds(summary)
        return "\(title) — in bed \(inBedRange), asleep \(formatHoursMinutes(asleepSeconds))"
    }

    private static func sleepSummaryExtra(_ summary: SleepNightSummary) -> [String: JSONValue] {
        [
            "bucketDate": .string(summary.bucketDate),
            "inBedStart": .string(summary.inBedStart),
            "inBedEnd": .string(summary.inBedEnd),
            "coreSeconds": .int(Int64(summary.coreSeconds)),
            "deepSeconds": .int(Int64(summary.deepSeconds)),
            "remSeconds": .int(Int64(summary.remSeconds)),
            "unspecifiedAsleepSeconds": .int(Int64(summary.unspecifiedAsleepSeconds)),
            "awakeSeconds": .int(Int64(summary.awakeSeconds)),
            "totalAsleepSeconds": .int(Int64(summary.totalAsleepSeconds)),
            "awakeningsCount": .int(Int64(summary.awakeningsCount)),
            "isStaged": .bool(summary.isStaged),
        ]
    }

    private static func inBedSpanSeconds(_ summary: SleepNightSummary) -> TimeInterval {
        guard let start = iso8601.date(from: summary.inBedStart),
              let end = iso8601.date(from: summary.inBedEnd)
        else { return 0 }
        return end.timeIntervalSince(start)
    }

    /// "2026-04-18" → "April 18". Parsed directly from the bucket key's
    /// digits rather than round-tripped through `Date`, so this never
    /// depends on (or disagrees with) any particular time zone.
    private static func humanNightDate(_ bucketDate: String) -> String {
        let monthNames = [
            "January", "February", "March", "April", "May", "June",
            "July", "August", "September", "October", "November", "December",
        ]
        let parts = bucketDate.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3, (1 ... 12).contains(parts[1]) else { return bucketDate }
        return "\(monthNames[parts[1] - 1]) \(parts[2])"
    }

    private static let clockTimeFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateFormat = "HH:mm"
        return formatter
    }()

    private static func formatClockTime(_ iso: String) -> String {
        guard let date = iso8601.date(from: iso) else { return "--:--" }
        return clockTimeFormatter.string(from: date)
    }

    /// "7h 32m", "3h", "45m" — compact hours/minutes, dropping whichever
    /// unit is zero.
    private static func formatHoursMinutes(_ seconds: TimeInterval) -> String {
        let totalMinutes = Int((seconds / 60).rounded())
        let hours = totalMinutes / 60
        let minutes = totalMinutes % 60
        if hours > 0, minutes > 0 { return "\(hours)h \(minutes)m" }
        if hours > 0 { return "\(hours)h" }
        return "\(minutes)m"
    }

    // MARK: - Date helpers

    private static let iso8601: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    private static func durationSeconds(start: String, end: String) -> Int {
        guard let startDate = iso8601.date(from: start),
              let endDate = iso8601.date(from: end)
        else { return 0 }
        return Int(endDate.timeIntervalSince(startDate).rounded())
    }

    // MARK: - Formatting helpers

    /// "Morning Run", "Evening Cycle", etc. — time-of-day + humanised type.
    private static func workoutTitle(typeSlug: String, start: String) -> String {
        "\(timeOfDay(from: start)) \(humanWorkoutType(typeSlug))"
    }

    private static func humanWorkoutType(_ slug: String) -> String {
        switch slug {
        case "running": "Run"
        case "walking": "Walk"
        case "cycling": "Cycle"
        case "swimming": "Swim"
        case "hiking": "Hike"
        case "yoga": "Yoga"
        case "strength": "Strength Session"
        case "functional_strength": "Functional Strength Session"
        case "hiit": "HIIT Session"
        case "elliptical": "Elliptical Session"
        case "rowing": "Row"
        case "other": "Workout"
        case "unknown": "Workout"
        default:
            // "hk_46" or a future slug — title-case the words.
            slug.split(separator: "_")
                .map { $0.prefix(1).uppercased() + $0.dropFirst() }
                .joined(separator: " ")
        }
    }

    /// Local-time bucket from a UTC ISO-8601 start. Falls back to
    /// "Daytime" if the timestamp can't be parsed.
    private static func timeOfDay(from start: String) -> String {
        guard let date = iso8601.date(from: start) else { return "Daytime" }
        let hour = Calendar(identifier: .gregorian).component(.hour, from: date)
        switch hour {
        case 5 ..< 12: return "Morning"
        case 12 ..< 17: return "Afternoon"
        case 17 ..< 21: return "Evening"
        default: return "Night"
        }
    }

    private static func formatDistance(_ meters: Double) -> String {
        if meters >= 1000 {
            let km = (meters / 1000 * 10).rounded() / 10
            return "\(trimDecimal(km)) km"
        }
        return "\(Int(meters.rounded())) m"
    }

    private static func formatDuration(seconds: Int) -> String {
        let minutes = Int((Double(seconds) / 60).rounded())
        if minutes >= 60 {
            let hours = minutes / 60
            let mins = minutes % 60
            return mins == 0 ? "\(hours) h" : "\(hours) h \(mins) min"
        }
        return "\(minutes) min"
    }

    /// Drop a trailing ".0" so "9.0" reads "9".
    private static func trimDecimal(_ value: Double) -> String {
        value == value.rounded() ? String(Int(value)) : String(value)
    }
}
