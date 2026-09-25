// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

/// The `briefs` field on `GET /status`. The app decodes the three flags it
/// acts on; the gateway publishes more on the same object for surfaces that
/// can explain the feature rather than navigate to it.
final class BriefsStatusDecodeTests: XCTestCase {
    private func decode(_ json: String) throws -> BriefsStatus {
        try JSONDecoder().decode(BriefsStatus.self, from: Data(json.utf8))
    }

    func testDecodesABlockedGate() throws {
        let status = try decode("""
        {"visible":true,"enabled":true,"modelAssigned":false,"active":false}
        """)
        XCTAssertTrue(status.enabled)
        XCTAssertFalse(status.modelAssigned)
        XCTAssertFalse(status.active)
    }

    func testDecodesARunningGate() throws {
        let status = try decode("""
        {"visible":true,"enabled":true,"modelAssigned":true,"active":true}
        """)
        XCTAssertTrue(status.active)
    }

    /// A gateway that predates `enabled` cannot say whether a missing model is
    /// a fault on this install, so the app treats the feature as switched off.
    /// The menu then shows nothing rather than a warning it cannot justify.
    func testGatewayWithoutTheEnabledFieldReadsAsSwitchedOff() throws {
        let status = try decode("""
        {"visible":true,"modelAssigned":false,"active":false}
        """)
        XCTAssertFalse(status.enabled)
        XCTAssertEqual(BriefsMenuEntry(status: status), .hidden)
    }

    /// The gateway also sends a prose `reason` for the portal and a `visible`
    /// permission for preview surfaces. Fields the app does not read must not
    /// break the decode, or one unread key fails the whole status snapshot.
    func testIgnoresTheFieldsAddressedToOtherSurfaces() throws {
        let status = try decode(
            """
            {"visible":true,"enabled":true,"modelAssigned":false,"active":false,
             "reason":"Anthropic API key not configured."}
            """
        )
        XCTAssertTrue(status.enabled)
        XCTAssertFalse(status.active)
    }
}
