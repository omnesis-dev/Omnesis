// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import DesktopCore
import XCTest

final class UpdatePresentationTests: XCTestCase {
    func testUpdateRepliesDoNotPretendToBeLibraryReadiness() throws {
        let json = #"{"version":1,"id":"update","ok":true,"result":{"kind":"desktopUpdate","phase":"verified","currentVersion":"1.0.0","targetVersion":"1.1.0","message":"Installer checked","confirmationId":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}}"#
        let envelope = try JSONDecoder().decode(BridgeEnvelope.self, from: Data(json.utf8))
        XCTAssertNil(envelope.result)
        XCTAssertEqual(envelope.update?.phase, .verified)
        XCTAssertNotNil(envelope.update?.confirmation)
    }

    func testUntrustedConfirmationAndUnknownPhaseRefuseActions() throws {
        let json = #"{"kind":"desktopUpdate","phase":"available","currentVersion":"1.0.0","message":"Update available","confirmationId":"not-a-bound-token"}"#
        let value = try JSONDecoder().decode(DesktopUpdatePresentation.self, from: Data(json.utf8))
        XCTAssertNil(value.confirmation)
        XCTAssertThrowsError(try JSONDecoder().decode(
            DesktopUpdatePresentation.self,
            from: Data(json.replacingOccurrences(of: "available", with: "unknown-phase").utf8)
        ))
    }

    func testPlatformInteractionRetainsReceiptBindingAndMeasuredProgress() throws {
        let json = #"{"id":"platform","kind":"stageDesktopInstaller","receiptId":"fixture-receipt","oldEpoch":"old","candidateEpoch":"candidate","artifactSha256":"digest"}"#
        let value = try JSONDecoder().decode(RuntimeInteraction.self, from: Data(json.utf8))
        XCTAssertEqual(value.payload["receiptId"], .string("fixture-receipt"))
        XCTAssertEqual(value.payload["candidateEpoch"], .string("candidate"))
    }
}
