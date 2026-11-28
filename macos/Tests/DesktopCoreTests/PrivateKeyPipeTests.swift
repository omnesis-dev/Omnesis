// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import CryptoKit
import Foundation
import XCTest

final class PrivateKeyPipeTests: XCTestCase {
    private struct Fixture: Decodable {
        let format: Int
        let owner: String
        let nodeVersion: String
        let architecture: String
        let executableSha256: String
        let privateKeyFiles: [String: String]
    }

    func testProductionPrivateKeyHelperWithPinnedNodeAndSystemOpenSSL() throws {
        let fixture = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent(".node-fixture", isDirectory: true)
        let body = try Data(contentsOf: fixture.appendingPathComponent("node-fixture.json"))
        XCTAssertLessThan(body.count, 4096)
        let metadata = try JSONDecoder().decode(Fixture.self, from: body)
        XCTAssertEqual(metadata.format, 1)
        XCTAssertEqual(metadata.owner, "omnesis-desktop-node-test-fixture")
        XCTAssertTrue(metadata.nodeVersion.hasPrefix("24."))
        #if arch(arm64)
        XCTAssertEqual(metadata.architecture, "arm64")
        #else
        XCTAssertEqual(metadata.architecture, "x64")
        #endif
        let node = fixture.appendingPathComponent("node")
        try verify(node, hash: metadata.executableSha256)
        XCTAssertEqual(Set(metadata.privateKeyFiles.keys), Set([
            "package.json", "openssl-private-input.js", "node-command.js", "test.mjs",
            "gateway-lock.js", "windows-powershell.js", "managed-runtime-bootstrap.js",
            "environment.js", "generation.js", "fresh-install-errors.js", "data-operation-frame.js",
            "snapshot-retention-errors.js", "snapshot-retention-host.js", "snapshot-retention-delete.js",
            "snapshot-retention-record.js", "snapshot-retention-witness.js", "snapshot-owner.js",
        ]))
        for (name, hash) in metadata.privateKeyFiles {
            guard !name.contains("/"), !name.contains("..") else { throw CocoaError(.fileReadCorruptFile) }
            try verify(fixture.appendingPathComponent("private-key").appendingPathComponent(name), hash: hash)
        }

        let scratch = FileManager.default.temporaryDirectory.appendingPathComponent("omnesis-cert-pipe-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: scratch, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        defer { try? FileManager.default.removeItem(at: scratch) }
        let process = Process()
        process.executableURL = node
        process.arguments = [fixture.appendingPathComponent("private-key/test.mjs").path]
        process.environment = ["PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "HOME": scratch.path, "TMPDIR": scratch.path]
        let output = Pipe(), errors = Pipe()
        process.standardInput = FileHandle.nullDevice
        process.standardOutput = output
        process.standardError = errors
        try process.run()
        process.waitUntilExit()
        let stdout = output.fileHandleForReading.readDataToEndOfFile()
        let stderr = errors.fileHandleForReading.readDataToEndOfFile()
        XCTAssertEqual(process.terminationStatus, 0, String(decoding: stderr, as: UTF8.self))
        XCTAssertEqual(String(decoding: stdout, as: UTF8.self), "private-key-pipe:passed\n")
        XCTAssertTrue(try FileManager.default.contentsOfDirectory(atPath: scratch.path).isEmpty)
    }

    private func verify(_ url: URL, hash: String) throws {
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        var digest = SHA256()
        while let block = try handle.read(upToCount: 1024 * 1024), !block.isEmpty {
            digest.update(data: block)
        }
        guard digest.finalize().map({ String(format: "%02x", $0) }).joined() == hash else {
            throw CocoaError(.fileReadCorruptFile)
        }
    }
}
