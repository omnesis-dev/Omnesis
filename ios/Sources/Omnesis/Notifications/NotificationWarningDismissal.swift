// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// Dismissal policy for the home notification warning.
///
/// Some users genuinely do not want notifications, so the home banner gets a
/// dismiss cross. Dismissal lasts for one "epoch" of degraded delivery: once
/// dismissed the warning stays hidden until the app sees delivery healthy
/// again (`.ok`), which clears the flag so the next degraded epoch shows the
/// warning once more.
public enum NotificationWarningDismissal {
    public static let defaultsKey = "omnesis.notificationWarning.dismissed"

    /// Whether the home banner should show the notification warning now.
    public static func shouldShowWarning(health: PushDeliveryHealth, dismissed: Bool) -> Bool {
        health.raisesHomeAttention && !dismissed
    }

    /// Whether observing this health should clear a previous dismissal,
    /// opening a new epoch.
    public static func shouldResetDismissal(health: PushDeliveryHealth) -> Bool {
        health == .ok
    }
}
