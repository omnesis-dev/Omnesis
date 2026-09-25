// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
#if canImport(CoreLocation) && canImport(Photos)
@preconcurrency import CoreLocation
import Photos

/// Reverse-geocodes a geotagged photo's coordinates into a human place
/// name (locality / administrative area / country) — needs only
/// `asset.location`, no pixels. Runs for every geotagged photo,
/// backfill and new alike, per the issue's title-contract requirement
/// (a text-less photo is still retrievable by place + date).
///
/// The coordinate → place-name derivation is shared with the notes
/// location provider via `ReverseGeocoder` (uses the platform's
/// reverse-geocoding service — a disclosed exception to on-device-only
/// for this one signal, per the product decision documented at
/// https://omnesis.dev/docs/sources: never pixels, only the coordinate
/// already read from the photo's own metadata via the Photos permission).
public struct PlaceAnalyzer: PhotoAnalyzer {
    public let identifier = "place"

    private let geocoder: CLGeocoder

    public init(geocoder: CLGeocoder = CLGeocoder()) {
        self.geocoder = geocoder
    }

    public func isAvailable() async -> Bool {
        true
    }

    public func analyze(_ input: PhotoAnalysisInput) async -> PhotoAnalysisFragment? {
        guard let location = input.asset.location else { return nil }
        guard let placemark = await ReverseGeocoder.placemarks(for: location, geocoder: geocoder).first
        else { return nil }
        guard let name = ReverseGeocoder.placeName(from: placemark) else { return nil }
        var extra: [String: JSONValue] = [
            "latitude": .double(location.coordinate.latitude),
            "longitude": .double(location.coordinate.longitude),
        ]
        if let country = placemark.country {
            extra["country"] = .string(country)
        }
        return PhotoAnalysisFragment(placeName: name, extra: extra)
    }
}
#endif
