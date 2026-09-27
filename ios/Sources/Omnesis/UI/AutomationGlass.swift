// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// Whether the app draws its Liquid Glass chrome.
///
/// XCUITest waits for an app to report its animations idle before every tap
/// and keystroke, and a screen carrying iOS 26 glass never reports idle: each
/// interaction then stalls for XCTest's full minute. UI automation launched
/// with `DEMO_PLAIN_GLASS=1` draws the translucent material the app uses
/// before iOS 26 instead, the same layout with no glass effect. Release builds
/// always draw glass.
enum AutomationGlass {
    #if DEBUG
    static let enabled = ProcessInfo.processInfo.environment["DEMO_PLAIN_GLASS"] != "1"
    #else
    static let enabled = true
    #endif
}
