// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

final class PhotosSettingsTests: XCTestCase {
    func testOnlyNonFullToFullAdvancesAccessEpoch() {
        let defaults = DictionaryDefaults()
        let settings = PhotosSettings(defaults: defaults)

        XCTAssertFalse(settings.observeAccess(.limited))
        XCTAssertEqual(settings.accessEpoch, 0)
        XCTAssertFalse(settings.observeAccess(.denied))
        XCTAssertEqual(settings.accessEpoch, 0)
        XCTAssertTrue(settings.observeAccess(.full))
        XCTAssertEqual(settings.accessEpoch, 1)
        XCTAssertFalse(settings.observeAccess(.full))
        XCTAssertEqual(settings.accessEpoch, 1)
    }

    func testFirstObservedFullAdvancesEpochForLegacySteadyCursor() {
        let settings = PhotosSettings(defaults: DictionaryDefaults())

        XCTAssertNil(settings.lastAccessState)
        XCTAssertTrue(settings.observeAccess(.full))
        XCTAssertEqual(settings.accessEpoch, 1)
        XCTAssertEqual(settings.lastAccessState, .full)
    }

    func testDisableAndReenableAdvanceReplayEpochWithoutChangingPermissions() {
        let settings = PhotosSettings(defaults: DictionaryDefaults())
        XCTAssertTrue(settings.observeAccess(.full))
        XCTAssertEqual(settings.accessEpoch, 1)

        settings.enable()
        let firstEpoch = settings.accessEpoch
        settings.recordReconcile(.performed)
        settings.disable()
        settings.enable()

        XCTAssertEqual(settings.accessEpoch, firstEpoch + 1)
        XCTAssertNil(settings.lastReconcileAt)
        XCTAssertEqual(settings.lastAccessState, .full)
        XCTAssertFalse(settings.observeAccess(.full))
        XCTAssertEqual(settings.accessEpoch, firstEpoch + 1)
        settings.enable()
        XCTAssertEqual(settings.accessEpoch, firstEpoch + 1, "an already-enabled source must retain backfill progress")
    }

    func testReenableWithLimitedPermissionStillStartsAFreshReplayEpoch() {
        let settings = PhotosSettings(defaults: DictionaryDefaults())
        settings.observeAccess(.limited)
        settings.enable()
        let epoch = settings.accessEpoch
        settings.disable()
        settings.enable()
        XCTAssertEqual(settings.accessEpoch, epoch + 1)
        XCTAssertEqual(settings.lastAccessState, .limited)
    }

    func testResetPreservesEpochUsedByPersistentAssetIndex() {
        let settings = PhotosSettings(defaults: DictionaryDefaults())
        XCTAssertTrue(settings.observeAccess(.full))
        XCTAssertFalse(settings.observeAccess(.denied))
        XCTAssertTrue(settings.observeAccess(.full))
        XCTAssertEqual(settings.accessEpoch, 2)

        settings.reset()

        XCTAssertEqual(settings.accessEpoch, 2)
        XCTAssertNil(settings.lastAccessState)
        XCTAssertTrue(settings.observeAccess(.full))
        XCTAssertEqual(settings.accessEpoch, 3)
    }

    func testSkippedReconcileDoesNotAdvanceSchedule() {
        let settings = PhotosSettings(defaults: DictionaryDefaults())
        let now = Date()
        settings.recordReconcile(.skippedIncompleteAccess(.limited), at: now)
        XCTAssertNil(settings.lastReconcileAt)
        settings.recordReconcile(.performed, at: now)
        let recorded = settings.lastReconcileAt
        XCTAssertNotNil(recorded)
        XCTAssertEqual(recorded?.timeIntervalSince1970 ?? 0, now.timeIntervalSince1970, accuracy: 1)
    }
}
