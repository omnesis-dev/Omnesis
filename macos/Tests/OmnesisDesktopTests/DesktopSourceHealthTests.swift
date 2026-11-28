// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import DesktopCore
import Foundation
@testable import OmnesisDesktop
import SwiftUI
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

    func testUnverifiedCollectionStatesOfferOnlyReadOnlyStatusChecks() async throws {
        let source = try JSONDecoder().decode(DesktopSource.self, from: Data(
            #"{"id":"invented:example","type":"invented","accountId":"Example account","enabled":true,"deviceId":"local"}"#.utf8
        ))
        let cases: [(String, String?, Bool)] = [
            ("missing", nil, true),
            ("stale", "synced", false),
            ("unavailable", "unavailable", true),
            ("unknown", "future-state", true),
        ]
        for (name, state, current) in cases {
            let status = try state.map { try health(#"{"sourceId":"invented:example","state":"\#($0)"}"#) }
            var checks = 0
            var signIns = 0
            var accessReviews = 0
            try await DesktopSnapshotRenderer.render(
                DesktopSourceHealthView(
                    source: source,
                    status: status,
                    current: current,
                    devices: [],
                    canSignIn: true,
                    reviewAccess: { _ in accessReviews += 1 },
                    checkStatus: { checks += 1 },
                    signIn: { _ in signIns += 1 }
                ),
                name: "source-status-\(name)", size: CGSize(width: 420, height: 260)
            ) { hosting in
                XCTAssertTrue(try DesktopAccessibilityDriver.contains(
                    "Omnesis hasn’t confirmed collection status yet. Your saved information is kept.",
                    in: hosting
                ))
                let before = checks
                try DesktopAccessibilityDriver.press("source-check-status-invented:example", in: hosting)
                XCTAssertEqual(checks, before + 1)
                XCTAssertEqual(signIns, 0)
                XCTAssertEqual(accessReviews, 0)
            }
        }
    }

    func testUnknownStateRetainsCurrentStructuredAccessRecoveryBesideStatusCheck() async throws {
        let source = try JSONDecoder().decode(DesktopSource.self, from: Data(
            #"{"id":"invented:example","type":"invented","accountId":"Example account","enabled":true,"deviceId":"local"}"#.utf8
        ))
        let status =
            try health(
                #"{"sourceId":"invented:example","deviceId":"local","state":"future-state","remediation":{"summary":"Review the source folder","steps":[],"access":{"status":"denied","checkedAt":"2026-01-01T00:00:00Z","scopeDigest":"invented-scope","target":"unverified"}}}"#
            )
        var reviews = 0
        var checks = 0
        try await DesktopSnapshotRenderer.render(
            DesktopSourceHealthView(
                source: source,
                status: status,
                current: true,
                devices: [],
                canSignIn: false,
                reviewAccess: { device in XCTAssertEqual(device, "local")
                    reviews += 1
                },
                checkStatus: { checks += 1 },
                signIn: { _ in XCTFail("Access recovery is not sign-in") }
            ),
            name: "source-status-unknown-access-recovery", size: CGSize(width: 420, height: 340)
        ) { hosting in
            let review = try XCTUnwrap(DesktopAccessibilityDriver.elements(in: hosting).first {
                $0.accessibilityLabel() == "Review collection access for Example account on Another device"
            })
            let before = reviews
            XCTAssertTrue(review.accessibilityPerformPress())
            XCTAssertEqual(reviews, before + 1)
            let previous = checks
            try DesktopAccessibilityDriver.press("source-check-status-invented:example", in: hosting)
            XCTAssertEqual(checks, previous + 1)
            XCTAssertTrue(try DesktopAccessibilityDriver.contains("Collection access needs attention", in: hosting))
        }
    }

    func testPausedHistoricalAndUnavailableWithoutReaderNeverOfferACollectionMutation() async throws {
        for (name, enabled, members) in [("paused", false, "[\"local\"]"), ("historical", true, "[]"), ("no-reader", true, "[\"local\"]")] {
            let source = try JSONDecoder().decode(DesktopSource.self, from: Data(
                "{\"id\":\"invented:example\",\"type\":\"invented\",\"accountId\":\"Example account\",\"enabled\":\(enabled),\"deviceId\":\"local\",\"members\":\(members),\"archived\":\(name == "historical")}"
                    .utf8
            ))
            var checks = 0
            let checkStatus: (() -> Void)? = name == "no-reader" ? nil : { checks += 1 }
            try await DesktopSnapshotRenderer.render(
                DesktopSourceHealthView(
                    source: source,
                    status: nil,
                    current: false,
                    devices: [],
                    canSignIn: true,
                    checkStatus: checkStatus,
                    signIn: { _ in XCTFail("No sign-in is requested by unknown status") }
                ),
                name: "source-status-\(name)", size: CGSize(width: 420, height: 260)
            ) { hosting in
                XCTAssertEqual(checks, 0)
                XCTAssertFalse(try DesktopAccessibilityDriver.contains("Check status", in: hosting))
                if name == "paused" {
                    XCTAssertTrue(try DesktopAccessibilityDriver.contains("Paused", in: hosting))
                    XCTAssertFalse(try DesktopAccessibilityDriver.contains(
                        "Omnesis hasn’t confirmed collection status yet. Your saved information is kept.",
                        in: hosting
                    ))
                } else if name == "historical" {
                    XCTAssertTrue(try DesktopAccessibilityDriver.contains("Historical data", in: hosting))
                } else {
                    XCTAssertTrue(try DesktopAccessibilityDriver.contains(
                        "Omnesis hasn’t confirmed collection status yet. Your saved information is kept.",
                        in: hosting
                    ))
                }
            }
        }
    }

    func testRepeatedSignInActionsIdentifyTheirAccountAndKeepTheirReportingDeviceInBothAppearances() async throws {
        let sources = try JSONDecoder().decode([DesktopSource].self, from: Data(
            #"[{"id":"invented:first","type":"invented","accountId":"Example first account","enabled":true,"deviceId":"local"},{"id":"invented:second","type":"invented","accountId":"Example second account","enabled":true,"deviceId":"local"}]"#
                .utf8
        ))
        let devices = try JSONDecoder().decode([DesktopDevice].self, from: Data(
            #"[{"id":"local","name":"Example desktop","kind":"collector","online":true}]"#.utf8
        ))
        let statuses = try Dictionary(uniqueKeysWithValues: sources.enumerated().map { index, source in
            let device = index == 0 ? ",\"deviceId\":\"local\"" : ""
            return try (source.id, health("{\"sourceId\":\"\(source.id)\"\(device),\"state\":\"needs-auth\"}"))
        })
        var requests = [String](), appearances = 0
        try await DesktopSnapshotRenderer.render(
            VStack(alignment: .leading, spacing: 24) {
                ForEach(sources) { source in
                    DesktopSourceHealthView(
                        source: source, status: statuses[source.id], current: true, devices: devices, canSignIn: true,
                        signIn: { device in requests.append(source.id + ":" + device) }
                    )
                }
            }.padding(24),
            name: "source-contextual-sign-in", size: CGSize(width: 520, height: 420)
        ) { hosting in
            XCTAssertEqual(requests.count, appearances * sources.count, "Mounting must not initiate sign-in")
            for source in sources {
                let control = try DesktopAccessibilityDriver.element("source-reauth-\(source.id)-local", in: hosting)
                XCTAssertEqual(control.accessibilityRole(), .button)
                XCTAssertEqual(control.accessibilityLabel(), "Sign in again for \(source.accountId) on Example desktop")
                XCTAssertTrue(control.isAccessibilityEnabled())
                XCTAssertGreaterThan(control.accessibilityFrame().width, 0)
                XCTAssertGreaterThan(control.accessibilityFrame().height, 0)
                XCTAssertTrue(try XCTUnwrap(hosting.window).frame.contains(control.accessibilityFrame()))
                let before = requests.count
                XCTAssertTrue(control.accessibilityPerformPress())
                XCTAssertEqual(requests.count, before + 1)
                XCTAssertEqual(requests.last, source.id + ":local", "The contextual label must retain its actual reporting-device action")
            }
            appearances += 1
        }
        XCTAssertEqual(appearances, 2)
        XCTAssertEqual(requests.count, sources.count * 2)
    }

    func testMultipleReportsWithoutADeviceKeepUnknownAttributionAndOfferNoInventedSignIn() async throws {
        let source = try JSONDecoder().decode(DesktopSource.self, from: Data(
            #"{"id":"invented:ambiguous","type":"invented","accountId":"Example shared account","enabled":true,"deviceId":"local","members":["local","other"]}"#
                .utf8
        ))
        let devices = try JSONDecoder().decode([DesktopDevice].self, from: Data(
            #"[{"id":"local","name":"Example desktop","kind":"collector","online":true},{"id":"other","name":"Example second computer","kind":"collector","online":true}]"#
                .utf8
        ))
        let status = try health(
            #"{"sourceId":"invented:ambiguous","state":"synced","members":[{"sourceId":"invented:ambiguous","state":"needs-auth"},{"sourceId":"invented:ambiguous","deviceId":"other","state":"needs-auth"}]}"#
        )
        var requests = [String](), appearances = 0
        try await DesktopSnapshotRenderer.render(
            DesktopSourceHealthView(
                source: source, status: status, current: true, devices: devices, canSignIn: true,
                signIn: { requests.append($0) }
            ).padding(24),
            name: "source-contextual-sign-in-ambiguous", size: CGSize(width: 520, height: 340)
        ) { hosting in
            XCTAssertTrue(try DesktopAccessibilityDriver.contains("Another device: Sign-in needed", in: hosting))
            XCTAssertTrue(try DesktopAccessibilityDriver.contains("Example second computer: Sign-in needed", in: hosting))
            XCTAssertFalse(try DesktopAccessibilityDriver.contains("Example desktop: Sign-in needed", in: hosting))
            let repairActions = try DesktopAccessibilityDriver.elements(in: hosting).filter {
                ($0.accessibilityIdentifier() ?? "").hasPrefix("source-reauth-")
            }
            XCTAssertEqual(requests.count, appearances, "Mounting must not initiate sign-in")
            XCTAssertEqual(repairActions.count, 1, "Only the explicitly identified report may offer sign-in")
            let control = try XCTUnwrap(repairActions.first)
            XCTAssertEqual(control.accessibilityIdentifier(), "source-reauth-invented:ambiguous-other")
            XCTAssertEqual(control.accessibilityRole(), .button)
            XCTAssertEqual(control.accessibilityLabel(), "Sign in again for Example shared account on Example second computer")
            XCTAssertTrue(control.isAccessibilityEnabled())
            XCTAssertGreaterThan(control.accessibilityFrame().width, 0)
            XCTAssertGreaterThan(control.accessibilityFrame().height, 0)
            XCTAssertTrue(try XCTUnwrap(hosting.window).frame.contains(control.accessibilityFrame()))
            XCTAssertTrue(control.accessibilityPerformPress())
            XCTAssertEqual(requests.count, appearances + 1)
            XCTAssertEqual(requests.last, "other", "The missing report must never acquire the source owner's repair target")
            appearances += 1
        }
        XCTAssertEqual(appearances, 2)
        XCTAssertEqual(requests, ["other", "other"])
    }

    private func health(_ json: String) throws -> DesktopSourceHealth {
        try JSONDecoder().decode(DesktopSourceHealth.self, from: Data(json.utf8))
    }
}
