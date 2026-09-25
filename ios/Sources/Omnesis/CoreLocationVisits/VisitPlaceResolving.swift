// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// Seam over on-device reverse geocoding so `CoreLocationVisitsSource` is
/// testable without CoreLocation: a fake returns canned place names, the
/// real impl below wraps the same `CLGeocoder` service the photo geotag
/// analyzer uses. Returns `nil` when a coordinate can't be named (offline,
/// throttled, or genuinely nameless) — the source then skips that visit
/// entirely rather than indexing a bare coordinate, and retries it later.
public protocol VisitPlaceResolving: Sendable {
    func resolve(latitude: Double, longitude: Double) async -> ResolvedPlace?
}

/// In-memory fake for tests. Looks up a canned place by rounded coordinate,
/// falling back to `defaultPlace`; a `nil` default models a coordinate that
/// couldn't be geocoded.
public final class FakeVisitPlaceResolver: VisitPlaceResolving, @unchecked Sendable {
    public var byCoordinate: [String: ResolvedPlace]
    public var defaultPlace: ResolvedPlace?
    public private(set) var resolvedCoordinates: [(latitude: Double, longitude: Double)] = []

    public init(byCoordinate: [String: ResolvedPlace] = [:], defaultPlace: ResolvedPlace? = nil) {
        self.byCoordinate = byCoordinate
        self.defaultPlace = defaultPlace
    }

    public static func key(latitude: Double, longitude: Double) -> String {
        String(format: "%.4f,%.4f", latitude, longitude)
    }

    public func resolve(latitude: Double, longitude: Double) async -> ResolvedPlace? {
        resolvedCoordinates.append((latitude, longitude))
        return byCoordinate[Self.key(latitude: latitude, longitude: longitude)] ?? defaultPlace
    }
}

#if canImport(CoreLocation)
@preconcurrency import CoreLocation

/// Real `VisitPlaceResolving` backed by `CLGeocoder` via the shared
/// `ReverseGeocoder` — the same on-device reverse-geocoding service the
/// photo place analyzer uses, so a coordinate and a photo taken at it pick
/// the same name. No network mapping happens on the gateway: the phone turns
/// the coordinate into a name and only the name is indexed.
public final class ReverseGeocodeVisitPlaceResolver: VisitPlaceResolving, @unchecked Sendable {
    private let geocoder: CLGeocoder

    public init(geocoder: CLGeocoder = CLGeocoder()) {
        self.geocoder = geocoder
    }

    public func resolve(latitude: Double, longitude: Double) async -> ResolvedPlace? {
        let location = CLLocation(latitude: latitude, longitude: longitude)
        guard let placemark = await ReverseGeocoder.placemarks(for: location, geocoder: geocoder).first else {
            return nil
        }
        return ReverseGeocoder.resolvedPlace(from: placemark)
    }
}

extension ReverseGeocoder {
    /// Compose a `ResolvedPlace` from a placemark, choosing the most-specific
    /// legible name available. A landmark (`areasOfInterest`) wins when
    /// present — those are the reliably-named points (parks, airports,
    /// stadiums); otherwise a street address, then neighbourhood, city,
    /// region, country. Ordinary business names aren't returned by reverse
    /// geocoding, so this never invents one. `nil` when nothing is legible.
    public static func resolvedPlace(from placemark: CLPlacemark) -> ResolvedPlace? {
        let landmark = placemark.areasOfInterest?.first
        let street: String? = {
            let parts = [placemark.subThoroughfare, placemark.thoroughfare].compactMap { $0 }
            return parts.isEmpty ? nil : parts.joined(separator: " ")
        }()
        let name = landmark
            ?? street
            ?? placemark.subLocality
            ?? placemark.locality
            ?? placemark.administrativeArea
            ?? placemark.country
        guard let name else { return nil }
        return ResolvedPlace(
            name: name,
            subLocality: placemark.subLocality,
            locality: placemark.locality,
            administrativeArea: placemark.administrativeArea,
            country: placemark.country
        )
    }
}
#endif
