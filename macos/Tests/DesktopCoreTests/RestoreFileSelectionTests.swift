// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import DesktopCore
import XCTest

final class RestoreFileSelectionTests: XCTestCase {
    private func fixture() throws -> (URL, URL) {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("omnesis-selected-archive-\(UUID().uuidString)")
            .resolvingSymlinksInPath()
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: root) }
        let archive = root.appendingPathComponent("selected.tar")
        try Data("fictional selected archive".utf8).write(to: archive)
        return (root, archive)
    }

    func testCapturesExactFileIdentityWithoutCopyingOriginal() throws {
        let (root, archive) = try fixture()
        let selected = try DesktopRestoreFileSelection.read(archive)
        XCTAssertEqual(selected.path, archive.path)
        XCTAssertEqual(selected.bytes, Int64(Data("fictional selected archive".utf8).count))
        XCTAssertFalse(selected.device.isEmpty)
        XCTAssertFalse(selected.inode.isEmpty)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: root.path), ["selected.tar"])
        let encoded = try JSONSerialization.jsonObject(with: JSONEncoder().encode(selected)) as? [String: Any]
        XCTAssertTrue(encoded?["mtimeSeconds"] is String)
        XCTAssertTrue(encoded?["mtimeNanoseconds"] is String)
    }

    func testRejectsLinksDirectoriesAndOversizedSelections() throws {
        let (root, archive) = try fixture()
        let link = root.appendingPathComponent("link.tar")
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: archive)
        XCTAssertThrowsError(try DesktopRestoreFileSelection.read(link))
        XCTAssertThrowsError(try DesktopRestoreFileSelection.read(root))
        XCTAssertThrowsError(try DesktopRestoreFileSelection.read(archive, maxBytes: 1))
    }

    func testHardlinksCannotChangeMeaningAfterSelection() throws {
        let (root, archive) = try fixture()
        try FileManager.default.linkItem(at: archive, to: root.appendingPathComponent("other.tar"))
        XCTAssertThrowsError(try DesktopRestoreFileSelection.read(archive))
    }
}
