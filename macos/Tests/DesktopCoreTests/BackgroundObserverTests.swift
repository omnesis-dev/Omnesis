// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import DesktopCore
import Foundation
import XCTest

final class BackgroundObserverTests: XCTestCase {
    @MainActor
    func testStartupRepairHasTypedApprovalAndUnavailableStates() {
        XCTAssertEqual(DesktopBackgroundObserver.startupBlock(approvalRequired: true), .approvalRequired)
        XCTAssertEqual(DesktopBackgroundObserver.startupBlock(approvalRequired: false), .helperUnavailable)
    }

    @MainActor
    func testMissingHelperReturnsNativeRepairFailureBeforeOpeningAnApplication() async {
        let absent = FileManager.default.temporaryDirectory.appendingPathComponent("missing-owned-helper-\(UUID().uuidString).app")
        do {
            try await DesktopBackgroundObserver.ensureRunning(appBundle: absent)
            XCTFail("An absent embedded helper cannot satisfy native startup")
        } catch let failure as DesktopBackgroundObserver.StartupBlock {
            XCTAssertEqual(failure, .helperUnavailable)
        } catch { XCTFail("Missing helper must return the typed native repair state") }
    }

    @MainActor
    func testAuthenticatedHelloMismatchIsRecoveryOnlyAndIdleIsNotDaemonReadiness() throws {
        XCTAssertNoThrow(try DesktopBackgroundObserver.requireMatchingOwner(.helperIdle))
        XCTAssertNoThrow(try DesktopBackgroundObserver.requireMatchingOwner(.daemonOwned))
        for state in [DesktopBackgroundLaunchProtocol.State.scopeMismatch, .epochMismatch] {
            XCTAssertThrowsError(try DesktopBackgroundObserver.requireMatchingOwner(state)) {
                XCTAssertEqual($0 as? DesktopBackgroundObserver.StartupBlock, .ownerMismatch)
            }
        }
        XCTAssertThrowsError(try DesktopBackgroundObserver.requireMatchingOwner(.originRequired)) {
            XCTAssertEqual($0 as? DesktopBackgroundObserver.StartupBlock, .originRequired)
        }
        for state in [DesktopBackgroundLaunchProtocol.State.lifecycleBlocked, .ownerUnavailable] {
            XCTAssertThrowsError(try DesktopBackgroundObserver.requireMatchingOwner(state)) {
                XCTAssertEqual($0 as? DesktopBackgroundObserver.StartupBlock, .helperUnavailable)
            }
        }
    }

    @MainActor
    func testOlderEvidenceCannotClearAConcurrentMissingOriginObservation() throws {
        let epoch = String(repeating: "a", count: 64)
        let binding = DesktopBackgroundLaunchProtocol.Binding(
            configDirHash: epoch,
            instance: "desktop-" + String(repeating: "b", count: 16),
            secretService: "dev.omnesis.desktop." + String(repeating: "b", count: 64)
        )
        let request = DesktopBackgroundLaunchProtocol.Request(action: .hello, binding: binding, expectedEpoch: epoch)
        let evidence = DesktopBackgroundApplicationOrigin.Evidence(
            state: .verified,
            codeEpoch: epoch,
            originEpoch: epoch,
            presentation: .installedOrigin,
            installation: .current
        )
        let stale = DesktopBackgroundLaunchProtocol.Reply(
            request: request,
            epoch: epoch,
            state: .helperIdle,
            applicationOwnership: evidence,
            originStatus: .init(state: .unavailable)
        )
        XCTAssertThrowsError(try DesktopBackgroundObserver.requireOwnedOrigin(stale)) {
            XCTAssertEqual($0 as? DesktopBackgroundObserver.StartupBlock, .originRequired)
        }
        let current = DesktopBackgroundLaunchProtocol.Reply(
            request: request,
            epoch: epoch,
            state: .helperIdle,
            applicationOwnership: evidence,
            originStatus: .init(state: .verified)
        )
        XCTAssertNoThrow(try DesktopBackgroundObserver.requireOwnedOrigin(current))
    }

    func testOnlyActualTrashDescendantsRetireTheApplication() {
        let trash = URL(fileURLWithPath: "/example/.Trash", isDirectory: true)
        XCTAssertTrue(DesktopApplicationLocation.isInTrash(URL(fileURLWithPath: "/example/.Trash/Omnesis.app"), trash: trash))
        XCTAssertFalse(DesktopApplicationLocation.isInTrash(URL(fileURLWithPath: "/example/.Trash-copy/Omnesis.app"), trash: trash))
        XCTAssertFalse(DesktopApplicationLocation.isInTrash(URL(fileURLWithPath: "/Applications/Omnesis.app"), trash: trash))
        XCTAssertFalse(DesktopApplicationLocation.isInTrash(URL(fileURLWithPath: "/example/Other/Omnesis.app"), trash: trash))
    }

    @MainActor
    func testNearbyMetadataCannotEstablishObserverStartupOwnership() {
        XCTAssertThrowsError(try DesktopBackgroundObserver.requireMatchingOwner(.nearbySnapshot)) { error in
            XCTAssertEqual(error as? DesktopBackgroundObserver.StartupBlock, .helperUnavailable)
        }
    }
}
