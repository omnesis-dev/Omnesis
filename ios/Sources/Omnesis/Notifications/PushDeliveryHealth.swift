// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// How Omnesis's push notifications will actually reach the user, derived from
/// the OS notification settings after permission is requested. Surfacing this —
/// instead of silently registering an APNs token and assuming delivery — is what
/// lets the app tell the user when pushes won't visibly arrive: denied
/// permission, iOS "Scheduled Summary" batching, or alerts turned off (#1260).
public enum PushDeliveryHealth: Equatable, Sendable {
    /// Authorized, alerts on, not batched — pushes arrive as banners.
    case ok
    /// The user has not decided yet. Omnesis only asks when they turn
    /// notifications on.
    case notDetermined
    /// Permission denied in iOS Settings — no pushes at all.
    case permissionDenied
    /// iOS Scheduled Summary is holding pushes for a batched digest, so they
    /// don't arrive when they're sent.
    case scheduledSummary
    /// Authorized but alerts are off — pushes deliver silently to Notification
    /// Center with no banner or sound.
    case alertsOff

    /// Stable value accepted by the gateway's device push-health endpoint.
    /// Keep this mapping separate from the user-facing case names so the wire
    /// contract can remain explicit if the UI terminology changes.
    public var gatewayStatus: String {
        switch self {
        case .ok: "healthy"
        case .notDetermined: "not-determined"
        case .permissionDenied: "permission-denied"
        case .scheduledSummary: "scheduled-summary"
        case .alertsOff: "alerts-disabled"
        }
    }

    /// A user-facing warning for a degraded state, or `nil` when delivery is fine.
    public var warning: (title: String, detail: String)? {
        switch self {
        case .ok:
            nil
        case .notDetermined:
            (
                "Notifications aren't set up",
                "Omnesis hasn't been granted notification permission yet, so it can't alert you about anything time-sensitive."
            )
        case .permissionDenied:
            (
                "Notifications are off",
                "Omnesis notifications are turned off in iOS Settings, so pushes like the morning brief won't arrive."
            )
        case .scheduledSummary:
            (
                "Notifications are being batched",
                "iOS Scheduled Summary is holding Omnesis notifications for a scheduled digest, so they won't "
                    + "arrive when they're sent. Turn Scheduled Summary off for Omnesis to get them immediately."
            )
        case .alertsOff:
            (
                "Alerts are off",
                "Omnesis notifications are delivered silently to Notification Center — no banner or sound — "
                    + "so time-sensitive pushes are easy to miss."
            )
        }
    }
}

#if canImport(UserNotifications)
import UserNotifications

/// The notification settings Omnesis reads, and the one request it makes.
public protocol NotificationPermissionCenter: Sendable {
    func deliveryHealth() async -> PushDeliveryHealth
    /// Shows the iOS notification prompt when iOS has not asked yet.
    func requestAuthorization() async throws -> Bool
}

/// `NotificationPermissionCenter` backed by `UNUserNotificationCenter`.
public struct SystemNotificationPermissionCenter: NotificationPermissionCenter {
    public init() {}

    public func deliveryHealth() async -> PushDeliveryHealth {
        await .from(UNUserNotificationCenter.current().notificationSettings())
    }

    /// Alert, sound and badge. `.provisional` would deliver silently to
    /// Notification Center without a banner.
    public func requestAuthorization() async throws -> Bool {
        try await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])
    }
}

extension PushDeliveryHealth {
    /// Derive the delivery health from the OS notification settings.
    public static func from(_ settings: UNNotificationSettings) -> PushDeliveryHealth {
        from(
            authorization: settings.authorizationStatus,
            scheduledDelivery: settings.scheduledDeliverySetting,
            alert: settings.alertSetting
        )
    }

    /// Pure derivation from the three relevant settings fields. Split out from
    /// `from(_:)` because `UNNotificationSettings` has no public initializer, so
    /// this is the seam the unit tests drive.
    public static func from(
        authorization: UNAuthorizationStatus,
        scheduledDelivery: UNNotificationSetting,
        alert: UNNotificationSetting
    )
        -> PushDeliveryHealth {
        switch authorization {
        case .denied:
            return .permissionDenied
        case .notDetermined:
            return .notDetermined
        default:
            break // authorized / provisional / ephemeral
        }
        if scheduledDelivery == .enabled {
            return .scheduledSummary
        }
        if alert == .disabled {
            return .alertsOff
        }
        return .ok
    }
}
#endif
