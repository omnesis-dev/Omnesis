// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// What the Movement setup step needs from the app.
@MainActor
public protocol MovementSetupHost: AnyObject {
    var activitySegmentsEnabled: Bool { get }
    var motionActivityPermission: ActivitySegmentsPermissionState { get }
    func enableActivitySegments(activationChoice: MobileSourceActivationChoice?) async -> MobileSourceEnableResult
}

/// Movement's page in phone setup.
public struct MovementSetupStep: PhoneSetupStep {
    public static let sourceId = "activity-segments:local"

    public static let copy = PhoneSetupCopy(
        title: "Movement",
        row: "Walking, driving, still",
        value: "How you moved through each day: walking, running, cycling, driving and time spent still.",
        ask: "How much did I walk on my last trip?",
        ledger: PhoneSetupLedger(
            sent: ["Activity segments: type, start, end, confidence", "A daily movement summary"],
            staysLabel: "Stays on this iPhone",
            stays: ["Raw motion sensor readings"]
        ),
        fine: "iOS asks for Motion & Fitness access next.",
        permissionLabel: "Motion & Fitness access",
        onBody: "Your last 7 days of activity are being read now.",
        unavailableBody: "This iPhone can't report motion activity.",
        notAllowedSettingsSteps: "In Settings, turn on Motion & Fitness.",
        tint: 0x30D158,
        symbol: "figure.walk"
    )

    unowned let host: any MovementSetupHost

    public var id: String {
        Self.sourceId
    }

    public var group: PhoneSetupStepGroup {
        .source
    }

    public var copy: PhoneSetupCopy {
        Self.copy
    }

    public var rowState: PhoneSetupRowState {
        if host.motionActivityPermission == .unavailable {
            return .unavailable(reason: PhoneSetupCopy.notAvailableReason)
        }
        return host.activitySegmentsEnabled ? .alreadyOn : .selectable
    }

    public var isOn: Bool {
        host.activitySegmentsEnabled
    }

    public var needsBackgroundRefresh: Bool {
        true
    }

    public var authorization: MobileSourceAuthorization? {
        host.motionActivityPermission.setupAuthorization
    }

    public func enable(choice: MobileSourceActivationChoice?) async -> PhoneSetupOutcome {
        await PhoneSetupOutcome(host.enableActivitySegments(activationChoice: choice))
    }

    public func currentOutcome() -> PhoneSetupOutcome? {
        .live(enabled: host.activitySegmentsEnabled, authorization: host.motionActivityPermission.setupAuthorization)
    }
}

extension ActivitySegmentsPermissionState {
    /// What this permission means for turning Movement on, or `nil` before
    /// iOS has asked.
    public var setupAuthorization: MobileSourceAuthorization? {
        switch self {
        case .authorized: .granted(.full)
        case .denied, .restricted: .notAllowed
        case .unavailable: .unavailable(reason: PhoneSetupCopy.notAvailableReason)
        case .notDetermined: nil
        }
    }
}
