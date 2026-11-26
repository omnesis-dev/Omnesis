// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import DesktopCore
import Foundation
@testable import OmnesisDesktop
import XCTest

@MainActor
final class DesktopSourceHealthTests: XCTestCase {
    func testAuthoritativeCollectionStatesNeverTreatEnabledAsSuccessful() throws {
        for (state, title) in [
            ("idle", "Waiting for first sync"), ("syncing", "Collecting information"),
            ("synced", "Last sync complete"), ("needs-auth", "Sign-in needed"),
            ("error", "Needs attention"), ("paused", "Paused"), ("future-state", "Status unavailable"),
        ] {
            let status = try health(#"{"sourceId":"invented:example","state":"\#(state)","lastSyncAt":null}"#)
            XCTAssertEqual(status.title, title)
            XCTAssertNil(status.lastSyncDate)
        }
    }

    func testProgressUsesRealFiniteCountsAndRejectsInvalidRanges() throws {
        let status = try health(#"{"sourceId":"invented:example","state":"syncing","progress":{"processed":3,"total":12}}"#)
        XCTAssertEqual(status.progress?.fraction, 0.25)
        let invalid =
            try health(#"{"sourceId":"invented:example","state":"syncing","progress":{"percentComplete":150,"processed":13,"total":12}}"#)
        XCTAssertNil(invalid.progress?.fraction)
        let unknown = try health(#"{"sourceId":"invented:example","state":"syncing","progress":{"message":"Reading available items"}}"#)
        XCTAssertNil(unknown.progress?.fraction)
        XCTAssertEqual(unknown.progress?.message, "Reading available items")
    }

    func testNoticesAndRemediesStayOnTheirReportingDevice() throws {
        let status =
            try health(
                #"{"sourceId":"invented:example","state":"synced","members":[{"sourceId":"invented:example","deviceId":"first","state":"synced","notices":[]},{"sourceId":"invented:example","deviceId":"second","state":"needs-auth","notices":[{"kind":"needs-auth","severity":"error","title":"Sign in again","steps":["Open Omnesis on this device."]}]}]}"#
            )
        XCTAssertTrue(status.displayNotices.isEmpty)
        XCTAssertFalse(try XCTUnwrap(status.members?.first).needsSignIn)
        let second = try XCTUnwrap(status.members?.last)
        XCTAssertTrue(second.needsSignIn)
        XCTAssertEqual(second.deviceId, "second")
        XCTAssertEqual(second.displayNotices.first?.steps, ["Open Omnesis on this device."])
    }

    func testOlderGatewayRemediationRemainsReadableWithoutInventedProviderActions() throws {
        let status =
            try health(
                #"{"sourceId":"invented:example","state":"error","remediation":{"summary":"Folder access is required","steps":["Choose the folder again."],"restartRequired":false}}"#
            )
        XCTAssertEqual(status.displayNotices.first?.title, "Folder access is required")
        XCTAssertEqual(status.displayNotices.first?.steps, ["Choose the folder again."])
        let recovered = try health(#"{"sourceId":"invented:example","state":"synced","notices":[],"errorMessage":"An older report"}"#)
        XCTAssertTrue(recovered.displayNotices.isEmpty)
    }

    func testUnavailableExplicitSignInHostNeverFallsBackToAnotherDevice() async throws {
        let descriptor = try JSONDecoder().decode(
            DesktopDescriptor.self,
            from: Data(
                #"{"id":"invented","name":"Invented","description":"Fictional provider","hasAuthFlow":true,"hasDiscover":false,"devices":[{"id":"local","name":"This Mac"}]}"#
                    .utf8
            )
        )
        let connection = try JSONDecoder().decode(
            DesktopConnection.self,
            from: Data(#"{"url":"https://source-health.example.test","token":"invented-token","collectorDeviceId":"local"}"#.utf8)
        )
        let session = URLSession(configuration: .ephemeral)
        defer { session.invalidateAndCancel() }
        let api = try DesktopAPI(connection: connection, sessionOverride: session)
        let flow = DesktopSourceFlow(descriptor: descriptor, api: api, accountId: "example-account", hostId: "unavailable-member")
        XCTAssertEqual(flow.deviceId, "")
        XCTAssertFalse(flow.canChooseHost)
        flow.selectHost("local")
        XCTAssertEqual(flow.deviceId, "")
        await flow.begin()
        XCTAssertNotNil(flow.error)
        XCTAssertNil(flow.flowId)
    }

    private func health(_ json: String) throws -> DesktopSourceHealth {
        try JSONDecoder().decode(DesktopSourceHealth.self, from: Data(json.utf8))
    }
}
