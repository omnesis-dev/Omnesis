// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// `AnalyticsTableSchema` + record builder for `activity_segments`.
/// Mirrors the style of `HealthSchemas` — no CoreMotion import, testable
/// on macOS.
public enum ActivitySegmentSchema {
    public static let table = AnalyticsTableSchema(
        tableName: "activity_segments",
        displayName: "Activity Segments",
        description: "Contiguous stretches of stationary / walking / running / driving / cycling time, "
            + "inferred from the device's motion coprocessor.",
        columns: [
            ColumnDefinition(name: "id", type: .varchar, description: "Deterministic id derived from account + start + type"),
            ColumnDefinition(name: "account_id", type: .varchar, description: "Per-iPhone identifier"),
            ColumnDefinition(name: "type", type: .varchar, description: "stationary / walking / running / automotive / cycling / unknown"),
            ColumnDefinition(name: "start_time", type: .timestamptz, description: "Segment start (UTC)"),
            ColumnDefinition(name: "end_time", type: .timestamptz, description: "Segment end (UTC)"),
            ColumnDefinition(name: "duration_seconds", type: .integer, description: "Segment duration"),
            ColumnDefinition(
                name: "confidence",
                type: .varchar,
                description: "low / medium / high — CoreMotion's confidence in this segment's type"
            ),
        ],
        primaryKey: ["id"],
        exampleQueries: [
            "SELECT type, SUM(duration_seconds)/3600.0 AS hours FROM activity_segments "
                + "WHERE start_time >= CURRENT_DATE - INTERVAL 7 DAY GROUP BY type ORDER BY hours DESC",
        ],
        semanticTimeColumn: "start_time",
        record: RecordDisplaySpec(titleColumns: ["type"], keyColumns: ["type", "start_time", "duration_seconds"])
    )

    public static func record(from segment: ActivitySegment, accountId: String) -> [String: JSONValue] {
        [
            "id": .string(rowId(for: segment, accountId: accountId)),
            "account_id": .string(accountId),
            "type": .string(segment.type.rawValue),
            "start_time": .string(iso8601.string(from: segment.start)),
            "end_time": .string(iso8601.string(from: segment.end)),
            "duration_seconds": .int(Int64(segment.durationSeconds.rounded())),
            "confidence": .string(segment.confidence.slug),
        ]
    }

    private static func rowId(for segment: ActivitySegment, accountId: String) -> String {
        "\(accountId)-\(iso8601.string(from: segment.start))-\(segment.type.rawValue)"
    }

    private static let iso8601: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()
}

/// Mints one searchable daily movement-summary `DocumentInput` per day
/// touched by a set of closed segments — a rolling aggregate over
/// `activity_segments`, not bound 1:1 to any single row (mirrors
/// `HealthDocumentBuilder.sleepNightDocument`'s pattern for the same
/// reason: many rows fold into one document).
public enum ActivitySegmentDocumentBuilder {
    public static func dailyDocuments(
        from segments: [ActivitySegment],
        calendar: Calendar,
        providerId: String,
        sourceId: String
    )
        -> [DocumentInput] {
        ActivitySegmentMerger.splitByDay(segments, calendar: calendar).map { day, daySegments in
            document(day: day, segments: daySegments, calendar: calendar, providerId: providerId, sourceId: sourceId)
        }
    }

    private static func document(
        day: Date,
        segments: [ActivitySegment],
        calendar: Calendar,
        providerId: String,
        sourceId: String
    )
        -> DocumentInput {
        let sorted = segments.sorted { $0.start < $1.start }
        let title = "Movement — \(humanDayDate(day, calendar: calendar))"
        let lines = sorted.map { segmentLine($0, calendar: calendar) }
        let content = lines.isEmpty ? title : title + " — " + lines.joined(separator: " · ")

        let extra: [String: JSONValue] = [
            "day": .string(dayKey(day, calendar: calendar)),
            "segments": .array(sorted.map(segmentExtra)),
        ]
        let metadata = DocumentMetadata(
            documentType: "activity",
            tags: ["movement"],
            extra: extra,
            rollingAggregate: true
        )

        let start = sorted.first?.start ?? day
        let end = sorted.last?.end ?? day

        return DocumentInput(
            providerId: providerId,
            sourceId: sourceId,
            externalId: "activity-segments-day:\(dayKey(day, calendar: calendar))",
            title: title,
            content: content,
            contentHash: DocumentInput.computeContentHash(content),
            metadata: metadata,
            sourceCreatedAt: iso8601.string(from: start),
            sourceUpdatedAt: iso8601.string(from: end)
        )
    }

    /// "Driving 09:03 → 09:41 (38m)".
    private static func segmentLine(_ segment: ActivitySegment, calendar: Calendar) -> String {
        let range = "\(clockTime(segment.start, calendar: calendar)) → \(clockTime(segment.end, calendar: calendar))"
        return "\(humanType(segment.type)) \(range) (\(formatHoursMinutes(segment.durationSeconds)))"
    }

    private static func segmentExtra(_ segment: ActivitySegment) -> JSONValue {
        .object([
            "type": .string(segment.type.rawValue),
            "start": .string(iso8601.string(from: segment.start)),
            "end": .string(iso8601.string(from: segment.end)),
            "durationSeconds": .int(Int64(segment.durationSeconds.rounded())),
            "confidence": .string(segment.confidence.slug),
        ])
    }

    private static func humanType(_ type: MotionActivityType) -> String {
        switch type {
        case .stationary: "Stationary"
        case .walking: "Walking"
        case .running: "Running"
        case .automotive: "Driving"
        case .cycling: "Cycling"
        case .unknown: "Unknown"
        }
    }

    private static func dayKey(_ day: Date, calendar: Calendar) -> String {
        let components = calendar.dateComponents([.year, .month, .day], from: day)
        return String(format: "%04d-%02d-%02d", components.year ?? 0, components.month ?? 0, components.day ?? 0)
    }

    private static func humanDayDate(_ day: Date, calendar: Calendar) -> String {
        let formatter = DateFormatter()
        formatter.dateFormat = "MMMM d"
        formatter.timeZone = calendar.timeZone
        return formatter.string(from: day)
    }

    private static func clockTime(_ date: Date, calendar: Calendar) -> String {
        let formatter = DateFormatter()
        formatter.dateFormat = "HH:mm"
        formatter.timeZone = calendar.timeZone
        return formatter.string(from: date)
    }

    /// "1h 20m", "45m" — compact hours/minutes, dropping whichever unit
    /// is zero.
    private static func formatHoursMinutes(_ seconds: TimeInterval) -> String {
        let totalMinutes = Int((seconds / 60).rounded())
        let hours = totalMinutes / 60
        let minutes = totalMinutes % 60
        if hours > 0, minutes > 0 { return "\(hours)h \(minutes)m" }
        if hours > 0 { return "\(hours)h" }
        return "\(minutes)m"
    }

    private static let iso8601: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()
}
