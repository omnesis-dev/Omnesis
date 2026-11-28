// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import DesktopCore
import Foundation
@testable import OmnesisDesktop
import SwiftUI
import XCTest

@MainActor
final class DesktopMacServerGuidanceTests: XCTestCase {
    func testSetupShowsHostPowerGuidanceOnlyForTheMacKeepingTheLibrary() async throws {
        for (powerName, powerStatus) in [("configured", DesktopMacServerPowerObservation.Status.ready), ("needs-setup", .sleepEnabled)] {
            for role in ["home", "joined"] {
                let store = DesktopStore(
                    startRuntime: false,
                    automaticStartup: DesktopAutomaticStartup(
                        read: { .enabled },
                        register: {},
                        attempted: { _ in true },
                        remember: { _ in }
                    ),
                    serverPower: DesktopMacServerPowerFlow(probe: { DesktopMacServerPowerObservation(status: powerStatus) })
                )
                store.state = try JSONDecoder().decode(
                    DesktopState.self, from: Data(#"{"phase":"ready","mode":"\#(role)","encrypted":true}"#.utf8)
                )
                try await DesktopSnapshotRenderer.render(
                    DesktopSetupChecklist(loadStatus: false).environment(store),
                    name: "mac-server-setup-\(role)-\(powerName)", size: CGSize(width: 900, height: 720)
                ) { view in
                    let offersGuide = try DesktopAccessibilityDriver.elements(in: view)
                        .contains { $0.accessibilityIdentifier() == "mac-server-steps" }
                    XCTAssertEqual(offersGuide, role == "home")
                }
            }
        }
    }

    func testHostHelpRendersSeparateDesktopAndPoweredLaptopStepsWithoutAConfigurationClaim() async throws {
        try await DesktopSnapshotRenderer.render(
            DesktopMacServerGuidanceView(), name: "mac-server-guide", size: CGSize(width: 600, height: 560)
        ) { view in
            XCTAssertTrue(try DesktopAccessibilityDriver.contains("On a desktop Mac", in: view))
            XCTAssertTrue(try DesktopAccessibilityDriver.contains("On a MacBook", in: view))
            XCTAssertNotNil(try DesktopAccessibilityDriver.element("mac-server-apple-guide", in: view))
            XCTAssertNotNil(try DesktopAccessibilityDriver.element("mac-server-open-settings", in: view))
        }
    }
}
