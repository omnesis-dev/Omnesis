// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import DesktopCore
import XCTest

final class PrivateSaveFileTests: XCTestCase {
    private func directory() throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("omnesis-save-fixture-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: url) }
        return url
    }

    func testSuccessfulSaveIsOwnerReadableAndPersistsAfterRelease() throws {
        let url = try directory().appendingPathComponent("fixture.tar")
        let file = try PrivateSaveFile(url: url)
        try file.append(Data("fictional archive".utf8))
        try file.finish()
        file.discard()
        XCTAssertEqual(try Data(contentsOf: url), Data("fictional archive".utf8))
        let mode = try XCTUnwrap(FileManager.default.attributesOfItem(atPath: url.path)[.posixPermissions] as? NSNumber)
        XCTAssertEqual(mode.intValue & 0o777, 0o600)
    }

    func testFailureRemovesOwnPartialButNeverExistingDestination() throws {
        let url = try directory().appendingPathComponent("fixture.tar")
        let file = try PrivateSaveFile(url: url)
        try file.append(Data("partial".utf8))
        XCTAssertThrowsError(try PrivateSaveFile(url: url))
        file.discard()
        XCTAssertFalse(FileManager.default.fileExists(atPath: url.path))
    }

    func testReplacingPartialDoesNotAuthorizeDeletingReplacement() throws {
        let url = try directory().appendingPathComponent("fixture.tar")
        let file = try PrivateSaveFile(url: url)
        try file.append(Data("partial".utf8))
        try FileManager.default.removeItem(at: url)
        try Data("replacement".utf8).write(to: url)
        file.discard()
        XCTAssertEqual(try Data(contentsOf: url), Data("replacement".utf8))
    }

    func testSymlinkDestinationIsRefusedWithoutChangingTarget() throws {
        let root = try directory()
        let target = root.appendingPathComponent("existing.txt")
        let link = root.appendingPathComponent("fixture.tar")
        try Data("keep".utf8).write(to: target)
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: target)
        XCTAssertThrowsError(try PrivateSaveFile(url: link))
        XCTAssertEqual(try Data(contentsOf: target), Data("keep".utf8))
    }
}
