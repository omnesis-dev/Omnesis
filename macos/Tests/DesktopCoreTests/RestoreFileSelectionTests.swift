// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Darwin
@testable import DesktopCore
import XCTest

final class RestoreFileSelectionTests: XCTestCase {
    private func fixture() throws -> (URL, URL) {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("omnesis-selected-archive-\(UUID().uuidString)")
            .resolvingSymlinksInPath()
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: root) }
        let canonicalRoot = try URL(fileURLWithPath: DesktopCanonicalPath.resolve(root.path), isDirectory: true)
        let archive = canonicalRoot.appendingPathComponent("selected.tar")
        try Data("fictional selected archive".utf8).write(to: archive)
        return (canonicalRoot, archive)
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

    func testSelectedPathMatchesTheSidecarPOSIXIdentityAndRefusesAliasParents() throws {
        let (root, archive) = try fixture()
        let selected = try DesktopRestoreFileSelection.read(archive)
        XCTAssertEqual(selected.path, try DesktopCanonicalPath.resolve(archive.path))
        let alias = root.appendingPathComponent("folder-alias")
        try FileManager.default.createSymbolicLink(at: alias, withDestinationURL: root)
        XCTAssertThrowsError(try DesktopRestoreFileSelection.read(alias.appendingPathComponent("selected.tar")))
    }

    func testSignedPreEpochTimestampIsPreservedExactly() throws {
        let (_, archive) = try fixture()
        let times = [timespec(tv_sec: -1, tv_nsec: 500_000_000), timespec(tv_sec: -1, tv_nsec: 500_000_000)]
        XCTAssertEqual(utimensat(AT_FDCWD, archive.path, times, 0), 0)
        let selection = try DesktopRestoreFileSelection.read(archive)
        XCTAssertEqual(selection.mtimeSeconds, "-1")
        XCTAssertEqual(selection.mtimeNanoseconds, "500000000")
    }

    func testFIFOSelectionIsRefusedWithoutBlockingForAWriter() throws {
        let (root, _) = try fixture()
        let fifo = root.appendingPathComponent("named-pipe.tar")
        XCTAssertEqual(mkfifo(fifo.path, 0o600), 0)
        XCTAssertThrowsError(try DesktopRestoreFileSelection.read(fifo))
    }

    func testHardlinksCannotChangeMeaningAfterSelection() throws {
        let (root, archive) = try fixture()
        try FileManager.default.linkItem(at: archive, to: root.appendingPathComponent("other.tar"))
        XCTAssertThrowsError(try DesktopRestoreFileSelection.read(archive))
    }
}
