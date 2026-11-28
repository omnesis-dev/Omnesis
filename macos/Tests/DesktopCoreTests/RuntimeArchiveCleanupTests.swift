// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import CryptoKit
@testable import DesktopCore
import XCTest

final class RuntimeArchiveCleanupTests: XCTestCase {
    private var root: URL!
    private var cache: URL {
        root.appendingPathComponent("runtime", isDirectory: true)
    }

    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent("omnesis-code-cleanup-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: cache, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        root = try URL(fileURLWithPath: DesktopCanonicalPath.resolve(root.path), isDirectory: true)
    }

    override func tearDownWithError() throws {
        try FileManager.default.removeItem(at: root)
    }

    private func epoch(_ tag: String) throws -> (runtime: URL, archive: URL) {
        let manifest = try JSONSerialization.data(withJSONObject: [
            "format": 1, "codeUsageProtocol": 1, "processAuthorityProtocol": 3, "runtimeLauncher": "runtime-exec", "fixture": tag,
            "inventory": [["path": "node", "executable": true], ["path": "runtime-exec", "executable": true]],
        ], options: [.sortedKeys])
        let epoch = SHA256.hash(data: manifest).map { String(format: "%02x", $0) }.joined()
        let runtime = cache.appendingPathComponent(epoch, isDirectory: true)
        try FileManager.default.createDirectory(at: runtime, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        try manifest.write(to: runtime.appendingPathComponent("desktop-runtime.json"))
        let app = root.appendingPathComponent("source-" + tag + "/Omnesis.app", isDirectory: true)
        let resources = app.appendingPathComponent("Contents/Resources/runtime", isDirectory: true)
        try FileManager.default.createDirectory(at: resources, withIntermediateDirectories: true)
        try manifest.write(to: resources.appendingPathComponent("desktop-runtime.json"))
        let archive = try DesktopApplicationArchive.retain(
            application: app, epoch: epoch,
            root: root.appendingPathComponent("applications", isDirectory: true), publicationRoot: cache
        ) { application in
            XCTAssertEqual(
                try Data(contentsOf: application.appendingPathComponent("Contents/Resources/runtime/desktop-runtime.json")),
                manifest
            )
        }
        return (runtime, archive.deletingLastPathComponent())
    }

    func testPairedCleanupHoldsTheSameUsageGuardForRuntimeAndWholeApplication() throws {
        let f = try epoch("paired")
        var held: DesktopRuntimeUsageLease? = try DesktopRuntimeUsageLease.acquire(runtime: f.runtime)
        XCTAssertFalse(try DesktopRuntimeUsageLease.removeReclaimableRuntime(
            cache: cache,
            epoch: f.runtime.lastPathComponent,
            currentEpoch: "current"
        ))
        XCTAssertTrue(FileManager.default.fileExists(atPath: f.archive.path))
        withExtendedLifetime(held) {}
        held = nil
        XCTAssertTrue(try DesktopRuntimeUsageLease.removeReclaimableRuntime(
            cache: cache,
            epoch: f.runtime.lastPathComponent,
            currentEpoch: "current"
        ))
        XCTAssertFalse(FileManager.default.fileExists(atPath: f.runtime.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: f.archive.path))
    }

    func testMissingArchiveOwnershipNeverDeletesEitherCodeTree() throws {
        let f = try epoch("unproven")
        try FileManager.default.removeItem(at: f.archive.appendingPathComponent(DesktopApplicationArchiveOwnership.filename))
        XCTAssertFalse(try DesktopRuntimeUsageLease.removeReclaimableRuntime(
            cache: cache,
            epoch: f.runtime.lastPathComponent,
            currentEpoch: "current"
        ))
        XCTAssertTrue(FileManager.default.fileExists(atPath: f.runtime.path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: f.archive.path))
    }

    func testPartialArchiveDeletionRetainsDualIdentityAndCanRetryWithoutItsMarker() throws {
        let f = try epoch("partial")
        enum Interrupted: Error { case fixture }
        XCTAssertThrowsError(try DesktopRuntimeUsageLease.removeReclaimableRuntime(
            cache: cache,
            epoch: f.runtime.lastPathComponent,
            currentEpoch: "current"
        ) { target in
            XCTAssertEqual(target, f.archive)
            try FileManager.default.removeItem(at: target.appendingPathComponent(DesktopApplicationArchiveOwnership.filename))
            throw Interrupted.fixture
        })
        XCTAssertThrowsError(try DesktopRuntimeUsageLease.acquire(runtime: f.runtime))
        XCTAssertTrue(try DesktopRuntimeUsageLease.removeReclaimableRuntime(
            cache: cache,
            epoch: f.runtime.lastPathComponent,
            currentEpoch: "current"
        ))
        XCTAssertFalse(FileManager.default.fileExists(atPath: f.archive.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: f.runtime.path))
    }

    func testDualReceiptCannotDeleteAnAdoptedReplacementArchive() throws {
        let f = try epoch("replacement")
        enum Interrupted: Error { case fixture }
        XCTAssertThrowsError(try DesktopRuntimeUsageLease.removeReclaimableRuntime(
            cache: cache,
            epoch: f.runtime.lastPathComponent,
            currentEpoch: "current"
        ) { _ in throw Interrupted.fixture })
        try FileManager.default.moveItem(at: f.archive, to: root.appendingPathComponent("original-archive"))
        try FileManager.default.createDirectory(at: f.archive, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        let sentinel = f.archive.appendingPathComponent("must-stay")
        try Data("fictional unrelated code".utf8).write(to: sentinel)
        XCTAssertThrowsError(try DesktopRuntimeUsageLease.removeReclaimableRuntime(
            cache: cache,
            epoch: f.runtime.lastPathComponent,
            currentEpoch: "current"
        ))
        XCTAssertTrue(FileManager.default.fileExists(atPath: sentinel.path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: f.runtime.path))
    }
}
