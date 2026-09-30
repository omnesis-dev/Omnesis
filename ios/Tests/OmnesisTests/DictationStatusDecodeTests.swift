// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

/// The `dictation` field on `GET /status`. It is optional and experimental:
/// every way it can be absent or unreadable must leave the app on its
/// on-device recognizer, never fail the snapshot the rest of the app needs.
final class DictationStatusDecodeTests: XCTestCase {
    private func decodeStatus(_ json: String) throws -> StatusSnapshot {
        try JSONDecoder().decode(StatusSnapshot.self, from: Data(json.utf8))
    }

    func testDecodesAnActiveGate() throws {
        let snapshot = try decodeStatus("""
        {"documents":{"total":0,"bySource":{}},"experimental":true,
         "dictation":{"visible":true,"enabled":true,"modelAssigned":true,"active":true,
                      "maxAudioBytes":26214400}}
        """)
        let dictation = try XCTUnwrap(snapshot.dictation)
        XCTAssertTrue(dictation.visible)
        XCTAssertTrue(dictation.enabled)
        XCTAssertTrue(dictation.modelAssigned)
        XCTAssertTrue(dictation.active)
        XCTAssertNil(dictation.reason)
        XCTAssertEqual(dictation.maxAudioBytes, 26_214_400)
        XCTAssertTrue(dictation.routesToGateway)
        XCTAssertNil(dictation.blockedReason)
    }

    func testBlockedGateCarriesTheReasonForSettings() throws {
        let snapshot = try decodeStatus("""
        {"documents":{"total":0,"bySource":{}},
         "dictation":{"visible":true,"enabled":true,"modelAssigned":false,"active":false,
                      "reason":"The transcriber model is not installed.","maxAudioBytes":26214400}}
        """)
        let dictation = try XCTUnwrap(snapshot.dictation)
        XCTAssertFalse(dictation.routesToGateway)
        XCTAssertEqual(dictation.blockedReason, "The transcriber model is not installed.")
    }

    /// A reason only matters to someone who switched the feature on; a
    /// gateway merely previewing it has nothing to fix.
    func testReasonIsNotABlockWhileSwitchedOff() throws {
        let snapshot = try decodeStatus("""
        {"documents":{"total":0,"bySource":{}},
         "dictation":{"visible":true,"enabled":false,"modelAssigned":false,"active":false,
                      "reason":"No transcriber model is assigned.","maxAudioBytes":26214400}}
        """)
        XCTAssertNil(try XCTUnwrap(snapshot.dictation).blockedReason)
    }

    func testGatewayWithoutTheFieldHasNoGate() throws {
        let snapshot = try decodeStatus(#"{"documents":{"total":0,"bySource":{}},"experimental":true}"#)
        XCTAssertNil(snapshot.dictation)
    }

    func testPartialObjectReadsAsInactive() throws {
        let snapshot = try decodeStatus(#"{"documents":{"total":0,"bySource":{}},"dictation":{"active":true}}"#)
        let dictation = try XCTUnwrap(snapshot.dictation)
        XCTAssertTrue(dictation.active)
        XCTAssertEqual(dictation.maxAudioBytes, 0)
        // No byte limit to record against: stay on-device.
        XCTAssertFalse(dictation.routesToGateway)
    }

    func testUnreadableFieldDoesNotFailTheSnapshot() throws {
        let snapshot = try decodeStatus("""
        {"documents":{"total":7,"bySource":{}},"dictation":{"active":"yes"}}
        """)
        XCTAssertNil(snapshot.dictation)
        XCTAssertEqual(snapshot.documents.total, 7)
    }
}
