// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import DesktopCore
import Foundation
import XCTest

final class BackgroundDaemonProcessTests: XCTestCase {
    private func descriptor() -> DesktopBackgroundDaemonAuthority.Descriptor {
        .init(
            version: 1,
            scope: .init(
                format: 1,
                configDir: "/example/owned-home",
                instance: "desktop-" + String(repeating: "a", count: 16),
                secretService: "dev.omnesis.desktop." + String(
                    repeating: "a",
                    count: 64
                )
            ),
            epoch: String(repeating: "b", count: 64),
            activation: nil,
            nonce: UUID().uuidString.lowercased()
        )
    }

    func testRealOwnedPipeRecordCannotAuthorizeOtherPurposeOrNonce() async throws {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/sleep")
        process.arguments = ["30"]
        let child = try DesktopBackgroundDaemonProcess(process: process, descriptor: descriptor())
        let record = child.ownedRecord
        XCTAssertTrue(child.matchesOwner(record, retirement: false))
        XCTAssertFalse(child.matchesOwner(record, retirement: true))
        let changed = DesktopBackgroundDaemonAuthority.Owner(
            format: record.format,
            scope: record.scope,
            epoch: record.epoch,
            nonce: UUID().uuidString.lowercased(),
            helperPid: record.helperPid,
            daemonPid: record.daemonPid,
            pipe: record.pipe
        )
        XCTAssertFalse(child.matchesOwner(changed, retirement: false))
        _ = await child.stopAndJoin()
        XCTAssertFalse(child.running)
        XCTAssertFalse(child.matchesOwner(record, retirement: false))
    }

    func testMalformedChildOutputCannotBecomeSupervisorReadiness() async throws {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/echo")
        process.arguments = ["{\"version\":1,\"kind\":\"desktop-daemon-ready\"}"]
        let child = try DesktopBackgroundDaemonProcess(process: process, descriptor: descriptor())
        do { _ = try await child.ready()
            XCTFail("Incomplete frames cannot claim supervisor ownership")
        } catch {}
        _ = await child.stopAndJoin()
        XCTAssertFalse(child.running)
    }

    func testCancelledReadinessIsFollowedByExactOwnedChildJoin() async throws {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/sleep")
        process.arguments = ["30"]
        let child = try DesktopBackgroundDaemonProcess(process: process, descriptor: descriptor())
        let ready = Task { try await child.ready() }
        ready.cancel()
        do { _ = try await ready.value
            XCTFail("Cancellation cannot report readiness")
        } catch {}
        _ = await child.stopAndJoin()
        XCTAssertFalse(child.running)
    }

    func testClosingOnlyLifetimePipeTriggersRealChildEOFWithoutWritingIntent() async throws {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/sh")
        process.arguments = ["-c", "if IFS= read -r -t 5 value; then exit 9; else exit 0; fi"]
        let child = try DesktopBackgroundDaemonProcess(process: process, descriptor: descriptor())
        let began = ContinuousClock.now
        child.requestDrain()
        let result = await child.waitForExit()
        XCTAssertTrue(result.clean)
        XCTAssertLessThan(began.duration(to: .now), .seconds(2))
    }

    func testExitBeforeCallbackRegistrationStillNotifiesAfterActualJoin() async throws {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/true")
        let child = try DesktopBackgroundDaemonProcess(process: process, descriptor: descriptor())
        let result = await child.waitForExit()
        XCTAssertTrue(result.clean)
        let notified = expectation(description: "Actual terminal disposition delivered to late subscriber")
        child.onExit = { result in
            XCTAssertTrue(result.clean)
            notified.fulfill()
        }
        await fulfillment(of: [notified], timeout: 1)
    }
}
