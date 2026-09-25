// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

public enum PhotosPermissionHealth {
    public static func report(
        access: PhotosAccessState,
        backgroundRefresh: BackgroundRefreshPermissionState,
        checkedAt: Date = Date()
    )
        -> SourcePermissionHealthReport {
        let status: SourcePermissionHealthStatus = switch access {
        case .full: .healthy
        case .limited, .denied: .permissionDegraded
        case .restricted: .unavailable
        case .notDetermined: .unknown
        }
        let impact = switch access {
        case .full: "Omnesis can read the complete photo library."
        case .limited: "Only selected photos are syncing; the rest of the library is missing from search."
        case .denied: "New photos and screenshots have stopped syncing."
        case .restricted: "This device currently prevents Omnesis from reading Photos."
        case .notDetermined: "Photos access has not been decided yet."
        }
        let remediation: String? = switch access {
        case .limited, .denied: "Allow Full Access to Photos in iOS Settings."
        case .restricted: "Check Screen Time or device-management restrictions for Photos access."
        case .full, .notDetermined: nil
        }
        let backgroundRemediation: String? = switch backgroundRefresh {
        case .available: nil
        case .denied: "Turn on Background App Refresh for Omnesis in iOS Settings."
        case .restricted: "Background App Refresh is restricted by this device's policy."
        }
        return SourcePermissionHealthReport(
            sourceId: "photos:local",
            displayName: "Photos",
            checkedAt: checkedAt,
            capabilities: [
                SourcePermissionCapability(
                    id: "photo-library",
                    state: status,
                    requirement: .required,
                    label: "Photos access",
                    impact: impact,
                    remediation: remediation,
                    repairAction: access == .limited || access == .denied ? .openAppSettings : .none,
                    // A selected library is the user's choice; Settings offers
                    // to add more photos instead of flagging it.
                    presentation: access == .limited ? .informational : .attention
                ),
                SourcePermissionCapability(
                    id: "background-refresh",
                    state: backgroundRefresh == .available
                        ? .healthy
                        : (backgroundRefresh == .denied ? .backgroundAccessMissing : .unavailable),
                    requirement: .required,
                    label: "Background App Refresh",
                    impact: backgroundRefresh == .available
                        ? "Photos can refresh while Omnesis is in the background."
                        : "Photos will only catch up while Omnesis is open.",
                    remediation: backgroundRemediation,
                    repairAction: backgroundRefresh == .denied ? .openAppSettings : .none
                ),
            ]
        )
    }
}
