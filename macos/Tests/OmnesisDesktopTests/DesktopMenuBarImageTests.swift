// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import AppKit
@testable import OmnesisDesktop
import XCTest

@MainActor
final class DesktopMenuBarImageTests: XCTestCase {
    func testMenuImageNamesTheApplicationAndPreservesTheSharedBrandAsset() throws {
        let asset = try XCTUnwrap(Bundle.main.image(forResource: NSImage.Name("OmnesisMenuMark")))
        let description = asset.accessibilityDescription
        let image = try XCTUnwrap(DesktopMenuBarImage.make())
        XCTAssertFalse(image === asset)
        XCTAssertEqual(image.accessibilityDescription, "Omnesis")
        XCTAssertTrue(image.isTemplate)
        XCTAssertGreaterThan(image.size.width, 0)
        XCTAssertGreaterThan(image.size.height, 0)
        XCTAssertEqual(asset.accessibilityDescription, description)
    }
}
