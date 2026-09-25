// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// The user's notification decision, as setup reads it.
public enum PhoneSetupNotificationPermission: Equatable, Sendable {
    case notDetermined
    case authorized
    case denied
}

/// What the Notifications setup step needs from the app.
@MainActor
public protocol NotificationsSetupHost: AnyObject {
    var notificationPermission: PhoneSetupNotificationPermission { get }
    /// A relay-consent decision waiting for the owner, if the gateway needs one.
    var relayPushConsentRequest: RelayPushConsentRequest? { get }
    func refreshPushDeliveryHealth() async
    /// Shows the iOS notification prompt and registers for pushes when
    /// allowed. Returns whether notifications are allowed afterwards.
    func requestNotificationPermission() async -> Bool
    func allowRelayPush(_ request: RelayPushConsentRequest) async throws
    func dismissRelayPushConsent(_ request: RelayPushConsentRequest)
}

/// Notifications' page in phone setup. It sends nothing to the gateway, so it
/// lists what it alerts about instead of a ledger.
public struct NotificationsSetupStep: PhoneSetupStep {
    public static let stepId = "notifications"

    public static let copy = PhoneSetupCopy(
        title: "Notifications",
        row: "Answers and approvals",
        value: "Know when a slow answer is ready, when something needs your approval, and when a source stops syncing.",
        highlights: [
            PhoneSetupHighlight(symbol: "hourglass", text: "Answers that took a while"),
            PhoneSetupHighlight(symbol: "checkmark.seal", text: "Requests waiting for your approval"),
            PhoneSetupHighlight(symbol: "exclamationmark.triangle", text: "Sources that need attention"),
        ],
        fine: "iOS asks next. You can change this in Settings any time.",
        permissionLabel: "notifications",
        onBody: "You'll hear when an answer is ready, when something needs your approval, or when a source needs attention.",
        onTitle: "Notifications are on",
        offTitle: "Notifications are off",
        offBody: "You can turn them on in Settings any time.",
        notAllowedSettingsSteps: "In Settings, tap Notifications and turn on Allow Notifications.",
        busyLabel: "Turning on notifications…",
        tint: 0xFFD60A,
        symbol: "bell.fill"
    )

    static let offInSettingsReason = "Off in Settings"

    unowned let host: any NotificationsSetupHost

    public var id: String {
        Self.stepId
    }

    public var group: PhoneSetupStepGroup {
        .also
    }

    public var copy: PhoneSetupCopy {
        Self.copy
    }

    public var rowState: PhoneSetupRowState {
        switch host.notificationPermission {
        case .notDetermined: .selectable
        case .authorized: .alreadyOn
        case .denied: .unavailable(reason: Self.offInSettingsReason)
        }
    }

    public var authorization: MobileSourceAuthorization? {
        switch host.notificationPermission {
        case .authorized: .granted(.full)
        case .denied: .notAllowed
        case .notDetermined: nil
        }
    }

    public func refresh() async {
        await host.refreshPushDeliveryHealth()
    }

    public func enable(choice _: MobileSourceActivationChoice?) async -> PhoneSetupOutcome {
        await host.requestNotificationPermission() ? .on : .notAllowed
    }

    public func currentOutcome() -> PhoneSetupOutcome? {
        switch host.notificationPermission {
        case .notDetermined: nil
        case .authorized: .on
        case .denied: .notAllowed
        }
    }
}

extension PushDeliveryHealth {
    /// The permission decision behind this delivery state.
    public var setupPermission: PhoneSetupNotificationPermission {
        switch self {
        case .notDetermined: .notDetermined
        case .permissionDenied: .denied
        case .ok, .scheduledSummary, .alertsOff: .authorized
        }
    }

    /// Whether the app registers for pushes without asking. Omnesis only
    /// shows the iOS notification prompt when the user asks for
    /// notifications, so an undecided permission registers nothing.
    public var registersPushTokenAutomatically: Bool {
        self != .notDetermined
    }

    /// Whether the state earns a warning banner on home. An undecided
    /// permission is the user's choice to make in setup or Settings, not a
    /// fault to flag.
    public var raisesHomeAttention: Bool {
        warning != nil && self != .notDetermined
    }
}
