// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

#if DEBUG
/// UI automation starts the pairing journey from an unpaired app. The
/// simulator keeps Keychain items across launches and reinstalls, so a launch
/// with `DEMO_RESET_PAIRING=1` clears the stored pairing and the notification
/// claim credential before the app reads them. No-op otherwise, and absent
/// from release builds.
enum AutomationPairingReset {
    static func applyIfRequested() {
        guard ProcessInfo.processInfo.environment["DEMO_RESET_PAIRING"] == "1" else { return }
        try? Keychain().deleteAll()
        NotificationClaimCredentials.clear()
    }
}
#endif
