// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import DesktopCore
import Foundation
@testable import OmnesisDesktop
import XCTest

@MainActor
final class HomeServiceReadinessTests: XCTestCase {
    private func state(until: Double?, identity: String = "desktop-0000000000000001", mode: String = "home") throws -> DesktopState {
        let connection = try JSONDecoder().decode(DesktopConnection.self, from: Data(
            #"{"url":"http://localhost","token":"fictional-token"}"#.utf8
        ))
        return DesktopState(
            phase: .ready,
            mode: mode,
            connection: connection,
            encrypted: true,
            installationId: identity,
            storageAdmission: .init(state: "ready", validUntil: until),
            remoteRoute: .init(state: "ready", validUntil: until)
        )
    }

    func testClockRollbackCannotExtendOrRevalidateTheSameEvidence() throws {
        var wall = 1000.0, monotonic = 200.0
        let flow = DesktopHomeServiceReadiness(wall: { wall }, monotonic: { monotonic })
        let first = try state(until: 1_010_000)
        flow.receive(first)
        XCTAssertEqual(flow.storage, .ready)
        XCTAssertEqual(flow.route, .ready)
        wall = 900
        monotonic = 201
        flow.refreshClock()
        XCTAssertEqual(flow.storage, .unavailable)
        XCTAssertEqual(flow.route, .unavailable)
        wall = 1001
        flow.receive(first)
        XCTAssertEqual(flow.route, .unavailable, "An unchanged cached response is not fresh proof after a clock discontinuity")
        try flow.receive(state(until: 1_011_000))
        XCTAssertEqual(flow.route, .ready)
        wall = 1012
        monotonic = 212
        flow.refreshClock()
        XCTAssertEqual(flow.storage, .unavailable)
        XCTAssertEqual(flow.route, .unavailable)
    }

    func testMissingDeadlineAndNewInstallationCannotReusePreviousReadyEvidence() throws {
        let flow = DesktopHomeServiceReadiness(wall: { 1000 }, monotonic: { 200 })
        try flow.receive(state(until: 1_010_000))
        XCTAssertEqual(flow.storage, .ready)
        try flow.receive(state(until: nil, identity: "desktop-0000000000000002"))
        XCTAssertEqual(flow.storage, .unavailable)
        XCTAssertEqual(flow.route, .unavailable)
        try flow.receive(state(until: 1_010_000, mode: "joined"))
        XCTAssertEqual(flow.storage, .unavailable, "Joined Macs never treat local disk admission as home evidence")
    }

    func testOwnedTimerInvalidatesWithoutAnotherStatusPollAndOldTimerCannotInvalidateReplacement() async throws {
        let flow = DesktopHomeServiceReadiness()
        try flow.receive(state(until: floor(Date().timeIntervalSince1970 * 1000) + 80))
        XCTAssertEqual(flow.route, .ready)
        let end = ContinuousClock.now + .seconds(2)
        while flow.route == .ready, ContinuousClock.now < end {
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTAssertEqual(flow.route, .unavailable, "No response or view recomputation may be needed to expire success")
        try flow.receive(state(until: floor(Date().timeIntervalSince1970 * 1000) + 50))
        try flow.receive(state(
            until: floor(Date().timeIntervalSince1970 * 1000) + 10000,
            identity: "desktop-0000000000000002"
        ))
        try await Task.sleep(for: .milliseconds(100))
        XCTAssertEqual(flow.route, .ready, "An old installation’s deadline task cannot publish into the new installation")
    }
}
