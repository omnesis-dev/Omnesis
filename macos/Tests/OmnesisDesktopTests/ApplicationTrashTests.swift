// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import DesktopCore
@testable import OmnesisDesktop
import XCTest

@MainActor
final class ApplicationTrashTests: XCTestCase {
    private func outcome(_ status: String, data: String, keyring: String) throws -> DesktopRemovalOutcome {
        let json = #"{"status":"\#(status)","data":"\#(data)","keyring":"\#(keyring)"}"#
        return try JSONDecoder().decode(DesktopRemovalOutcome.self, from: Data(json.utf8))
    }

    func testPendingKeyCleanupNeverAuthorizesApplicationTrash() throws {
        let pending = try outcome("key-cleanup-pending", data: "erased", keyring: "pending")
        XCTAssertThrowsError(try DesktopApplicationTrash.target(
            after: pending,
            application: URL(fileURLWithPath: "/Applications/Omnesis.app"),
            identifier: "dev.omnesis.desktop"
        ))
    }

    func testCompletedRemovalStillRefusesUnrelatedBundlesAndNonApplications() throws {
        let finished = try outcome("retired", data: "retained", keyring: "retained")
        XCTAssertThrowsError(try DesktopApplicationTrash.target(
            after: finished,
            application: URL(fileURLWithPath: "/Applications/Example.app"),
            identifier: "org.example.other"
        ))
        XCTAssertThrowsError(try DesktopApplicationTrash.target(
            after: finished,
            application: URL(fileURLWithPath: "/tmp/omnesis-library"),
            identifier: "dev.omnesis.desktop"
        ))
    }
}
