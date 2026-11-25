// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import DesktopCore
import XCTest

final class RemovalPresentationTests: XCTestCase {
    func testPreserveDataPlanNeedsMatchingProtectionAndBackendConfirmation() throws {
        let token = String(repeating: "a", count: 64)
        let wire = #"{"available":true,"mode":"keep-data","confirmationId":"\#(token)","summary":"Stop Omnesis and keep its library.","dataKept":true,"keyKept":true}"#
        let plan = try JSONDecoder().decode(DesktopRemovalPlan.self, from: Data(wire.utf8))
        XCTAssertTrue(plan.canConfirm)
        XCTAssertEqual(plan.mode, .keepData)
        for bad in [
            wire.replacingOccurrences(of: token, with: ""),
            wire.replacingOccurrences(of: #""keyKept":true"#, with: #""keyKept":false"#),
        ] {
            XCTAssertFalse(try JSONDecoder().decode(DesktopRemovalPlan.self, from: Data(bad.utf8)).canConfirm)
        }
    }

    func testNoInstallationDoesNotEnableADeletionAction() throws {
        let wire = #"{"available":false,"mode":"keep-data","confirmationId":null,"summary":"Nothing to remove.","dataKept":true,"keyKept":true}"#
        XCTAssertFalse(try JSONDecoder().decode(DesktopRemovalPlan.self, from: Data(wire.utf8)).canConfirm)
    }

    func testKeyCleanupPendingCannotBeShownAsFinished() throws {
        let wire = #"{"version":1,"id":"removal-1","ok":true,"result":{"status":"key-cleanup-pending","data":"erased","keyring":"pending"}}"#
        let reply = try JSONDecoder().decode(BridgeEnvelope.self, from: Data(wire.utf8))
        let outcome = try XCTUnwrap(reply.removalOutcome)
        XCTAssertNil(reply.result)
        XCTAssertFalse(outcome.finished)
        XCTAssertEqual(outcome.title, "One removal step needs attention")
        XCTAssertTrue(outcome.message.contains("has not finished"))
    }

    func testErasedDataNeedsConfirmedKeyRemovalBeforeSuccess() throws {
        let completed = #"{"status":"retired","data":"erased","keyring":"cleared"}"#
        XCTAssertTrue(try JSONDecoder().decode(DesktopRemovalOutcome.self, from: Data(completed.utf8)).finished)
        let inconsistent = completed.replacingOccurrences(of: "cleared", with: "unchanged")
        XCTAssertFalse(try JSONDecoder().decode(DesktopRemovalOutcome.self, from: Data(inconsistent.utf8)).finished)
    }

    func testRetirementStateCannotOpenTheLibraryEvenWithAConnection() throws {
        let wire = #"{"phase":"ready","mode":"home","encrypted":true,"retired":true,"retirement":{"mode":"keep-data","phase":"complete"},"connection":{"url":"https://localhost:17601","token":"invented-token"}}"#
        let state = try JSONDecoder().decode(DesktopState.self, from: Data(wire.utf8))
        XCTAssertFalse(state.canOpenLibrary)
        XCTAssertEqual(state.statusLabel, "Omnesis is stopped")
    }

    func testPreviewReplyRemainsDistinctFromLifecycleState() throws {
        let token = String(repeating: "b", count: 64)
        let wire = #"{"version":1,"id":"preview-1","ok":true,"result":{"available":true,"mode":"erase-data","confirmationId":"\#(token)","summary":"Erase only this managed library.","dataKept":false,"keyKept":false}}"#
        let reply = try JSONDecoder().decode(BridgeEnvelope.self, from: Data(wire.utf8))
        XCTAssertNil(reply.result)
        XCTAssertNil(reply.removalOutcome)
        XCTAssertEqual(reply.removalPlan?.mode, .eraseData)
        XCTAssertEqual(reply.removalPlan?.canConfirm, true)
    }
}
