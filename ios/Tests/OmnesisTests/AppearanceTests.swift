// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
@testable import Omnesis
import SwiftUI
import XCTest

/// Pins the appearance contract. Most of `AppearanceStore` is exercised
/// visually through the previews/snapshots, but two pieces earn a direct
/// unit test: the mode → `ColorScheme` mapping, and
/// `forLaunchEnvironment()` — the seam the demo recorder uses to force a
/// colour scheme (`DEMO_APPEARANCE`) so the landing-page demos can be
/// captured in both light and dark. A regression there silently breaks
/// future recordings, so it's checked here rather than only end-to-end.
@available(iOS 17.0, *)
final class AppearanceTests: XCTestCase {
    func testColorSchemeMapping() {
        XCTAssertNil(AppearanceMode.system.colorScheme)
        XCTAssertEqual(AppearanceMode.light.colorScheme, .light)
        XCTAssertEqual(AppearanceMode.dark.colorScheme, .dark)
    }

    func testInitWithModeForcesThatMode() {
        XCTAssertEqual(AppearanceStore(mode: .light).mode, .light)
        XCTAssertEqual(AppearanceStore(mode: .dark).mode, .dark)
    }

    func testForLaunchEnvironmentHonoursDemoAppearance() {
        setenv("DEMO_APPEARANCE", "light", 1)
        defer { unsetenv("DEMO_APPEARANCE") }
        XCTAssertEqual(AppearanceStore.forLaunchEnvironment().mode, .light)

        // Case-insensitive — the recording script may pass either case.
        setenv("DEMO_APPEARANCE", "DARK", 1)
        XCTAssertEqual(AppearanceStore.forLaunchEnvironment().mode, .dark)
    }

    func testForLaunchEnvironmentIgnoresUnknownValue() {
        setenv("DEMO_APPEARANCE", "rainbow", 1)
        defer { unsetenv("DEMO_APPEARANCE") }
        // An unrecognised value is dropped: the store falls back to the
        // persisted preference, identical to a plain launch.
        XCTAssertEqual(AppearanceStore.forLaunchEnvironment().mode, AppearanceStore().mode)
    }
}
