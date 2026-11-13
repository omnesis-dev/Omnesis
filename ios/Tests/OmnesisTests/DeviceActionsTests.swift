// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

/// What a device row offers. A device that joined with the Omnesis account gets the same
/// actions as any other device.
final class DeviceActionsTests: XCTestCase {
    private func device(
        kind: String = "ios",
        revoked: Bool = false,
        online: Bool? = nil,
        enrollment: DeviceEnrollmentInfo? = nil
    )
        -> DeviceRecord {
        DeviceRecord(
            id: "device-1",
            name: "Test phone",
            kind: kind,
            pairedAt: 1,
            revokedAt: revoked ? 2 : nil,
            online: online,
            enrollment: enrollment
        )
    }

    func testAPairedDeviceCanBeRepairedAndRevoked() {
        XCTAssertEqual(
            DeviceActions.menu(for: device(), isThis: false),
            [DeviceMenuItem(action: .repair), DeviceMenuItem(action: .revoke)]
        )
    }

    func testRepairWaitsUntilTheDeviceIsOfflineAndIsNotThisOne() {
        let offered = DeviceMenuItem(action: .repair, enabled: false)
        XCTAssertEqual(DeviceActions.menu(for: device(online: true), isThis: false).first, offered)
        XCTAssertEqual(DeviceActions.menu(for: device(), isThis: true).first, offered)
    }

    func testARevokedDeviceCanBeRepairedOrForgotten() {
        XCTAssertEqual(DeviceActions.menu(for: device(revoked: true), isThis: false).map(\.action), [.repair, .forget])
    }

    func testAPortalSessionIsNeverRepaired() {
        XCTAssertEqual(DeviceActions.menu(for: device(kind: "portal"), isThis: false).map(\.action), [.revoke])
    }

    func testADeviceThatJoinedBySigningInHasNoExtraAction() {
        let joined = device(enrollment: DeviceEnrollmentInfo(method: "automatic", signIn: "google"))
        XCTAssertEqual(DeviceActions.menu(for: joined, isThis: false), DeviceActions.menu(for: device(), isThis: false))
    }

    func testTheWords() {
        XCTAssertEqual(DeviceAction.allCases.map(\.title), ["Repair device", "Revoke device", "Forget device"])
        XCTAssertEqual(DeviceAction.allCases.map(\.destructive), [false, true, true])
    }
}
