// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if canImport(CoreLocation)
@preconcurrency import CoreLocation

/// Turns a coordinate into a human place name (locality → administrative
/// area → country) via the platform's `CLGeocoder` service. This is the
/// one network-touching signal Omnesis derives on-device from a
/// coordinate it already holds — never from pixels or message content —
/// and is shared by the photo place analyzer (geotag → place) and the
/// notes location provider (device fix → place), so both pick the same
/// name for the same point.
///
/// `CLGeocoder` (rather than the iOS-26-only `MKReverseGeocodingRequest`)
/// is deliberate: it is the only reverse-geocoder that covers this app's
/// iOS 17+ deployment target.
public enum ReverseGeocoder {
    /// Reverse-geocode a location, returning [] on any failure (offline,
    /// throttled) so callers degrade gracefully rather than throwing.
    public static func placemarks(
        for location: CLLocation,
        geocoder: CLGeocoder = CLGeocoder()
    ) async
        -> [CLPlacemark] {
        do {
            return try await withCheckedThrowingContinuation { continuation in
                geocoder.reverseGeocodeLocation(location) { placemarks, error in
                    if let error {
                        continuation.resume(throwing: error)
                    } else {
                        continuation.resume(returning: placemarks ?? [])
                    }
                }
            }
        } catch {
            return []
        }
    }

    /// Best-effort place name for a coordinate, or nil when the geocode
    /// fails or yields nothing legible.
    public static func placeName(
        for location: CLLocation,
        geocoder: CLGeocoder = CLGeocoder()
    ) async
        -> String? {
        guard let placemark = await placemarks(for: location, geocoder: geocoder).first else {
            return nil
        }
        return placeName(from: placemark)
    }

    /// Prefer the most specific human-legible name available: locality
    /// (city) first, then administrative area (state/region), then
    /// country — never a bare coordinate.
    public static func placeName(from placemark: CLPlacemark) -> String? {
        placemark.locality ?? placemark.administrativeArea ?? placemark.country
    }
}
#endif
