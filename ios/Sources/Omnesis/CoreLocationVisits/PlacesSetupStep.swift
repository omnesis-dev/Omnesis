// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// What the Places setup step needs from the app.
@MainActor
public protocol PlacesSetupHost: AnyObject {
    var coreLocationVisitsEnabled: Bool { get }
    var locationVisitsPermission: LocationVisitsPermissionState { get }
    func enableCoreLocationVisits(activationChoice: MobileSourceActivationChoice?) async -> MobileSourceEnableResult
    /// Shows the location prompts iOS still has to show for a Places source
    /// that is already on, and returns the permission afterwards.
    func requestLocationVisitsPermission() async -> LocationVisitsPermissionState
}

/// Places' page in phone setup.
public struct PlacesSetupStep: PhoneSetupStep {
    public static let sourceId = "core-location-visits:local"

    public static let copy = PhoneSetupCopy(
        title: "Places",
        row: "Where you spent time",
        value: "Your day as the places you spent time: where, when and for how long.",
        ask: "When was I last at the climbing gym?",
        ledger: PhoneSetupLedger(
            sent: ["Place name and area", "Coordinates", "Arrival and departure times"],
            staysLabel: "Never recorded",
            stays: ["Your route between places"]
        ),
        fine: "iOS asks twice. Choose Always Allow so visits are noticed while Omnesis is closed.",
        permissionLabel: "location access",
        onBody: "Visits appear after you've spent some time somewhere.",
        partialBody: "iOS allowed location only while Omnesis is open, so visits are missed while it's closed. "
            + "Change it to Always in Settings.",
        notAllowedSettingsSteps: "In Settings, tap Location, choose Always, and turn on Precise Location.",
        partialSettingsSteps: "In Settings, tap Location, choose Always, and keep Precise Location on.",
        tint: 0xFF9F0A,
        symbol: "mappin.and.ellipse"
    )

    unowned let host: any PlacesSetupHost

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
        host.coreLocationVisitsEnabled ? .alreadyOn : .selectable
    }

    public var authorization: MobileSourceAuthorization? {
        host.locationVisitsPermission.setupAuthorization
    }

    /// A source already on whose location access was never decided, as when
    /// a run resumes after the app closed during the prompt, only needs iOS
    /// to ask.
    public func enable(choice: MobileSourceActivationChoice?) async -> PhoneSetupOutcome {
        if host.coreLocationVisitsEnabled, host.locationVisitsPermission == .notDetermined {
            let permission = await host.requestLocationVisitsPermission()
            return .live(enabled: true, authorization: permission.setupAuthorization) ?? .notAllowed
        }
        return await PhoneSetupOutcome(host.enableCoreLocationVisits(activationChoice: choice))
    }

    public func currentOutcome() -> PhoneSetupOutcome? {
        .live(enabled: host.coreLocationVisitsEnabled, authorization: host.locationVisitsPermission.setupAuthorization)
    }
}

extension LocationVisitsPermissionState {
    /// What this permission means for turning Places on, or `nil` before iOS
    /// has asked. Visits are only noticed in the background with Always.
    public var setupAuthorization: MobileSourceAuthorization? {
        switch self {
        case .always: .granted(.full)
        case .whenInUse: .granted(.foregroundOnly)
        case .denied, .restricted: .notAllowed
        case .notDetermined: nil
        }
    }
}
