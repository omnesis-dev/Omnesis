// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import DesktopCore
import Foundation
import XCTest

final class MacServerPowerTests: XCTestCase {
    private let ac = "Now drawing from 'AC Power'\n"

    func testOnlySystemIdleSleepPolicyCanCompleteServerSetup() {
        XCTAssertEqual(
            DesktopMacServerPowerObservation.parse(custom: "AC Power:\n sleep 0\n displaysleep 10\n", battery: ac).status,
            .ready
        )
        XCTAssertEqual(
            DesktopMacServerPowerObservation.parse(custom: "AC Power:\n sleep 10\n displaysleep 0\n womp 1\n powernap 1\n", battery: ac)
                .status,
            .sleepEnabled
        )
    }

    func testLaptopRequiresTheACProfileAndCurrentExternalPowerRegardlessOfSectionOrder() {
        let custom = "AC Power:\n sleep 0\nBattery Power:\n sleep 1\n"
        let ready = DesktopMacServerPowerObservation.parse(custom: custom, battery: ac)
        XCTAssertEqual(ready.status, .ready)
        XCTAssertTrue(ready.laptop)
        XCTAssertEqual(
            DesktopMacServerPowerObservation.parse(custom: custom, battery: "Now drawing from 'Battery Power'\n").status,
            .onBattery
        )
        XCTAssertEqual(
            DesktopMacServerPowerObservation.parse(custom: "Battery Power:\n sleep 0\nAC Power:\n sleep 10\n", battery: ac).status,
            .sleepEnabled
        )
    }

    func testAmbiguousUnsupportedOrPartialPowerOutputCannotClaimReady() {
        for custom in [
            "",
            "Battery Power:\n sleep 0\n",
            "AC Power:\n displaysleep 0\n",
            "AC Power:\n sleep -1\n",
            "AC Power:\n sleep zero\n",
            "AC Power:\n sleep 0 extra\n",
            "AC Power:\n sleep 0\n sleep 1\n",
            "AC Power:\n sleep 0\nAC Power:\n sleep 0\n",
        ] {
            XCTAssertEqual(DesktopMacServerPowerObservation.parse(custom: custom, battery: ac).status, .unavailable)
        }
        for battery in [
            "",
            "Now drawing from 'UPS Power'\n",
            "Unknown power\n",
            "Now drawing from 'AC Power'\nNow drawing from 'Battery Power'\n",
        ] {
            XCTAssertEqual(DesktopMacServerPowerObservation.parse(custom: "AC Power:\n sleep 0\n", battery: battery).status, .unavailable)
        }
    }

    func testAReadCommandThatExitsSuccessfullyOnlyAfterItsDeadlineCannotSupplyReadyEvidence() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(
            "omnesis-power-probe-\(UUID().uuidString)",
            isDirectory: true
        )
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let executable = root.appendingPathComponent("probe")
        let marker = root.appendingPathComponent("finished")
        try "#!/bin/sh\ntrap 'printf finished > \"$1\"; printf ready; exit 0' TERM\nwhile :; do :; done\n".write(
            to: executable,
            atomically: true,
            encoding: .utf8
        )
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: executable.path)
        let refused = await Task.detached {
            do {
                _ = try DesktopMacServerPowerInspector.read([marker.path], executable: executable, timeout: 1, killAfter: 3)
                return false
            } catch { return true }
        }.value
        XCTAssertTrue(refused)
        XCTAssertEqual(try String(contentsOf: marker, encoding: .utf8), "finished")
    }
}
