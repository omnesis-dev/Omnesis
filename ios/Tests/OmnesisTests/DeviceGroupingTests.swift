// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

/// Pure-logic coverage for the Devices screen grouping + status rules. Runs in
/// the sim-less logic lane (`scripts/ios-logic.sh`).
final class DeviceGroupingTests: XCTestCase {
    func testAgentPairKindIsOfferedWithoutExperimentalMode() {
        XCTAssertEqual(
            DeviceKindMeta.pairKinds,
            ["collector", "cli", "portal", "ios", "android", "agent", "browser"]
        )
    }

    func testAgentPairResultUsesOnlySupportedHarnessConnectCommands() {
        XCTAssertEqual(
            agentConnectCommands(
                gatewayURL: "https://gateway.example:7600/",
                pairingCode: "FICTION-2486"
            ),
            [
                "omnesis connect openclaw --gateway-url https://gateway.example:7600 --code FICTION-2486",
                "omnesis connect hermes --gateway-url https://gateway.example:7600 --code FICTION-2486",
            ]
        )
        XCTAssertFalse(
            agentConnectCommands(gatewayURL: nil, pairingCode: "FICTION-2486")
                .joined(separator: "\n")
                .contains("devices pair")
        )
    }

    func testAgentPairResultUsesSelectedAdvertisedIdentityWithoutLosingSchemeOrPort() {
        XCTAssertEqual(
            agentGatewayURL(
                gatewayOrigin: URL(string: "https://gateway.example:17600"),
                identityAddresses: ["192.0.2.42", "gateway.tail.example"],
                selectedIndex: 1
            ),
            "https://gateway.tail.example:17600"
        )
        XCTAssertEqual(
            agentGatewayURL(
                gatewayOrigin: URL(string: "https://gateway.example:17600"),
                identityAddresses: [],
                selectedIndex: 0
            ),
            "https://gateway.example:17600"
        )
    }

    private func device(_ id: String, online: Bool, lastSeenAt: Int64?) -> DeviceRecord {
        DeviceRecord(
            id: id,
            name: id,
            kind: "cli",
            pairedAt: 1000,
            lastSeenAt: lastSeenAt,
            capabilities: nil,
            online: online
        )
    }

    func testPinsThisDeviceAndSplitsTheRest() {
        let devices = [
            device("cli", online: false, lastSeenAt: 100),
            device("collector", online: true, lastSeenAt: 900),
            device("phone", online: false, lastSeenAt: 500),
            device("portal", online: false, lastSeenAt: 950),
        ]
        let grouped = DeviceGrouping.group(devices, thisDeviceId: "portal")
        XCTAssertEqual(grouped.thisDevice?.id, "portal")
        XCTAssertEqual(grouped.live.map(\.id), ["collector"])
        // other sorted most-recently-active first
        XCTAssertEqual(grouped.other.map(\.id), ["phone", "cli"])
    }

    func testPinsCurrentDeviceEvenWhenOffline() {
        let devices = [
            device("cli", online: false, lastSeenAt: 100),
            device("collector", online: true, lastSeenAt: 900),
        ]
        let grouped = DeviceGrouping.group(devices, thisDeviceId: "cli")
        XCTAssertEqual(grouped.thisDevice?.id, "cli")
        XCTAssertEqual(grouped.live.map(\.id), ["collector"])
        XCTAssertTrue(grouped.other.isEmpty)
    }

    func testNoThisDeviceMatchLeavesItNil() {
        let devices = [device("a", online: true, lastSeenAt: 1), device("b", online: false, lastSeenAt: 1)]
        let grouped = DeviceGrouping.group(devices, thisDeviceId: nil)
        XCTAssertNil(grouped.thisDevice)
        XCTAssertEqual(grouped.live.count, 1)
        XCTAssertEqual(grouped.other.count, 1)
    }

    func testStatusLine() {
        XCTAssertEqual(
            DeviceGrouping.statusLine(
                device("x", online: false, lastSeenAt: nil),
                isCurrent: true
            ),
            "Active now"
        )
        XCTAssertEqual(
            DeviceGrouping.statusLine(device("x", online: true, lastSeenAt: 1)),
            "Live connection"
        )
        XCTAssertTrue(
            DeviceGrouping.statusLine(device("x", online: false, lastSeenAt: 1))
                .hasPrefix("Last active ")
        )
        XCTAssertEqual(
            DeviceGrouping.statusLine(device("x", online: false, lastSeenAt: nil)),
            "No activity recorded"
        )
    }

    private func revoked(_ id: String, online: Bool, lastSeenAt: Int64?) -> DeviceRecord {
        DeviceRecord(
            id: id,
            name: id,
            kind: "ios",
            pairedAt: 1000,
            lastSeenAt: lastSeenAt,
            revokedAt: 5000,
            capabilities: nil,
            online: online
        )
    }

    func testRevokedBeatsOnlineAndSortsLast() {
        let devices = [
            revoked("gone-but-draining", online: true, lastSeenAt: 999),
            device("collector", online: true, lastSeenAt: 900),
            revoked("gone", online: false, lastSeenAt: 800),
            device("cli", online: false, lastSeenAt: 100),
        ]
        let grouped = DeviceGrouping.group(devices, thisDeviceId: nil)
        XCTAssertEqual(grouped.live.map(\.id), ["collector"])
        XCTAssertEqual(grouped.other.map(\.id), ["cli", "gone-but-draining", "gone"])
    }

    func testRevokedStatusLineBeatsEverythingElse() {
        let line = DeviceGrouping.statusLine(revoked("x", online: true, lastSeenAt: 1), isCurrent: true)
        XCTAssertTrue(line.hasPrefix("Revoked "), line)
    }

    func testRevokedCountAndLiveCountExcludeEachOther() {
        let devices = [
            revoked("gone-but-draining", online: true, lastSeenAt: 1),
            device("collector", online: true, lastSeenAt: 1),
            revoked("gone", online: false, lastSeenAt: nil),
        ]
        XCTAssertEqual(DeviceGrouping.liveConnectionCount(devices), 1)
        XCTAssertEqual(DeviceGrouping.revokedCount(devices), 2)
    }

    func testLiveConnectionCountUsesOnlyWebSocketPresence() {
        let devices = [
            device("portal", online: false, lastSeenAt: nil),
            device("collector", online: true, lastSeenAt: 1),
        ]
        XCTAssertEqual(DeviceGrouping.liveConnectionCount(devices), 1)
    }
}
