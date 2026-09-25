// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
#if canImport(CoreMotion) && os(iOS)
import CoreMotion

/// Motion & Fitness permission for Movement. Core Motion has no request API:
/// iOS shows its prompt the first time an app queries activity, so asking is
/// a one-minute query whose completion arrives once the user has answered.
@available(iOS 17.0, *)
@MainActor
public enum MotionAuthorization {
    public static var current: ActivitySegmentsPermissionState {
        guard CoreMotionActivityProvider.isAvailable else { return .unavailable }
        return switch CoreMotionActivityProvider.authorizationStatus() {
        case .notDetermined: .notDetermined
        case .restricted: .restricted
        case .denied: .denied
        case .authorized: .authorized
        @unknown default: .restricted
        }
    }

    /// Shows the Motion & Fitness prompt if iOS has not asked yet, and
    /// returns the permission once the user has answered.
    public static func request() async -> ActivitySegmentsPermissionState {
        guard current == .notDetermined else { return current }
        let manager = CMMotionActivityManager()
        let now = Date()
        await SystemPromptActivity.shared.during(true) {
            await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
                manager.queryActivityStarting(from: now.addingTimeInterval(-60), to: now, to: .main) { _, _ in
                    // The prompt belongs to the manager, so it must outlive the query.
                    withExtendedLifetime(manager) { continuation.resume() }
                }
            }
        }
        return current
    }
}
#endif
