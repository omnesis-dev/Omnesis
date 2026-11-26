// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
@testable import OmnesisDesktop
import XCTest

final class DesktopSourceActionPolicyTests: XCTestCase {
    func testExplicitEmptyMembershipAndHistoricalOriginsNeverBecomeHosts() throws {
        let source = try decode(
            DesktopSource.self,
            #"{"id":"fixture-source","type":"invented","accountId":"example","enabled":false,"deviceId":"previous","members":[],"archived":true,"archivedDevices":[{"deviceId":"previous","name":"Previous computer","kind":"collector","forgottenAt":1}]}"#
        )
        let policy = try DesktopSourceActionPolicy(source: source, devices: roster())
        XCTAssertTrue(policy.historical)
        XCTAssertTrue(policy.members.isEmpty)
        XCTAssertFalse(policy.canResume)
        XCTAssertFalse(policy.canSync)
        XCTAssertFalse(policy.canRepair("previous"))
        XCTAssertEqual(source.archivedDevices?.first?.name, "Previous computer")
    }

    func testHealthySiblingRemainsEligibleBesideDormantAndArchivedOrigins() throws {
        let source = try decode(
            DesktopSource.self,
            #"{"id":"fixture-source","type":"invented","accountId":"example","enabled":true,"deviceId":"previous","members":["previous","local","other"],"dormantHosts":["other"],"archivedDevices":[{"deviceId":"previous","name":"Previous computer","kind":"collector","forgottenAt":1}]}"#
        )
        let policy = try DesktopSourceActionPolicy(source: source, devices: roster())
        XCTAssertFalse(policy.historical)
        XCTAssertEqual(policy.members, ["local", "other"])
        XCTAssertEqual(policy.eligibleMembers, ["local"])
        XCTAssertTrue(policy.canSync)
        XCTAssertFalse(policy.canRepair("other"))
        XCTAssertFalse(policy.canRepair("previous"))
    }

    func testOlderGatewayMissingMembershipFallsBackButEmptyAndMissingRosterFailClosed() throws {
        let old = try decode(
            DesktopSource.self,
            #"{"id":"fixture-source","type":"invented","accountId":"example","enabled":true,"deviceId":"local"}"#
        )
        XCTAssertEqual(try DesktopSourceActionPolicy(source: old, devices: roster()).eligibleMembers, ["local"])
        XCTAssertFalse(DesktopSourceActionPolicy(source: old, devices: []).canResume)
        let empty = try decode(
            DesktopSource.self,
            #"{"id":"fixture-source","type":"invented","accountId":"example","enabled":true,"deviceId":"local","members":[]}"#
        )
        XCTAssertTrue(try DesktopSourceActionPolicy(source: empty, devices: roster()).members.isEmpty)
        XCTAssertFalse(try DesktopSourceActionPolicy(source: empty, devices: roster()).canSync)
    }

    func testRevokedAndNeedsPairingAreSeparateFromOffline() throws {
        let source = try decode(
            DesktopSource.self,
            #"{"id":"fixture-source","type":"invented","accountId":"example","enabled":true,"deviceId":"local","members":["local","other","revoked"]}"#
        )
        let devices = try decode(
            [DesktopDevice].self,
            #"[{"id":"local","name":"This computer","kind":"collector","online":false},{"id":"other","name":"Other computer","kind":"collector","needsPairing":true},{"id":"revoked","name":"Previous computer","kind":"collector","revokedAt":1}]"#
        )
        XCTAssertEqual(DesktopSourceActionPolicy(source: source, devices: devices).eligibleMembers, ["local"])
    }

    private func roster() throws -> [DesktopDevice] {
        try decode(
            [DesktopDevice].self,
            #"[{"id":"local","name":"This computer","kind":"collector"},{"id":"other","name":"Other computer","kind":"collector"},{"id":"previous","name":"Previous computer","kind":"collector"}]"#
        )
    }

    private func decode<T: Decodable>(_ type: T.Type, _ text: String) throws -> T {
        try JSONDecoder().decode(type, from: Data(text.utf8))
    }
}
