// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

final class LocalSourceOwnerRecordTests: XCTestCase {
    func testStateWithNoOwnerOrAnotherOwnerBelongsToAnotherDevice() {
        var record = LocalSourceOwnerRecord(defaults: DictionaryDefaults())

        XCTAssertTrue(record.belongsToAnotherDevice(than: "device-a"), "state no pairing recorded is cleared")
        record.deviceId = "device-a"
        XCTAssertFalse(record.belongsToAnotherDevice(than: "device-a"), "a repair of the same device keeps it")
        XCTAssertTrue(record.belongsToAnotherDevice(than: "device-b"))
    }

    func testTheOwnerIsKeptAcrossLaunchesUntilForgotten() {
        let defaults = DictionaryDefaults()
        var record = LocalSourceOwnerRecord(defaults: defaults)

        record.deviceId = "device-a"
        XCTAssertEqual(LocalSourceOwnerRecord(defaults: defaults).deviceId, "device-a")

        record.deviceId = nil
        XCTAssertNil(LocalSourceOwnerRecord(defaults: defaults).deviceId)
    }
}
