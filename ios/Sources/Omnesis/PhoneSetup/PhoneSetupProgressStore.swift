// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// What pairing-time evaluation decides about showing phone setup.
public enum PhoneSetupAutomaticDecision: Equatable, Sendable {
    /// Show setup over home.
    case present
    /// Never show it for this device: mark it finished without asking.
    case completeSilently
    /// Setup was already finished or skipped for this device.
    case none
}

public enum PhoneSetupPresentationPolicy {
    /// Setup shows once per paired device. A device that already hosts a
    /// phone source was set up from Settings, so it is marked finished
    /// instead of being walked through again.
    public static func decide(
        completedForDeviceId: String?,
        deviceId: String,
        anyPhoneSourceEnabled: Bool
    )
        -> PhoneSetupAutomaticDecision {
        if completedForDeviceId == deviceId { return .none }
        return anyPhoneSourceEnabled ? .completeSilently : .present
    }
}

/// Local, pairing-scoped memory of phone setup: which device finished it and
/// where an unfinished run stood. Kept in `UserDefaults` rather than the
/// Keychain, and cleared on unpair.
public struct PhoneSetupProgressStore: Sendable {
    public enum Keys {
        public static let completedForDeviceId = "phoneSetup.completedForDeviceId"
        public static let progress = "phoneSetup.progress"
    }

    private let defaults: KeyValueDefaults

    public init(defaults: KeyValueDefaults = UserDefaults.standard) {
        self.defaults = defaults
    }

    public var completedForDeviceId: String? {
        get { defaults.string(forKey: Keys.completedForDeviceId) }
        nonmutating set { defaults.set(newValue, forKey: Keys.completedForDeviceId) }
    }

    /// The unfinished run saved for `deviceId`, if any. A run saved for a
    /// different device is ignored.
    public func progress(for deviceId: String) -> PhoneSetupFlow? {
        guard let raw = defaults.string(forKey: Keys.progress),
              let saved = try? JSONDecoder().decode(SavedProgress.self, from: Data(raw.utf8)),
              saved.deviceId == deviceId
        else { return nil }
        return saved.flow
    }

    public func saveProgress(_ flow: PhoneSetupFlow, deviceId: String) {
        guard let data = try? JSONEncoder().encode(SavedProgress(deviceId: deviceId, flow: flow)),
              let json = String(bytes: data, encoding: .utf8)
        else { return }
        defaults.set(json, forKey: Keys.progress)
    }

    public func clearProgress() {
        defaults.removeObject(forKey: Keys.progress)
    }

    /// Forgets everything, so the next pairing is offered setup again.
    public func reset() {
        defaults.removeObject(forKey: Keys.completedForDeviceId)
        defaults.removeObject(forKey: Keys.progress)
    }

    private struct SavedProgress: Codable {
        let deviceId: String
        let flow: PhoneSetupFlow
    }
}
