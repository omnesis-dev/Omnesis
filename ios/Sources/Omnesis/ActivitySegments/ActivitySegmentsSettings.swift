// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// Per-user preference for the Activity Segments source. Mirrors
/// `HealthSettings`'s shape but simpler — a single opt-in flag, no
/// per-category toggles. Reuses the `KeyValueDefaults` seam
/// (`HealthSettings.swift`) so tests inject the same in-memory
/// `DictionaryDefaults`.
public struct ActivitySegmentsSettings: Sendable {
    public enum Keys {
        /// Drives whether the gateway carries an
        /// `activity-segments:<account>` source row and whether the
        /// collector instantiates `ActivitySegmentsSource`.
        public static let enabled = "omnesis.activitySegments.enabled"
    }

    private let defaults: KeyValueDefaults

    public init(defaults: KeyValueDefaults = UserDefaults.standard) {
        self.defaults = defaults
    }

    public var enabled: Bool {
        get { (defaults.object(forKey: Keys.enabled) as? Bool) ?? false }
        nonmutating set { defaults.set(newValue, forKey: Keys.enabled) }
    }

    /// Wipe the setting — called on unpair so a fresh pairing starts
    /// from defaults, same as `HealthSettings.reset()`.
    public func reset() {
        defaults.removeObject(forKey: Keys.enabled)
    }
}
