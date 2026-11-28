// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import DesktopCore
import Foundation
import XCTest

final class CollectionAccessTests: XCTestCase {
    private func observation(
        _ status: String,
        requirements: String? = nil,
        target: String = "unverified",
        date: String = "2030-01-01T12:00:00Z"
    ) throws
        -> DesktopPermissionObservation {
        try JSONDecoder().decode(DesktopPermissionObservation.self, from: Data("""
        {"deviceId":"fixture-device","descriptorId":"invented","scopeDigest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","checkedAt":"\(
            date
        )","status":"\(status)","target":"\(target)"\(requirements
            .map { ",\"requirements\":" + $0 } ?? "")}
        """.utf8))
    }

    private let declared = #"[{"id":"selected-records","kind":"protected-files","summary":"Read your chosen information","scope":"Only this selected source","blocking":true,"actions":[{"kind":"open-system-settings","category":"privacy-security"},{"kind":"retry-access"}]}]"#
    func testLegacyMissingRequirementsNeverMeansPermissionGranted() throws {
        XCTAssertFalse(try observation("readable").allowsCollection)
        XCTAssertFalse(try observation("not-required").allowsCollection)
    }

    func testOnlyExplicitNoRequirementIsNotRequired() throws {
        XCTAssertTrue(try observation("not-required", requirements: "[]").allowsCollection)
        XCTAssertFalse(try observation("readable", requirements: "[]").allowsCollection)
        XCTAssertFalse(try observation("not-required", requirements: declared).allowsCollection)
    }

    func testScopedReadabilityIsNotAClaimAboutTheResponsibleApp() throws {
        let result = try observation("readable", requirements: declared)
        XCTAssertTrue(result.allowsCollection)
        XCTAssertEqual(result.target, "unverified")
    }

    func testDeniedUnavailableAndUnsupportedNeverAllowCollection() throws {
        for state in ["denied", "unavailable", "unsupported"] {
            XCTAssertFalse(try observation(state, requirements: declared).allowsCollection)
        }
    }

    func testUnknownFutureStatusOrExecutableActionIsRefused() throws {
        XCTAssertThrowsError(try observation("granted"))
        XCTAssertThrowsError(try observation(
            "readable",
            requirements: declared.replacingOccurrences(of: "retry-access", with: "run-command")
        ))
    }

    func testInvalidEvidenceDateOrUnrecognizedAttributionNeverAllowsCollection() throws {
        XCTAssertFalse(try observation("readable", requirements: declared, date: "yesterday").allowsCollection)
        XCTAssertFalse(try observation("readable", requirements: declared, target: "some-app").allowsCollection)
    }
}
