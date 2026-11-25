// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import CryptoKit
import DesktopCore
import Foundation
import XCTest

final class RuntimeCacheTests: XCTestCase {
    private var root: URL!
    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent("omnesis-runtime-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        root = root.resolvingSymlinksInPath()
    }

    override func tearDownWithError() throws {
        try FileManager.default.removeItem(at: root)
    }

    private func source(extra: [[String: Any]] = []) throws -> URL {
        let source = root.appendingPathComponent("source")
        let script = source.appendingPathComponent("packages/cli/dist/index.js")
        try FileManager.default.createDirectory(at: script.deletingLastPathComponent(), withIntermediateDirectories: true)
        let node = Data("fixture executable".utf8)
        let js = Data("fixture module".utf8)
        try node.write(to: source.appendingPathComponent("node"))
        try js.write(to: script)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: source.appendingPathComponent("node").path)
        #if arch(arm64)
        let architecture = "arm64"
        #else
        let architecture = "x64"
        #endif
        let inventory: [[String: Any]] = [
            ["path": "node", "bytes": node.count, "executable": true, "sha256": hash(node)],
            ["path": "packages/cli/dist/index.js", "bytes": js.count, "executable": false, "sha256": hash(js)],
        ] + extra
        try JSONSerialization.data(
            withJSONObject: ["format": 1, "architecture": architecture, "nodeVersion": "24.21.0", "inventory": inventory],
            options: [.sortedKeys]
        )
        .write(to: source.appendingPathComponent("desktop-runtime.json"))
        return source
    }

    private func hash(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    private var cache: URL {
        root.appendingPathComponent("cache")
    }

    func testPublishedPathsSurviveReplacementAndAreReused() throws {
        let source = try source()
        var validations = 0
        let runtime = try DesktopRuntimeCache.prepare(source: source, cacheRoot: cache) { validations += 1 }
        XCTAssertEqual(validations, 2)
        XCTAssertEqual(runtime.lastPathComponent.count, 64)
        XCTAssertEqual(try DesktopRuntimeCache.prepare(source: source, cacheRoot: cache, validateSource: {}), runtime)
        try FileManager.default.removeItem(at: source)
        XCTAssertEqual(try Data(contentsOf: runtime.appendingPathComponent("node")), Data("fixture executable".utf8))
    }

    func testCorruptedPublishedPayloadIsRefusedRatherThanRepairedInPlace() throws {
        let source = try source()
        let runtime = try DesktopRuntimeCache.prepare(source: source, cacheRoot: cache, validateSource: {})
        try Data("tampered".utf8).write(to: runtime.appendingPathComponent("packages/cli/dist/index.js"))
        XCTAssertThrowsError(try DesktopRuntimeCache.prepare(source: source, cacheRoot: cache, validateSource: {}))
    }

    func testExtraFileAndEscapingPathsAreRefused() throws {
        let source = try source(extra: [[
            "path": "../escape",
            "bytes": 1,
            "executable": false,
            "sha256": String(repeating: "a", count: 64),
        ]])
        XCTAssertThrowsError(try DesktopRuntimeCache.prepare(source: source, cacheRoot: cache, validateSource: {}))
        try FileManager.default.removeItem(at: source)
        let valid = try self.source()
        try Data("unlisted".utf8).write(to: valid.appendingPathComponent("extra.js"))
        XCTAssertThrowsError(try DesktopRuntimeCache.prepare(source: valid, cacheRoot: cache, validateSource: {}))
    }

    func testEscapingSymlinkIsRefused() throws {
        let source = try source(extra: [["path": "escape", "symlink": "../../outside"]])
        try Data("outside".utf8).write(to: root.appendingPathComponent("outside"))
        try FileManager.default.createSymbolicLink(
            atPath: source.appendingPathComponent("escape").path,
            withDestinationPath: "../../outside"
        )
        XCTAssertThrowsError(try DesktopRuntimeCache.prepare(source: source, cacheRoot: cache, validateSource: {}))
    }

    func testSourceTrustFailureNeverCreatesCache() throws {
        let source = try source()
        XCTAssertThrowsError(try DesktopRuntimeCache.prepare(source: source, cacheRoot: cache, validateSource: {
            throw DesktopRuntimeCache.Failure.invalidPayload
        }))
        XCTAssertFalse(FileManager.default.fileExists(atPath: cache.path))
    }

    func testSymlinkCacheIsRefused() throws {
        let source = try source()
        let other = root.appendingPathComponent("other")
        try FileManager.default.createDirectory(at: other, withIntermediateDirectories: false)
        try FileManager.default.createSymbolicLink(at: cache, withDestinationURL: other)
        XCTAssertThrowsError(try DesktopRuntimeCache.prepare(source: source, cacheRoot: cache, validateSource: {}))
    }
}
