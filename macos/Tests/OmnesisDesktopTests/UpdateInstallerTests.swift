// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import CryptoKit
import DesktopCore
@testable import OmnesisDesktop
import XCTest

final class UpdateInstallerTests: XCTestCase {
    func testMissingReceiptBindingIsRefusedBeforePlatformAction() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("omnesis-update-binding-\(UUID().uuidString)")
        let installer = DesktopUpdateInstaller(
            application: root.appendingPathComponent("Omnesis.app"),
            runtime: root.appendingPathComponent(String(repeating: "a", count: 64)),
            home: root
        )
        let prompt = try JSONDecoder().decode(
            RuntimeInteraction.self,
            from: Data(#"{"id":"fixture","kind":"openDesktopInstaller","oldEpoch":"a","candidateEpoch":"b"}"#.utf8)
        )
        do {
            _ = try await DesktopUpdateInteraction.respond(to: prompt, installer: installer)
            XCTFail("Missing receipt binding must never open an installer")
        } catch {}
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.path))
    }

    func testUnsignedDownloadedImageIsRefusedBeforeAnyMountOrMetadataRead() async throws {
        let home = FileManager.default.temporaryDirectory.appendingPathComponent("omnesis-installer-fixture-\(UUID().uuidString)")
            .resolvingSymlinksInPath()
        let updates = home.appendingPathComponent("Library/Application Support/Omnesis Desktop.bootstrap/updates")
        try FileManager.default.createDirectory(at: updates, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        addTeardownBlock { try? FileManager.default.removeItem(at: home) }
        let bytes = Data("inert unsigned test image".utf8)
        let hash = SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
        let artifact = updates.appendingPathComponent(hash + ".dmg")
        let file = try PrivateSaveFile(url: artifact)
        try file.append(bytes)
        try file.finish()
        let epoch = String(repeating: "a", count: 64)
        let installer = DesktopUpdateInstaller(
            application: home.appendingPathComponent("Omnesis.app"),
            runtime: home.appendingPathComponent(epoch),
            home: home
        )
        do {
            _ = try await installer.verify(
                artifactPath: artifact.path,
                artifactHash: hash,
                oldEpoch: epoch,
                version: "1.2.3",
                architecture: "arm64"
            )
            XCTFail("Unsigned images must never reach mount or metadata processing")
        } catch {}
        XCTAssertFalse(FileManager.default.fileExists(atPath: updates.appendingPathComponent("mounts").path))
        XCTAssertEqual(try Data(contentsOf: artifact), bytes)
    }
}
