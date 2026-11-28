// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import DesktopCore
import Foundation
@testable import OmnesisDesktop
import XCTest

final class DesktopWireTests: XCTestCase {
    func testLibraryRejectsRemotePlaintextBeforeAnyRequest() throws {
        let connection = try decodeConnection(#"{"url":"http://example.com","token":"invented-token"}"#)
        XCTAssertThrowsError(try DesktopAPI(connection: connection))
    }

    func testLibraryRejectsCredentialsInAddress() throws {
        let connection = try decodeConnection(#"{"url":"https://name:password@example.com","token":"invented-token"}"#)
        XCTAssertThrowsError(try DesktopAPI(connection: connection))
    }

    func testInvalidPinnedCertificateCannotDowngradeToSystemTrust() throws {
        let connection =
            try decodeConnection(#"{"url":"https://localhost:17601","token":"invented-token","certificatePEM":"not-a-certificate"}"#)
        XCTAssertThrowsError(try DesktopAPI(connection: connection))
    }

    func testOlderDescriptorFieldsRemainOptionalAndSecretsStayDistinct() throws {
        let descriptor = try JSONDecoder().decode(
            DesktopDescriptor.self,
            from: Data(
                #"{"id":"fictional-source","name":"Invented source","description":"An invented source for wire validation","hasAuthFlow":true,"hasDiscover":false,"params":[{"name":"token","label":"Access key","type":"secret","required":true}],"devices":[{"id":"fixture-device","name":"My Mac"}]}"#
                    .utf8
            )
        )
        XCTAssertEqual(descriptor.params?.first?.type, "secret")
        XCTAssertNil(descriptor.memberScopedParamNames)
        XCTAssertEqual(descriptor.devices?.first?.id, "fixture-device")
    }

    func testAuthReplayKeepsChallengeIdentityAndExpectsAnswer() throws {
        let snapshot = try JSONDecoder().decode(
            AuthSnapshot.self,
            from: Data(
                #"{"state":"awaiting-user","pendingChallenge":{"id":"challenge-1","expectsAnswer":true,"challenge":{"kind":"fields","title":"Choose a region","fields":[{"name":"region","label":"Region","type":"select","options":[{"value":"north","label":"North"}]}],"prefill":{"region":"north"}}}}"#
                    .utf8
            )
        )
        XCTAssertEqual(snapshot.pendingChallenge?.id, "challenge-1")
        XCTAssertEqual(snapshot.pendingChallenge?.expectsAnswer, true)
        XCTAssertEqual(snapshot.pendingChallenge?.challenge.prefill?["region"], "north")
    }

    private func decodeConnection(_ json: String) throws -> DesktopConnection {
        try JSONDecoder().decode(DesktopConnection.self, from: Data(json.utf8))
    }
}
