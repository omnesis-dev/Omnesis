// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// Abstract key/value store the HealthSettings uses. `UserDefaults`
/// conforms in production; tests inject a `DictionaryDefaults`.
public protocol KeyValueDefaults: Sendable {
    func string(forKey key: String) -> String?
    func object(forKey key: String) -> Any?
    func set(_ value: Any?, forKey key: String)
    func removeObject(forKey key: String)
}

extension UserDefaults: KeyValueDefaults {
    public func string(forKey key: String) -> String? {
        // Explicit disambiguation from UserDefaults' own string(forKey:)
        // when accessed via the protocol witness.
        value(forKey: key) as? String
    }
}

/// In-memory dictionary backing for tests.
public final class DictionaryDefaults: KeyValueDefaults, @unchecked Sendable {
    public private(set) var values: [String: Any] = [:]
    private let lock = NSLock()

    public init(values: [String: Any] = [:]) {
        self.values = values
    }

    public func string(forKey key: String) -> String? {
        lock.lock()
        defer { lock.unlock() }
        return values[key] as? String
    }

    public func object(forKey key: String) -> Any? {
        lock.lock()
        defer { lock.unlock() }
        return values[key]
    }

    public func set(_ value: Any?, forKey key: String) {
        lock.lock()
        defer { lock.unlock() }
        if let value {
            values[key] = value
        } else {
            values.removeValue(forKey: key)
        }
    }

    public func removeObject(forKey key: String) {
        lock.lock()
        defer { lock.unlock() }
        values.removeValue(forKey: key)
    }
}

/// Per-user HealthKit preferences. Lives in `UserDefaults.standard`
/// so it survives app relaunches but is wiped on uninstall.
///
/// Two pieces of state in Phase 4:
///   1. `hasRequestedHealthKitAuthorization` — tracks whether the
///      combined permission prompt has been shown, so we don't
///      re-prompt on every launch.
///   2. `enabledCategories` — which HealthCategory groups the user
///      wants indexed. Disabled categories are filtered out of the
///      `AppleHealthSource` rotation even if iOS granted read access.
public struct HealthSettings: Sendable {
    public enum Keys {
        public static let hasRequested = "omnesis.hk.hasRequested"
        public static let enabledCategories = "omnesis.hk.enabledCategories"
        /// Set when the user has opted in to Apple Health (post-pairing
        /// flow). Drives whether the gateway registers an
        /// `apple-health:<account>` source row + whether the collector
        /// instantiates `AppleHealthSource`. Distinct from
        /// `hasRequested` so we can re-show the system prompt without
        /// disabling syncing — and so existing pre-flag users migrate
        /// to enabled (see `AppStore` init).
        public static let appleHealthEnabled = "omnesis.hk.appleHealthEnabled"
    }

    /// Categories that are enabled out of the box. Excludes categories
    /// carrying particularly sensitive personal data — currently `.mood`
    /// (mental-health self-reports) and any future additions of the same
    /// kind (e.g. menstrual / sexual-activity data). Those require the
    /// user to explicitly opt in from Settings; see
    /// `SettingsView.appleHealthSection`'s consent alert.
    public static let defaultEnabledCategories: Set<HealthCategory> = [
        .body, .activity, .vitals, .sleep, .nutrition, .mindful,
        .environment, .workouts,
    ]

    private let defaults: KeyValueDefaults

    public init(defaults: KeyValueDefaults = UserDefaults.standard) {
        self.defaults = defaults
    }

    public var hasRequestedHealthKitAuthorization: Bool {
        get { (defaults.object(forKey: Keys.hasRequested) as? Bool) ?? false }
        nonmutating set { defaults.set(newValue, forKey: Keys.hasRequested) }
    }

    /// User has opted in to Apple Health post-pairing. The collector
    /// includes `AppleHealthSource` and the gateway carries an
    /// `apple-health:<account>` row only when this is true.
    /// Reset on `unpair()` so a fresh pair starts from defaults.
    public var appleHealthEnabled: Bool {
        get { (defaults.object(forKey: Keys.appleHealthEnabled) as? Bool) ?? false }
        nonmutating set { defaults.set(newValue, forKey: Keys.appleHealthEnabled) }
    }

    /// Has the new opt-in flag ever been written? Lets `AppStore` migrate
    /// users that pre-date the flag (their `hasRequested` was the only
    /// signal) without losing their syncing setup.
    public var appleHealthEnabledHasBeenSet: Bool {
        defaults.object(forKey: Keys.appleHealthEnabled) != nil
    }

    public var enabledCategories: Set<HealthCategory> {
        get {
            if let raw = defaults.object(forKey: Keys.enabledCategories) as? [String] {
                return Set(raw.compactMap(HealthCategory.init(rawValue:)))
            }
            return Self.defaultEnabledCategories
        }
        nonmutating set {
            let raw = newValue.map(\.rawValue).sorted()
            defaults.set(raw, forKey: Keys.enabledCategories)
        }
    }

    public func setCategory(_ category: HealthCategory, enabled: Bool) {
        var current = enabledCategories
        if enabled {
            current.insert(category)
        } else {
            current.remove(category)
        }
        enabledCategories = current
    }

    /// Wipe every setting — called on unpair so a fresh pairing starts
    /// from defaults.
    public func reset() {
        defaults.removeObject(forKey: Keys.hasRequested)
        defaults.removeObject(forKey: Keys.enabledCategories)
        defaults.removeObject(forKey: Keys.appleHealthEnabled)
    }
}
