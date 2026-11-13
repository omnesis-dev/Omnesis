// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// The cloud build flag (`OMNESIS_CLOUD_RELAY_ENABLED`). While it is off, every
/// sign-in enrollment surface, Keychain item, device key and background step is
/// absent, so a QR-paired phone behaves as it does without cloud connectivity.
public enum CloudRelayFeature {
    public static let enabled: Bool = {
        #if DEBUG
        // The scripted UI-test surfaces render cloud screens in any build.
        let environment = ProcessInfo.processInfo.environment
        if environment["DEMO_CLOUD_PAIRING"] != nil || environment["DEMO_PUSH_TAP"]?.hasPrefix("pairing") == true { return true }
        #endif
        return isEnabled(in: .main)
    }()

    static func isEnabled(in bundle: Bundle) -> Bool {
        bundle.object(forInfoDictionaryKey: "OmnesisCloudRelayEnabled") as? String == "1"
    }
}
