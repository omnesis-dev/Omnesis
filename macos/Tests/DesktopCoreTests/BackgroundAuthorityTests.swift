// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Darwin
@testable import DesktopCore
import Foundation
import XCTest

final class BackgroundAuthorityTests: XCTestCase {
    private func encoded(_ object: [String: Any]) throws -> String {
        try JSONSerialization.data(withJSONObject: object).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }

    private var descriptor: [String: Any] {
        ["version": 1, "epoch": String(repeating: "a", count: 64), "scope": [
            "format": 1, "configDir": "/example/owned-home", "instance": "desktop-" + String(repeating: "b", count: 16),
            "secretService": "dev.omnesis.desktop." + String(repeating: "b", count: 64),
        ]]
    }

    func testDescriptorRejectsArbitraryArgumentsAndWrongNonceMode() throws {
        let valid = try encoded(descriptor)
        XCTAssertNil(try DesktopBackgroundDaemonAuthority.decode(valid, requiresNonce: false).nonce)
        XCTAssertThrowsError(try DesktopBackgroundDaemonAuthority.decode(valid, requiresNonce: true))
        var daemon = descriptor
        daemon["nonce"] = UUID().uuidString.lowercased()
        XCTAssertNotNil(try DesktopBackgroundDaemonAuthority.decode(encoded(daemon), requiresNonce: true).nonce)
        XCTAssertThrowsError(try DesktopBackgroundDaemonAuthority.decode(encoded(daemon), requiresNonce: false))
        for key in ["executable", "argv", "environment", "cwd"] {
            var changed = descriptor
            changed[key] = "/example/untrusted"
            XCTAssertThrowsError(try DesktopBackgroundDaemonAuthority.decode(encoded(changed), requiresNonce: false))
        }
        XCTAssertThrowsError(try DesktopBackgroundDaemonAuthority.decode(valid + "=", requiresNonce: false))
    }

    func testActivationCannotSelectAnotherRuntimeOrReuseMalformedIdentifiers() throws {
        for identifier in ["not-a-uuid", UUID().uuidString.uppercased()] {
            var value = descriptor
            value["activation"] = [
                "operationId": identifier,
                "attemptId": UUID().uuidString.lowercased(),
                "epoch": String(repeating: "a", count: 64),
            ]
            XCTAssertThrowsError(try DesktopBackgroundDaemonAuthority.decode(encoded(value), requiresNonce: false))
        }
        var value = descriptor
        value["activation"] = [
            "operationId": UUID().uuidString.lowercased(),
            "attemptId": UUID().uuidString.lowercased(),
            "epoch": String(repeating: "c", count: 64),
        ]
        XCTAssertThrowsError(try DesktopBackgroundDaemonAuthority.decode(encoded(value), requiresNonce: false))
    }

    func testForgedOwnerFailsBeforeAnyProfileOrKeyAccess() throws {
        let value: [String: Any] = try [
            "format": 1, "scope": XCTUnwrap(descriptor["scope"]), "epoch": XCTUnwrap(descriptor["epoch"]),
            "nonce": UUID().uuidString.lowercased(), "helperPid": getpid(), "daemonPid": getpid(),
            "pipe": ["device": "0", "inode": "0"],
        ]
        XCTAssertThrowsError(try DesktopBackgroundDaemonAuthority.verifyOwner(
            encoded(value), runtime: URL(fileURLWithPath: "/example/" + String(repeating: "a", count: 64)), environment: [:]
        ))
        let actual = try DesktopBackgroundProcessIdentity.read(getpid())
        XCTAssertEqual(actual.pid, getpid())
        XCTAssertEqual(actual.parent, getppid())
    }

    func testMissingOwnedProfileIsReadOnlyAndGenerationKeepsRendezvousStable() throws {
        let temporary = FileManager.default.temporaryDirectory.appendingPathComponent("background-profile-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: temporary, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let home = try URL(fileURLWithPath: DesktopCanonicalPath.resolve(temporary.path))
        defer { try? FileManager.default.removeItem(at: home) }
        let original = try DesktopBackgroundManagedProfile.current(home: home)
        XCTAssertFalse(FileManager.default.fileExists(atPath: original.configDir))
        XCTAssertFalse(try original.configured())
        let external = URL(fileURLWithPath: original.configDir + ".bootstrap")
        try FileManager.default.createDirectory(at: external, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let generation = external.appendingPathComponent("generation.json")
        try JSONSerialization.data(withJSONObject: [
            "version": 1, "owner": "omnesis-desktop", "configIdentity": original.binding.configDirHash,
            "generation": UUID().uuidString.lowercased(),
        ]).write(to: generation)
        XCTAssertEqual(chmod(generation.path, 0o600), 0)
        let fresh = try DesktopBackgroundManagedProfile.current(home: home)
        XCTAssertNotEqual(original.instance, fresh.instance)
        XCTAssertNotEqual(original.secretService, fresh.secretService)
        XCTAssertEqual(try DesktopBackgroundSocket.path(original.binding), try DesktopBackgroundSocket.path(fresh.binding))
    }
}
