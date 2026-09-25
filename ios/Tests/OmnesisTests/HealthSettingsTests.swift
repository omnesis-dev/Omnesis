// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

final class HealthSettingsTests: XCTestCase {
    private var defaults: DictionaryDefaults!
    private var settings: HealthSettings!

    override func setUp() {
        super.setUp()
        defaults = DictionaryDefaults()
        settings = HealthSettings(defaults: defaults)
    }

    func testDefaultsBeforeAnyWrites() {
        XCTAssertFalse(settings.hasRequestedHealthKitAuthorization)
        XCTAssertEqual(settings.enabledCategories, HealthSettings.defaultEnabledCategories)
    }

    func testHasRequestedRoundTrip() {
        settings.hasRequestedHealthKitAuthorization = true
        // Reload from same defaults — persists correctly.
        let reloaded = HealthSettings(defaults: defaults)
        XCTAssertTrue(reloaded.hasRequestedHealthKitAuthorization)
    }

    func testEnabledCategoriesRoundTrip() {
        settings.enabledCategories = [.body, .activity]
        let reloaded = HealthSettings(defaults: defaults)
        XCTAssertEqual(reloaded.enabledCategories, [.body, .activity])
    }

    func testSetCategoryAddsAndRemoves() {
        // Start from the full default set.
        settings.setCategory(.sleep, enabled: false)
        XCTAssertFalse(settings.enabledCategories.contains(.sleep))

        settings.setCategory(.sleep, enabled: true)
        XCTAssertTrue(settings.enabledCategories.contains(.sleep))
    }

    func testResetClearsEverything() {
        settings.hasRequestedHealthKitAuthorization = true
        settings.enabledCategories = [.vitals]
        settings.reset()

        let reloaded = HealthSettings(defaults: defaults)
        XCTAssertFalse(reloaded.hasRequestedHealthKitAuthorization)
        XCTAssertEqual(reloaded.enabledCategories, HealthSettings.defaultEnabledCategories)
    }

    func testMoodDefaultsToDisabled() {
        // Mental-health self-reports are sensitive enough to require an
        // explicit opt-in beyond the general HealthKit grant (see
        // SettingsView's consent alert) — mood must never be on by
        // default, unlike every other category.
        XCTAssertFalse(HealthSettings.defaultEnabledCategories.contains(.mood))
        XCTAssertFalse(settings.enabledCategories.contains(.mood))
    }

    func testUnknownCategoryStringInDefaultsIsIgnored() {
        // HealthCategory raw values are the DuckDB table names
        // (e.g. "health_body"). Anything else is silently dropped.
        defaults.set(
            ["health_body", "not_a_real_category", "health_vitals"],
            forKey: HealthSettings.Keys.enabledCategories
        )
        XCTAssertEqual(settings.enabledCategories, [.body, .vitals])
    }
}
