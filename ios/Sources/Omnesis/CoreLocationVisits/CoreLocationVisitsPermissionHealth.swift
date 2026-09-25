// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

public enum LocationVisitsPermissionState: Sendable, Equatable {
    case notDetermined, always, whenInUse, denied, restricted
}

public enum CoreLocationVisitsPermissionHealth {
    public static func report(
        state: LocationVisitsPermissionState,
        precise: Bool,
        checkedAt: Date = Date()
    )
        -> SourcePermissionHealthReport {
        let required = switch state {
        case .always:
            SourcePermissionCapability(
                id: "background-location",
                state: .healthy,
                requirement: .required,
                label: "Always Allow location",
                impact: "Location Visits can record stays in the background.",
                remediation: "No action is needed.",
                repairAction: .none
            )
        case .whenInUse:
            SourcePermissionCapability(
                id: "background-location",
                state: .backgroundAccessMissing,
                requirement: .required,
                label: "Always Allow location",
                impact: "Visits are not recorded reliably after you leave Omnesis.",
                remediation: "Choose Always for Location access in iOS Settings.",
                repairAction: .openAppSettings
            )
        case .denied:
            SourcePermissionCapability(
                id: "background-location",
                state: .permissionDegraded,
                requirement: .required,
                label: "Location access",
                impact: "Location Visits have stopped recording places.",
                remediation: "Allow Always location access for Omnesis in iOS Settings.",
                repairAction: .openAppSettings
            )
        case .restricted:
            SourcePermissionCapability(
                id: "background-location",
                state: .unavailable,
                requirement: .required,
                label: "Location access",
                impact: "Location access is restricted by this device's policy.",
                remediation: "Check Screen Time or ask the device administrator about location restrictions.",
                repairAction: .none
            )
        case .notDetermined:
            SourcePermissionCapability(
                id: "background-location",
                state: .unknown,
                requirement: .required,
                label: "Location access",
                impact: "Location access has not been decided yet.",
                remediation: "Complete the iOS location prompt.",
                repairAction: .none
            )
        }
        let hasUsableLocation = state == .always || state == .whenInUse
        let accuracy = SourcePermissionCapability(
            id: "precise-location",
            state: hasUsableLocation ? (precise ? .healthy : .permissionDegraded) : .unknown,
            requirement: .optional,
            label: "Precise Location",
            impact: hasUsableLocation
                ? (precise
                    ? "Place names can be resolved accurately on this phone."
                    : "Visit place names and stored coordinates may be less accurate.")
                : "Precise Location cannot be evaluated until location access is available.",
            remediation: hasUsableLocation && !precise
                ? "Turn on Precise Location for Omnesis in iOS Settings." : nil,
            repairAction: hasUsableLocation && !precise ? .openAppSettings : .none
        )
        return SourcePermissionHealthReport(
            sourceId: "core-location-visits:local",
            displayName: "Location Visits",
            checkedAt: checkedAt,
            capabilities: [required, accuracy]
        )
    }
}
