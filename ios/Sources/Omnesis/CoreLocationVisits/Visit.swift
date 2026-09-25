// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// How far back the durable visit buffer and the cursor's emitted-set are
/// retained. A completed visit that fails to reverse-geocode (e.g. the
/// device was offline) is retried on every sync inside this window; past it
/// the buffer prunes it and the retry stops. Bounds both stores so neither
/// grows without limit.
public enum CoreLocationVisitsRetention {
    public static let days = 14
}

/// A completed dwell as reported by Core Location visit monitoring — the
/// platform-neutral mirror of one `CLVisit`, a plain `Codable` struct (not
/// `CLVisit` itself) so the merger, store, and source logic are testable
/// without CoreLocation. `departure` is optional to model the arrival-only
/// callback (`CLVisit.departureDate == .distantFuture`) the real provider
/// filters out; a stored `RawVisit` always has a real departure.
public struct RawVisit: Codable, Equatable, Sendable {
    public let latitude: Double
    public let longitude: Double
    /// Radius estimate in metres. Can be large (tens–hundreds of metres) or
    /// negative when Core Location reports it invalid — kept verbatim, never
    /// used to gate emission.
    public let horizontalAccuracy: Double
    public let arrival: Date
    public let departure: Date?

    public init(latitude: Double, longitude: Double, horizontalAccuracy: Double, arrival: Date, departure: Date?) {
        self.latitude = latitude
        self.longitude = longitude
        self.horizontalAccuracy = horizontalAccuracy
        self.arrival = arrival
        self.departure = departure
    }
}

/// A human place name derived on-device from a coordinate — the only shape
/// of a visit that reaches the index. Coordinates are deliberately absent:
/// the agent reasons over place names, never raw GPS. Built from a
/// `CLPlacemark` (see `ReverseGeocoder.resolvedPlace`), but a plain struct
/// so the document/record builders are testable without CoreLocation.
public struct ResolvedPlace: Equatable, Sendable {
    /// Most-specific legible label — a landmark, else a street, else a
    /// neighbourhood/city/region/country. Never a coordinate.
    public let name: String
    public let subLocality: String?
    public let locality: String?
    public let administrativeArea: String?
    public let country: String?

    public init(
        name: String,
        subLocality: String? = nil,
        locality: String? = nil,
        administrativeArea: String? = nil,
        country: String? = nil
    ) {
        self.name = name
        self.subLocality = subLocality
        self.locality = locality
        self.administrativeArea = administrativeArea
        self.country = country
    }
}

/// A completed visit paired with its resolved place — the unit both the
/// analytics record and the searchable document are built from. Only ever
/// constructed for a visit that *did* resolve to a place, so `place` is
/// non-optional: an unnameable coordinate produces nothing.
public struct ResolvedVisit: Equatable, Sendable {
    public let arrival: Date
    public let departure: Date
    public let latitude: Double
    public let longitude: Double
    public let horizontalAccuracy: Double
    public let place: ResolvedPlace

    public init(
        arrival: Date,
        departure: Date,
        latitude: Double,
        longitude: Double,
        horizontalAccuracy: Double,
        place: ResolvedPlace
    ) {
        self.arrival = arrival
        self.departure = departure
        self.latitude = latitude
        self.longitude = longitude
        self.horizontalAccuracy = horizontalAccuracy
        self.place = place
    }
}

/// Selects which buffered visits are ready to emit. Pure — no CoreLocation
/// import — so it's testable on macOS like `ActivitySegmentMerger`.
public enum VisitMerger {
    /// Completed visits (a real departure) whose arrival hasn't been emitted
    /// before, one per distinct arrival, in chronological order.
    ///
    /// Arrival-only callbacks (no departure) carry no dwell window and are
    /// dropped — Core Location re-delivers the same visit fully bounded when
    /// the user leaves. Duplicate arrivals within the batch (a departure
    /// callback can fire more than once) collapse to the one with the latest
    /// departure, since a later read only ever refines the departure.
    public static func selectFresh(raw: [RawVisit], alreadyEmittedArrivals: Set<String>) -> [RawVisit] {
        // A real departure and a real arrival: arrival is the time anchor and
        // identity, so an unknown one (`.distantPast`) can't be placed or
        // de-duplicated. The provider already drops these, but guarding here
        // keeps the pure selection self-contained and testable.
        let completed = raw.filter { $0.departure != nil && $0.arrival > .distantPast }
        let byArrival = Dictionary(grouping: completed, by: { VisitTime.iso.string(from: $0.arrival) })
        return byArrival
            .filter { key, _ in !alreadyEmittedArrivals.contains(key) }
            .compactMap { _, group in
                group.max { ($0.departure ?? .distantPast) < ($1.departure ?? .distantPast) }
            }
            .sorted { $0.arrival < $1.arrival }
    }
}

/// Shared date formatting for the visits source — one ISO-8601 formatter
/// (fractional seconds, matching every other source's wire timestamps) plus
/// the human day / clock / duration helpers the document builder renders.
enum VisitTime {
    static let iso: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    static func parse(_ raw: String) -> Date? {
        iso.date(from: raw)
    }

    /// "July 21".
    static func humanDay(_ date: Date, calendar: Calendar) -> String {
        let formatter = DateFormatter()
        formatter.dateFormat = "MMMM d"
        formatter.timeZone = calendar.timeZone
        return formatter.string(from: date)
    }

    /// "18:30".
    static func clock(_ date: Date, calendar: Calendar) -> String {
        let formatter = DateFormatter()
        formatter.dateFormat = "HH:mm"
        formatter.timeZone = calendar.timeZone
        return formatter.string(from: date)
    }

    /// "1h 45m", "45m" — compact hours/minutes, dropping a zero unit.
    static func durationLabel(_ seconds: TimeInterval) -> String {
        let totalMinutes = max(0, Int((seconds / 60).rounded()))
        let hours = totalMinutes / 60
        let minutes = totalMinutes % 60
        if hours > 0, minutes > 0 { return "\(hours)h \(minutes)m" }
        if hours > 0 { return "\(hours)h" }
        return "\(minutes)m"
    }
}
