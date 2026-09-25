// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// `AnalyticsTableSchema` + record builder for `location_visits`. Pure — no
/// CoreLocation import — so it's testable on macOS like `HealthSchemas`.
public enum VisitSchema {
    public static let table = AnalyticsTableSchema(
        tableName: "location_visits",
        displayName: "Location Visits",
        description: "Places you spent time — a named place with an arrival and departure — derived on-device "
            + "from Core Location visit monitoring. The place name is resolved on the phone; only names, "
            + "never raw coordinates, feed the searchable index.",
        columns: [
            ColumnDefinition(
                name: "id",
                type: .varchar,
                description: "Deterministic id derived from account + arrival"
            ),
            ColumnDefinition(name: "account_id", type: .varchar, description: "Per-iPhone identifier"),
            ColumnDefinition(
                name: "place_name",
                type: .varchar,
                description: "Most-specific place name (landmark / street / neighbourhood / city)"
            ),
            ColumnDefinition(
                name: "sub_locality",
                type: .varchar,
                description: "Neighbourhood / district",
                nullable: true
            ),
            ColumnDefinition(name: "locality", type: .varchar, description: "City / town", nullable: true),
            ColumnDefinition(
                name: "administrative_area",
                type: .varchar,
                description: "State / region",
                nullable: true
            ),
            ColumnDefinition(name: "country", type: .varchar, description: "Country", nullable: true),
            ColumnDefinition(name: "latitude", type: .double, description: "Visit centre latitude"),
            ColumnDefinition(name: "longitude", type: .double, description: "Visit centre longitude"),
            ColumnDefinition(name: "horizontal_accuracy_m", type: .double, description: "Radius estimate in metres"),
            ColumnDefinition(name: "arrival_time", type: .timestamptz, description: "When the dwell began (UTC)"),
            ColumnDefinition(name: "departure_time", type: .timestamptz, description: "When the dwell ended (UTC)"),
            ColumnDefinition(name: "duration_seconds", type: .integer, description: "Dwell duration"),
        ],
        primaryKey: ["id"],
        exampleQueries: [
            "SELECT place_name, arrival_time, departure_time FROM location_visits "
                + "WHERE arrival_time >= CURRENT_DATE - INTERVAL 7 DAY ORDER BY arrival_time DESC",
            "SELECT place_name, COUNT(*) AS visits, SUM(duration_seconds)/3600.0 AS hours "
                + "FROM location_visits GROUP BY place_name ORDER BY hours DESC LIMIT 20",
        ],
        semanticTimeColumn: "arrival_time",
        record: RecordDisplaySpec(
            titleColumns: ["place_name"],
            keyColumns: ["place_name", "arrival_time", "departure_time", "duration_seconds"]
        ),
        // Each visit also mints a searchable summary document whose
        // externalId == this row's id — declare the 1:1 doc↔row same-entity
        // edge so the agent can pivot between the structured row and
        // its prose.
        boundDocument: BoundDocumentSpec(externalIdColumns: ["id"]),
        temporalProjection: AnalyticsTemporalProjectionSpec(
            slot: "visit",
            end: "departure_time",
            label: "place_name",
            kind: .constant(.visit),
            modality: .constant(.observed),
            status: .constant(.completed)
        )
    )

    /// Deterministic row id (and bound-document externalId) for a visit —
    /// its arrival is the natural key, so a re-delivered visit upserts in
    /// place rather than duplicating.
    public static func rowId(arrival: Date, accountId: String) -> String {
        "\(accountId)-\(VisitTime.iso.string(from: arrival))"
    }

    public static func record(from visit: ResolvedVisit, accountId: String) -> [String: JSONValue] {
        let duration = visit.departure.timeIntervalSince(visit.arrival)
        return [
            "id": .string(rowId(arrival: visit.arrival, accountId: accountId)),
            "account_id": .string(accountId),
            "place_name": .string(visit.place.name),
            "sub_locality": optional(visit.place.subLocality),
            "locality": optional(visit.place.locality),
            "administrative_area": optional(visit.place.administrativeArea),
            "country": optional(visit.place.country),
            "latitude": .double(visit.latitude),
            "longitude": .double(visit.longitude),
            "horizontal_accuracy_m": .double(visit.horizontalAccuracy),
            "arrival_time": .string(VisitTime.iso.string(from: visit.arrival)),
            "departure_time": .string(VisitTime.iso.string(from: visit.departure)),
            "duration_seconds": .int(Int64(duration.rounded())),
        ]
    }

    private static func optional(_ value: String?) -> JSONValue {
        value.map(JSONValue.string) ?? .null
    }
}

/// Mints one searchable `DocumentInput` per completed, named visit — a
/// discrete time-anchored event ("Visited Mission District — July 21"),
/// bound 1:1 to its `location_visits` row via `externalId == row.id`.
/// Unlike `ActivitySegmentDocumentBuilder`'s per-day rollup, visits are the
/// discrete events themselves, so each is its own document.
public enum VisitDocumentBuilder {
    public static func document(
        from visit: ResolvedVisit,
        providerId: String,
        sourceId: String,
        accountId: String,
        calendar: Calendar
    )
        -> DocumentInput {
        let place = visit.place
        let title = "Visited \(place.name) — \(VisitTime.humanDay(visit.arrival, calendar: calendar))"

        let duration = visit.departure.timeIntervalSince(visit.arrival)
        let timeRange = "\(VisitTime.clock(visit.arrival, calendar: calendar)) → "
            + "\(VisitTime.clock(visit.departure, calendar: calendar)) (\(VisitTime.durationLabel(duration)))"

        let area = areaContext(place)
        var content = "\(title). \(timeRange)."
        if let area {
            content += " \(area)."
        }

        var extra: [String: JSONValue] = [
            "arrival": .string(VisitTime.iso.string(from: visit.arrival)),
            "departure": .string(VisitTime.iso.string(from: visit.departure)),
            "durationSeconds": .int(Int64(duration.rounded())),
            "placeName": .string(place.name),
        ]
        if let subLocality = place.subLocality { extra["subLocality"] = .string(subLocality) }
        if let locality = place.locality { extra["locality"] = .string(locality) }
        if let area = place.administrativeArea { extra["administrativeArea"] = .string(area) }
        if let country = place.country { extra["country"] = .string(country) }

        let metadata = DocumentMetadata(
            documentType: "visit",
            tags: ["location", "visit"],
            extra: extra
        )

        return DocumentInput(
            providerId: providerId,
            sourceId: sourceId,
            externalId: VisitSchema.rowId(arrival: visit.arrival, accountId: accountId),
            title: title,
            content: content,
            contentHash: DocumentInput.computeContentHash(content),
            metadata: metadata,
            sourceCreatedAt: VisitTime.iso.string(from: visit.arrival),
            sourceUpdatedAt: VisitTime.iso.string(from: visit.departure)
        )
    }

    /// "San Francisco, California, United States" — the broader-than-name
    /// context, dropping any component equal to the place name (so a
    /// city-level visit doesn't read "San Francisco. San Francisco.") and
    /// de-duplicating. `nil` when there's nothing left to add.
    private static func areaContext(_ place: ResolvedPlace) -> String? {
        var seen = Set([place.name])
        var parts: [String] = []
        for component in [place.locality, place.administrativeArea, place.country] {
            guard let component, !seen.contains(component) else { continue }
            seen.insert(component)
            parts.append(component)
        }
        return parts.isEmpty ? nil : parts.joined(separator: ", ")
    }
}
