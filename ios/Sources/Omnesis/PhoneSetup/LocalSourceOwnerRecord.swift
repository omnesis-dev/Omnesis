// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// Which device id the phone's local source switches and setup record belong
/// to. Pairing under a different device id starts from a clean slate; pairing
/// the same id again, as a repair does, keeps them.
public struct LocalSourceOwnerRecord {
    static let key = "omnesis.localSources.deviceId"

    private let defaults: KeyValueDefaults

    public init(defaults: KeyValueDefaults = UserDefaults.standard) {
        self.defaults = defaults
    }

    public var deviceId: String? {
        get { defaults.object(forKey: Self.key) as? String }
        set {
            if let newValue {
                defaults.set(newValue, forKey: Self.key)
            } else {
                defaults.removeObject(forKey: Self.key)
            }
        }
    }

    /// Whether local source state has to be cleared before a session for
    /// `deviceId` is built. State with no recorded owner belongs to no pairing
    /// and is cleared too.
    public func belongsToAnotherDevice(than deviceId: String) -> Bool {
        self.deviceId != deviceId
    }
}
