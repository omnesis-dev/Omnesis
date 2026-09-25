// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// Per-user preference for the Location Visits source. A single opt-in flag,
/// off by default — location is the most sensitive signal the app captures,
/// so it is never enabled without the user turning it on. Reuses the
/// `KeyValueDefaults` seam so tests inject an in-memory `DictionaryDefaults`.
public struct CoreLocationVisitsSettings: Sendable {
    public enum Keys {
        /// Drives whether the gateway carries a
        /// `core-location-visits:<account>` source row and whether the
        /// collector instantiates `CoreLocationVisitsSource`.
        public static let enabled = "omnesis.coreLocationVisits.enabled"
    }

    private let defaults: KeyValueDefaults

    public init(defaults: KeyValueDefaults = UserDefaults.standard) {
        self.defaults = defaults
    }

    public var enabled: Bool {
        get { (defaults.object(forKey: Keys.enabled) as? Bool) ?? false }
        nonmutating set { defaults.set(newValue, forKey: Keys.enabled) }
    }

    /// Wipe the setting — called on unpair so a fresh pairing starts from
    /// defaults.
    public func reset() {
        defaults.removeObject(forKey: Keys.enabled)
    }
}
