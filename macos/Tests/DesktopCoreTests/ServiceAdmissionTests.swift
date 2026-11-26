// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import DesktopCore
import XCTest

final class ServiceAdmissionTests: XCTestCase {
    func testMalformedOptionalEvidenceNeverRemovesProtectedReadConnection() throws {
        for evidence in [
            "null",
            "false",
            "17",
            "[]",
            #"{"state":"future-state","validUntil":"tomorrow"}"#,
            #"{"state":"ready","validUntil":-1}"#,
            #"{"state":"ready","validUntil":1.5}"#,
        ] {
            let wire = #"{"phase":"ready","mode":"home","encrypted":true,"connection":{"url":"http://localhost","token":"fictional-token"},"storageAdmission":EVIDENCE,"remoteRoute":EVIDENCE}"#
                .replacingOccurrences(of: "EVIDENCE", with: evidence)
            let state = try JSONDecoder().decode(DesktopState.self, from: Data(wire.utf8))
            XCTAssertTrue(state.canOpenLibrary)
            XCTAssertNil(state.storageAdmission?.validUntil)
            XCTAssertNil(state.remoteRoute?.validUntil)
        }
    }

    func testAbsentLegacyEvidenceAndFiniteDeadlineDecodeIndependentlyOfReads() throws {
        let legacy = try JSONDecoder().decode(DesktopState.self, from: Data(
            #"{"phase":"ready","mode":"joined","encrypted":true,"connection":{"url":"http://localhost","token":"fictional-token"}}"#.utf8
        ))
        XCTAssertTrue(legacy.canOpenLibrary)
        XCTAssertNil(legacy.storageAdmission)
        XCTAssertNil(legacy.remoteRoute)
        let evidence = try JSONDecoder().decode(DesktopServiceAdmission.self, from: Data(
            #"{"state":"ready","validUntil":2000000,"message":{"untrusted":"ignored"}}"#.utf8
        ))
        XCTAssertEqual(evidence.state, "ready")
        XCTAssertEqual(evidence.validUntil, 2_000_000)
    }
}
