// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

public enum AppleHealthPermissionHealth {
    public static func report(
        backgroundRefresh: BackgroundRefreshPermissionState,
        checkedAt: Date = Date()
    )
        -> SourcePermissionHealthReport {
        let backgroundRemediation: String? = switch backgroundRefresh {
        case .available: nil
        case .denied: "Turn on Background App Refresh for Omnesis in iOS Settings."
        case .restricted: "Background App Refresh is restricted by this device's policy."
        }
        return SourcePermissionHealthReport(
            sourceId: "apple-health:local",
            displayName: "Apple Health",
            checkedAt: checkedAt,
            capabilities: [
                SourcePermissionCapability(
                    id: "health-read",
                    state: .unknown,
                    requirement: .required,
                    label: "Apple Health read access",
                    impact: "iOS does not reveal whether individual Health read permissions were denied.",
                    remediation: "Re-run the Health permission prompt from Omnesis Settings if data is missing.",
                    repairAction: .openSourceSettings
                ),
                SourcePermissionCapability(
                    id: "background-refresh",
                    state: backgroundRefresh == .available
                        ? .healthy
                        : (backgroundRefresh == .denied ? .backgroundAccessMissing : .unavailable),
                    requirement: .required,
                    label: "Background App Refresh",
                    impact: backgroundRefresh == .available
                        ? "Apple Health can sync while Omnesis is in the background."
                        : "Apple Health will only catch up while Omnesis is open.",
                    remediation: backgroundRemediation,
                    repairAction: backgroundRefresh == .denied ? .openAppSettings : .none
                ),
            ]
        )
    }
}
