// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import DesktopCore
import XCTest

final class RecoveryFileTests: XCTestCase {
    private func directory() throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("omnesis-recovery-file-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: url) }
        return url
    }

    func testReadsOnlyBoundedJSONObjectFromSelectedRegularFile() throws {
        let file = try directory().appendingPathComponent("recovery.json")
        try Data(#"{"omnesis":"fictional-test-envelope"}"#.utf8).write(to: file)
        XCTAssertEqual(try DesktopRecoveryFile.read(file), .object(["omnesis": .string("fictional-test-envelope")]))
        try Data(repeating: 65, count: 16385).write(to: file)
        XCTAssertThrowsError(try DesktopRecoveryFile.read(file))
        try Data("[]".utf8).write(to: file)
        XCTAssertThrowsError(try DesktopRecoveryFile.read(file))
    }

    func testRefusesDirectoriesAndSymbolicLinks() throws {
        let root = try directory()
        XCTAssertThrowsError(try DesktopRecoveryFile.read(root))
        let target = root.appendingPathComponent("recovery.json")
        try Data("{}".utf8).write(to: target)
        let link = root.appendingPathComponent("link.json")
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: target)
        XCTAssertThrowsError(try DesktopRecoveryFile.read(link))
    }

    func testOnlyConfirmedImportStatusesRepresentSuccessfulRecovery() throws {
        let decoder = JSONDecoder()
        for status in ["restored", "already-available", "failed", "pending"] {
            let json = #"{"kind":"desktopRecoveryImport","status":"\#(status)"}"#
            let outcome = try decoder.decode(DesktopRecoveryImportOutcome.self, from: Data(json.utf8))
            XCTAssertEqual(outcome.verified, ["restored", "already-available"].contains(status))
        }
    }
}
