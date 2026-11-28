// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import DesktopCore
import XCTest

final class MacServerGuidanceTests: XCTestCase {
    func testEnergyPaneMatchesSupportedMacOSNames() {
        XCTAssertEqual(DesktopMacServerGuidance.desktopEnergyPane(macOSMajorVersion: 14), "Energy Saver")
        XCTAssertEqual(DesktopMacServerGuidance.desktopEnergyPane(macOSMajorVersion: 15), "Energy")
        XCTAssertEqual(DesktopMacServerGuidance.desktopEnergyPane(macOSMajorVersion: 26), "Energy")
    }
}
