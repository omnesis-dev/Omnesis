// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

final class ActivitySegmentsSettingsTests: XCTestCase {
    private var defaults: DictionaryDefaults!
    private var settings: ActivitySegmentsSettings!

    override func setUp() {
        super.setUp()
        defaults = DictionaryDefaults()
        settings = ActivitySegmentsSettings(defaults: defaults)
    }

    func testDefaultsToDisabled() {
        XCTAssertFalse(settings.enabled)
    }

    func testEnabledRoundTrips() {
        settings.enabled = true
        let reloaded = ActivitySegmentsSettings(defaults: defaults)
        XCTAssertTrue(reloaded.enabled)
    }

    func testResetClearsTheFlag() {
        settings.enabled = true
        settings.reset()
        let reloaded = ActivitySegmentsSettings(defaults: defaults)
        XCTAssertFalse(reloaded.enabled)
    }
}
