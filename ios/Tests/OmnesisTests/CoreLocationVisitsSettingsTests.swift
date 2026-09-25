// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

final class CoreLocationVisitsSettingsTests: XCTestCase {
    private var defaults: DictionaryDefaults!
    private var settings: CoreLocationVisitsSettings!

    override func setUp() {
        super.setUp()
        defaults = DictionaryDefaults()
        settings = CoreLocationVisitsSettings(defaults: defaults)
    }

    func testDefaultsToDisabled() {
        XCTAssertFalse(settings.enabled)
    }

    func testEnabledRoundTrips() {
        settings.enabled = true
        XCTAssertTrue(CoreLocationVisitsSettings(defaults: defaults).enabled)
    }

    func testResetClearsTheFlag() {
        settings.enabled = true
        settings.reset()
        XCTAssertFalse(CoreLocationVisitsSettings(defaults: defaults).enabled)
    }
}
