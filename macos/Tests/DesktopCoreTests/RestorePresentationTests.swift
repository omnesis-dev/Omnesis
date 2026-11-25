// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import DesktopCore
import XCTest

final class RestorePresentationTests: XCTestCase {
    private let id = "bb08642b-7af5-46d3-a1b4-c3763b1bfa8a"
    func testReviewRequiresRealRecoveryCopyAndValidBoundConfirmation() throws {
        let json = #"{"kind":"desktopRestorePreview","importId":"\#(id)","status":"ready","needsRecoveryCode":false,"hasRecoveryEnvelope":true,"confirmationId":"\#(String(repeating: "a", count: 64))","protection":"encrypted-payloads","willCreateRecoveryCopy":true,"willPauseModelRoles":true,"willPauseAutomaticDeletion":true,"summary":{"documents":3}}"#
        let preview = try JSONDecoder().decode(DesktopRestorePreview.self, from: Data(json.utf8))
        XCTAssertNotNil(preview.confirmation)
        XCTAssertNil(preview.summary?.sources)
        XCTAssertFalse(preview.originalMayBeReadable)
        for changed in [
            json.replacingOccurrences(of: "\"willCreateRecoveryCopy\":true", with: "\"willCreateRecoveryCopy\":false"),
            json.replacingOccurrences(of: "\"documents\":3", with: "\"documents\":-1"),
        ] {
            XCTAssertNil(try JSONDecoder().decode(DesktopRestorePreview.self, from: Data(changed.utf8)).confirmation)
        }
    }

    func testCommitIsDistinctFromRestoredAndMustReportPausedCounts() throws {
        let json = #"{"kind":"desktopRestoreResult","status":"committed","modelRolesPaused":true,"automaticDeletionPaused":true,"runtimeStopped":true,"recoveryCopyRetained":true,"sourcesPaused":2,"watchesPaused":0}"#
        let result = try JSONDecoder().decode(DesktopRestoreOutcome.self, from: Data(json.utf8))
        XCTAssertTrue(result.valid)
        XCTAssertEqual(result.status, .committed)
        let missing = json.replacingOccurrences(of: ",\"sourcesPaused\":2", with: "")
        XCTAssertFalse(try JSONDecoder().decode(DesktopRestoreOutcome.self, from: Data(missing.utf8)).valid)
        XCTAssertThrowsError(try JSONDecoder().decode(
            DesktopRestoreOutcome.self,
            from: Data(json.replacingOccurrences(of: "committed", with: "restored").utf8)
        ))
    }

    func testImportSlotNeverAcceptsAnUnboundedSizeOrAnArbitraryIdentifier() throws {
        let json = #"{"kind":"desktopRestoreImport","importId":"\#(id)","maxBytes":1024}"#
        XCTAssertTrue(try JSONDecoder().decode(DesktopRestoreImport.self, from: Data(json.utf8)).selectable)
        XCTAssertFalse(try JSONDecoder()
            .decode(DesktopRestoreImport.self, from: Data(json.replacingOccurrences(of: "1024", with: "0").utf8)).selectable)
        XCTAssertFalse(try JSONDecoder().decode(
            DesktopRestoreImport.self,
            from: Data(json.replacingOccurrences(of: id, with: "../../not-a-slot").utf8)
        ).selectable)
    }

    func testPriorChoicesAreReadOnlyReferenceAndPreserveExplicitDisabledRoles() throws {
        let json = #"{"kind":"desktopRestoreStatus","status":"complete","canRecover":true,"recoveryCopyRetained":true,"review":{"version":1,"modelAssignments":{"agent":null,"embedder":"http:example/embedding"},"storageRetention":[{"sourceId":"example-notes","maxAgeDays":90}],"activityRetention":{"maxAge":"30d"}}}"#
        let status = try JSONDecoder().decode(DesktopRestoreStatus.self, from: Data(json.utf8))
        XCTAssertEqual(status.status, .complete)
        XCTAssertEqual(status.review?.modelAssignments.keys.sorted(), ["agent", "embedder"])
        XCTAssertNil(status.review?.modelAssignments["agent"].flatMap { $0 })
        XCTAssertEqual(status.review?.storageRetention.first?.maxAgeDays, 90)
    }

    func testUnreadableOptionalReferenceNeverBlocksAuthoritativeRecovery() throws {
        for reference in [
            "null",
            #"{"version":2}"#,
            #"{"version":1,"modelAssignments":{},"storageRetention":[{"sourceId":"example-notes","maxAgeDays":-1}],"activityRetention":{}}"#,
        ] {
            let json = #"{"kind":"desktopRestoreStatus","status":"pending","canRecover":true,"operationId":"\#(id)","recoveryCopyRetained":true,"review":\#(reference)}"#
            let status = try JSONDecoder().decode(DesktopRestoreStatus.self, from: Data(json.utf8))
            XCTAssertNil(status.review)
            XCTAssertEqual(status.recoveryOperation, id)
        }
    }
}
