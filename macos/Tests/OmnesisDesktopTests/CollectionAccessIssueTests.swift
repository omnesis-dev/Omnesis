// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
@testable import OmnesisDesktop
import XCTest

final class CollectionAccessIssueTests: XCTestCase {
    private func sources(enabled: Bool = true) throws -> [DesktopSource] {
        try JSONDecoder().decode(
            [DesktopSource].self,
            from: Data(
                #"[{"id":"notes","type":"invented","accountId":"Fictional notebook","enabled":ENABLED,"deviceId":"local","members":["local","remote"]}]"#
                    .replacingOccurrences(
                        of: "ENABLED",
                        with: enabled ? "true" : "false"
                    ).utf8
            )
        )
    }

    private func devices(revoked: Bool = false) throws -> [DesktopDevice] {
        try JSONDecoder().decode(
            [DesktopDevice].self,
            from: Data(
                #"[{"id":"local","name":"This Mac","kind":"collector"},{"id":"remote","name":"Example library Mac","kind":"collector","revokedAt":REVOKED}]"#
                    .replacingOccurrences(
                        of: "REVOKED",
                        with: revoked ? "1" : "null"
                    ).utf8
            )
        )
    }

    private func statuses(ambiguous: Bool = false) throws -> [String: DesktopSourceHealth] {
        let body = ambiguous ? #"{"sourceId":"notes","state":"permission-degraded"}"# : #"{"sourceId":"notes","state":"error","members":[{"sourceId":"notes","deviceId":"remote","state":"permission-degraded"}]}"#
        return try ["notes": JSONDecoder().decode(DesktopSourceHealth.self, from: Data(body.utf8))]
    }

    func testRemoteMemberProblemRoutesOnlyToItsActualComputer() throws {
        let issues = try DesktopCollectionAccessIssue.resolve(sources: sources(), devices: devices(), statuses: statuses())
        XCTAssertEqual(issues.count, 1)
        XCTAssertEqual(issues.first?.target?.deviceId, "remote")
        XCTAssertEqual(issues.first?.target?.sourceId, "notes")
        XCTAssertEqual(issues.first?.computer, "Example library Mac")
    }

    func testPausedSourcesDoNotRequestUnneededPermissionRecovery() throws {
        XCTAssertTrue(try DesktopCollectionAccessIssue.resolve(sources: sources(enabled: false), devices: devices(), statuses: statuses())
            .isEmpty)
    }

    func testRevokedAndAmbiguousReportsNeverFallBackToThisMac() throws {
        let revoked = try DesktopCollectionAccessIssue.resolve(sources: sources(), devices: devices(revoked: true), statuses: statuses())
        XCTAssertNil(revoked.first?.target)
        let ambiguous = try DesktopCollectionAccessIssue.resolve(
            sources: sources(),
            devices: devices(),
            statuses: statuses(ambiguous: true)
        )
        XCTAssertNil(ambiguous.first?.target)
    }
}
