// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import DesktopCore
@testable import OmnesisDesktop
import XCTest

@MainActor
final class DesktopRestoreFlowTests: XCTestCase {
    func testCancelledReplyAfterPublicationRefreshesPendingRecoveryInsteadOfAssumingNoChange() async throws {
        let fixture = Fixture()
        fixture.cancelReplyAfterCommit = true
        let flow = DesktopRestoreBackupFlow(request: fixture.request)
        flow.begin()
        await idle(flow)
        try flow.select(selection(fixture))
        await idle(flow)
        flow.confirmReplacement = true
        flow.apply()
        await idle(flow)
        XCTAssertNil(flow.outcome)
        await flow.cancel()
        XCTAssertEqual(flow.status?.status, .pending)
        XCTAssertTrue(flow.needsRecoveryAttention)
        XCTAssertFalse(fixture.calls.contains("restoreImportCancel"))
        XCTAssertFalse(flow.startupVerified)
    }

    func testFreshHomeRequiresExplicitChoiceBeforeAnyRuntimeMutation() async throws {
        let flow = DesktopRestoreBackupFlow { name, _ in
            if name == "restoreStatus" {
                return try JSONDecoder().decode(
                    BridgeValue.self,
                    from: Data(#"{"kind":"desktopRestoreStatus","status":"idle","canRecover":false,"recoveryCopyRetained":false}"#.utf8)
                )
            }
            XCTFail("The fresh restore preview must not prepare a home without explicit consent")
            return .null
        }
        try await DesktopSnapshotRenderer.render(
            DesktopRestoreBackupView(flow: flow).environment(DesktopStore.preview()),
            name: "restore-fresh-home-explicit-choice",
            size: CGSize(width: 720, height: 700)
        )
    }

    func testCommittedBackupRenderDoesNotClaimStartupVerification() async throws {
        let fixture = Fixture()
        let flow = DesktopRestoreBackupFlow(request: fixture.request)
        flow.begin()
        await idle(flow)
        try flow.select(selection(fixture))
        await idle(flow)
        flow.confirmReplacement = true
        flow.apply()
        await idle(flow)
        XCTAssertFalse(flow.startupVerified)
        let store = DesktopStore.preview(phase: .waiting)
        store.state = DesktopState(phase: .waiting, mode: "home", encrypted: true)
        try await DesktopSnapshotRenderer.render(
            DesktopRestoreBackupView(flow: flow).environment(store),
            name: "restore-committed-awaiting-startup",
            size: CGSize(width: 720, height: 700)
        )
        XCTAssertFalse(flow.startupVerified)
    }

    @MainActor private final class Fixture {
        let id = "11b83913-f756-49de-b582-b53d7b76ff58"
        var calls: [String] = []
        var applied = false
        var healthy = false
        var completed = false
        var cancelReplyAfterCommit = false
        var needsCode = false
        var sawCode = false
        var bytes: Int64 = 0
        func request(_ command: String, params: [String: BridgeValue]) async throws -> BridgeValue {
            calls.append(command)
            switch command {
            case "restoreStatus":
                return try value(
                    #"{"kind":"desktopRestoreStatus","status":"\#(completed ? "complete" : applied ? "pending" : "idle")","canRecover":\#(applied),"recoveryCopyRetained":\#(applied)}"#
                )
            case "restorePrepareImport": return try value(#"{"kind":"desktopRestoreImport","importId":"\#(id)","maxBytes":1048576}"#)
            case "restoreImport": return try value(
                    #"{"kind":"desktopRestoreImport","importId":"\#(id)","imported":true,"bytes":\#(bytes)}"#
                )
            case "restorePreview":
                sawCode = params["recoveryCode"] == .string("fictional recovery code")
                if needsCode,
                   !sawCode {
                    return try value(
                        #"{"kind":"desktopRestorePreview","importId":"\#(id)","status":"needs-recovery-code","needsRecoveryCode":true,"hasRecoveryEnvelope":true}"#
                    )
                }
                return try value(
                    #"{"kind":"desktopRestorePreview","importId":"\#(id)","status":"ready","needsRecoveryCode":false,"hasRecoveryEnvelope":true,"protection":"encrypted-payloads","confirmationId":"\#(String(repeating: "a", count: 64))","willCreateRecoveryCopy":true,"willPauseModelRoles":true,"willPauseAutomaticDeletion":true,"summary":{"documents":3,"sources":1}}"#
                )
            case "restoreApply":
                applied = true
                if cancelReplyAfterCommit { throw CancellationError() }
                return try value(
                    #"{"kind":"desktopRestoreResult","status":"committed","modelRolesPaused":true,"automaticDeletionPaused":true,"runtimeStopped":true,"recoveryCopyRetained":true,"sourcesPaused":1,"watchesPaused":0}"#
                )
            case "connect":
                completed = healthy
                return try value(
                    #"{"phase":"ready","mode":"home","encrypted":\#(healthy),"connection":{"url":"https://localhost:17601","token":"fixture-token"}}"#
                )
            case "restoreImportCancel": return .null
            default: throw DesktopBridgeReplyWaiter.Failure("Unexpected fixture command")
            }
        }

        private func value(_ json: String) throws -> BridgeValue {
            try JSONDecoder().decode(BridgeValue.self, from: Data(json.utf8))
        }
    }

    private func selection(_ fixture: Fixture) throws -> DesktopRestoreFileSelection {
        let path = FileManager.default.temporaryDirectory.appendingPathComponent("omnesis-restore-flow-\(UUID().uuidString).tar")
            .resolvingSymlinksInPath()
        let file = try PrivateSaveFile(url: path)
        try file.append(Data("inert selected archive fixture".utf8))
        try file.finish()
        addTeardownBlock { try? FileManager.default.removeItem(at: path) }
        let selected = try DesktopRestoreFileSelection.read(URL(fileURLWithPath: DesktopCanonicalPath.resolve(path.path)))
        fixture.bytes = selected.bytes
        return selected
    }

    private func idle(_ flow: DesktopRestoreBackupFlow) async {
        let deadline = ContinuousClock().now.advanced(by: .seconds(5))
        while flow.busy, ContinuousClock().now < deadline {
            await Task.yield()
        }
        XCTAssertFalse(flow.busy)
    }

    func testCommittedBackupNeverClaimsRestoredBeforeProtectedStartupAndPersistedVerification() async throws {
        let fixture = Fixture()
        let flow = DesktopRestoreBackupFlow(request: fixture.request)
        flow.begin()
        await idle(flow)
        try flow.select(selection(fixture))
        await idle(flow)
        XCTAssertNotNil(flow.preview?.confirmation)
        XCTAssertNil(flow.preview?.summary?.watches)
        flow.confirmReplacement = true
        flow.apply()
        await idle(flow)
        XCTAssertEqual(flow.outcome?.status, .committed)
        XCTAssertFalse(flow.startupVerified)
        flow.startAndVerify()
        await idle(flow)
        XCTAssertFalse(flow.startupVerified)
        XCTAssertNotNil(flow.error)
        fixture.healthy = true
        flow.startAndVerify()
        await idle(flow)
        XCTAssertTrue(flow.startupVerified)
        XCTAssertEqual(flow.status?.status, .complete)
    }

    func testRecoveryCodeIsExplicitAndClearedOnSubmitAndCancellationDoesNotDeleteOriginal() async throws {
        let fixture = Fixture()
        fixture.needsCode = true
        let flow = DesktopRestoreBackupFlow(request: fixture.request)
        flow.begin()
        await idle(flow)
        let original = try selection(fixture)
        flow.select(original)
        await idle(flow)
        XCTAssertTrue(flow.preview?.needsRecoveryCode == true)
        XCTAssertFalse(flow.canApply)
        flow.recoveryCode = "fictional recovery code"
        flow.unlockOrReview()
        XCTAssertTrue(flow.recoveryCode.isEmpty)
        await idle(flow)
        XCTAssertTrue(fixture.sawCode)
        XCTAssertNotNil(flow.preview?.confirmation)
        await flow.cancel()
        XCTAssertTrue(FileManager.default.fileExists(atPath: original.path))
        XCTAssertNil(flow.slot)
        XCTAssertTrue(fixture.calls.contains("restoreImportCancel"))
    }
}
