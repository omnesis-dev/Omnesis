// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
@testable import Omnesis
import XCTest

final class NotesManageLinkTests: XCTestCase {
    func testDayKeyRequiresCompleteDayShape() {
        XCTAssertTrue(isNoteDayKey("2026-03-01"))
        for value in ["", "2026-3-1", "2026-03", "day-2026-03-01", "2026-03-01T10:00:00Z"] {
            XCTAssertFalse(isNoteDayKey(value), value)
        }
    }

    func testDayDerivationPrefersExternalId() {
        XCTAssertEqual(
            notesDayForDocument(externalId: "2026-03-01", sourceCreatedAt: "2026-03-02T10:00:00Z"),
            "2026-03-01"
        )
        XCTAssertEqual(
            notesDayForDocument(externalId: "run-001", sourceCreatedAt: "2026-03-02T10:00:00Z"),
            "2026-03-02"
        )
        XCTAssertNil(notesDayForDocument(externalId: nil, sourceCreatedAt: nil))
        XCTAssertNil(notesDayForDocument(externalId: "nope", sourceCreatedAt: "also-nope"))
    }

    func testManageNotesURLPreservesDeepLink() throws {
        let base = try XCTUnwrap(URL(string: "https://gateway.example:7942"))
        XCTAssertEqual(
            manageNotesURL(baseURL: base, token: "omn_t", day: "2026-03-01")?.absoluteString,
            "https://gateway.example:7942/portal/capture?day=2026-03-01&token=omn_t"
        )
        XCTAssertEqual(
            manageNotesURL(baseURL: base, token: "omn_t", day: nil)?.absoluteString,
            "https://gateway.example:7942/portal/capture?token=omn_t"
        )
    }

    func testManageNotesURLPercentEncodesReservedTokenCharacters() throws {
        // Locks the URLComponents builder against the Android URLEncoder
        // one, which must produce the identical string for the same inputs.
        let base = try XCTUnwrap(URL(string: "https://gateway.example:7942"))
        XCTAssertEqual(
            manageNotesURL(baseURL: base, token: "a+b&c", day: "2026-03-01")?.absoluteString,
            "https://gateway.example:7942/portal/capture?day=2026-03-01&token=a%2Bb%26c"
        )
    }

    func testDayDerivationRejectsPaddedAndTruncatedDates() {
        // A padded external id is not a day, but the creation-date
        // fallback still applies when it is day-shaped.
        XCTAssertEqual(
            notesDayForDocument(externalId: " 2026-03-01", sourceCreatedAt: "2026-03-01T10:00:00Z"),
            "2026-03-01"
        )
        XCTAssertNil(notesDayForDocument(externalId: " 2026-03-01", sourceCreatedAt: "not-a-date"))
        XCTAssertNil(notesDayForDocument(externalId: nil, sourceCreatedAt: "2026-03"))
        XCTAssertNil(notesDayForDocument(externalId: "2026-03-01 ", sourceCreatedAt: nil))
    }

    func testManageLinkIsNotesSourced() {
        XCTAssertEqual(notesSourceId, "omnesis-notes")
    }
}
