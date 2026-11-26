// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import AppKit
import Foundation

/// Navigation only. Opening Settings provides no evidence that access was granted.
@MainActor
public enum DesktopPermissionSettings {
    public enum Category: String, Sendable {
        case fullDiskAccess
        case privacySecurity
    }

    public enum NavigationResult: Equatable, Sendable {
        case requestedCategoryOpened
        case privacySettingsOpened
        case unavailable
    }

    public static func open(_ category: Category) -> NavigationResult {
        navigate(category, open: { NSWorkspace.shared.open($0) })
    }

    static func navigate(_ category: Category, open: (URL) -> Bool) -> NavigationResult {
        // Apple's EndpointSecurity header documents this navigation URL. We do
        // not call EndpointSecurity or use its entitlement as an FDA preflight.
        let privacy = URL(string: "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension")!
        if category == .fullDiskAccess {
            let fullDisk = URL(string: "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_AllFiles")!
            if open(fullDisk) { return .requestedCategoryOpened }
            return open(privacy) ? .privacySettingsOpened : .unavailable
        }
        return open(privacy) ? .requestedCategoryOpened : .unavailable
    }
}
