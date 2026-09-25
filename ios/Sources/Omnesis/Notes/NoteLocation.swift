// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// Where a note was captured: a WGS-84 coordinate plus, when a reverse
/// geocode succeeded, a human place name (e.g. "Paris"). Pure and
/// Foundation-only so it rides on the wire (`POST /notes`), persists in
/// the offline queue (`PendingNote`), and is covered by the sim-less
/// logic lane — the device-specific capture lives in
/// `NoteLocationProvider`.
public struct NoteLocation: Codable, Equatable, Sendable {
    public let latitude: Double
    public let longitude: Double
    /// Reverse-geocoded place name, or nil when the device had a fix but
    /// no geocode (offline at capture time).
    public let placeName: String?

    public init(latitude: Double, longitude: Double, placeName: String? = nil) {
        self.latitude = latitude
        self.longitude = longitude
        self.placeName = placeName
    }
}

/// Resolves the capturing device's current location, best-effort. A
/// protocol so the capture paths depend on the seam, not on
/// CoreLocation: the app injects the real `NoteLocationProvider`, tests
/// inject a stub, and the logic lane needs neither.
public protocol NoteLocationProviding: Sendable {
    /// One-shot current location + reverse-geocoded place name. Returns
    /// nil when location permission is not granted, no fix arrives within
    /// the budget, or the surface has no location hardware — a note
    /// without a fix is captured all the same.
    ///
    /// `promptIfNeeded` gates the first-time authorization request: the
    /// foreground in-app capture passes `true` so the OS prompt can appear
    /// and be answered; background captures (Siri, the watch relay) pass
    /// `false` so an undetermined permission yields nil at once instead of
    /// blocking on a prompt no one can see.
    func current(promptIfNeeded: Bool) async -> NoteLocation?
}
