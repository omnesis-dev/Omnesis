// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import DesktopCore
import XCTest

private final class CopyCheckpoint: @unchecked Sendable {
    private let lock = NSLock()
    private var calls = 0
    func check() throws {
        lock.lock()
        defer { lock.unlock() }
        calls += 1
        if calls >= 3 { throw CancellationError() }
    }
}

final class CodeCopyTests: XCTestCase {
    private func fixture() throws -> (URL, URL) {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("omnesis-code-copy-\(UUID().uuidString)")
            .resolvingSymlinksInPath()
        let source = root.appendingPathComponent("source")
        try FileManager.default.createDirectory(at: source, withIntermediateDirectories: true)
        for index in 0 ..< 10 {
            try Data("public fixture code".utf8).write(to: source.appendingPathComponent("file-\(index)"))
        }
        addTeardownBlock { try? FileManager.default.removeItem(at: root) }
        return (source, root.appendingPathComponent("destination"))
    }

    func testCopiesCodeTreeAndPreservesExecutablePermission() throws {
        let (source, destination) = try fixture()
        let executable = source.appendingPathComponent("file-0")
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: executable.path)
        try DesktopCodeCopy.copyTree(source: source, destination: destination)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: destination.path).count, 10)
        XCTAssertTrue(FileManager.default.isExecutableFile(atPath: destination.appendingPathComponent("file-0").path))
    }

    func testCancellationAtFileBoundaryIsNotAcceptedAsSuccessfulPartialCopy() throws {
        let (source, destination) = try fixture()
        let checkpoint = CopyCheckpoint()
        XCTAssertThrowsError(try DesktopCodeCopy.copyTree(
            source: source,
            destination: destination,
            checkCancellation: { try checkpoint.check() }
        )) { error in
            XCTAssertTrue(error is CancellationError)
        }
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: source.path).count, 10)
    }
}
