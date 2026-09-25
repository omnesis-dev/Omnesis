// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
#if canImport(UIKit)
import UIKit
#endif

extension BackgroundRefreshPermissionState {
    /// Background App Refresh as iOS reports it now. Where the setting doesn't
    /// exist, background work is always available.
    @MainActor
    public static var current: BackgroundRefreshPermissionState {
        #if canImport(UIKit)
        switch UIApplication.shared.backgroundRefreshStatus {
        case .available: .available
        case .denied: .denied
        case .restricted: .restricted
        @unknown default: .restricted
        }
        #else
        .available
        #endif
    }
}
