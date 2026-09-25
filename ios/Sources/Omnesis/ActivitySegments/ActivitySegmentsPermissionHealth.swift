// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

public enum ActivitySegmentsPermissionState: Sendable, Equatable {
    case notDetermined, authorized, denied, restricted, unavailable
}

public enum ActivitySegmentsPermissionHealth {
    // The explicit state matrix is easier to audit than nested permission helpers.
    // swiftlint:disable:next cyclomatic_complexity
    public static func report(
        state: ActivitySegmentsPermissionState,
        backgroundRefresh: BackgroundRefreshPermissionState,
        checkedAt: Date = Date()
    )
        -> SourcePermissionHealthReport {
        let permissionStatus: SourcePermissionHealthStatus = switch state {
        case .authorized: .healthy
        case .denied: .permissionDegraded
        case .restricted, .unavailable: .unavailable
        case .notDetermined: .unknown
        }
        let permissionImpact: String? = switch state {
        case .authorized: nil
        case .denied: "Walking, running, cycling, and driving segments have stopped syncing."
        case .restricted: "Motion & Fitness access is restricted by this device's policy."
        case .unavailable: "This device cannot provide Motion & Fitness history."
        case .notDetermined: nil
        }
        let permissionRemediation: String? = switch state {
        case .denied: "Allow Motion & Fitness access for Omnesis in iOS Settings."
        case .restricted: "Check device restrictions or ask the device administrator."
        case .unavailable: "No permission change can enable this capability on this device."
        case .authorized, .notDetermined: nil
        }
        let backgroundRemediation: String? = switch backgroundRefresh {
        case .available: nil
        case .denied: "Turn on Background App Refresh for Omnesis in iOS Settings."
        case .restricted: "Background App Refresh is restricted by this device's policy."
        }
        return SourcePermissionHealthReport(
            sourceId: "activity-segments:local",
            displayName: "Activity Segments",
            checkedAt: checkedAt,
            capabilities: [
                SourcePermissionCapability(
                    id: "motion-fitness",
                    state: permissionStatus,
                    requirement: .required,
                    label: "Motion & Fitness access",
                    impact: permissionImpact,
                    remediation: permissionRemediation,
                    repairAction: state == .denied ? .openAppSettings : .none
                ),
                SourcePermissionCapability(
                    id: "background-refresh",
                    state: backgroundRefresh == .available
                        ? .healthy
                        : (backgroundRefresh == .denied ? .backgroundAccessMissing : .unavailable),
                    requirement: .required,
                    label: "Background App Refresh",
                    impact: backgroundRefresh == .available
                        ? "Activity Segments can refresh in the background."
                        : "Activity Segments will only catch up while Omnesis is open.",
                    remediation: backgroundRemediation,
                    repairAction: backgroundRefresh == .denied ? .openAppSettings : .none
                ),
            ]
        )
    }
}
