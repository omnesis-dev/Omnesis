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

    private func ownedHome() throws -> URL {
        let temporary = FileManager.default.temporaryDirectory.appendingPathComponent("update-generation-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: temporary, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let home = try URL(fileURLWithPath: DesktopCanonicalPath.resolve(temporary.path), isDirectory: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: home) }
        return home
    }

    private func publish(_ value: [String: Any], path: URL) throws {
        try FileManager.default.createDirectory(
            at: path.deletingLastPathComponent(),
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700]
        )
        let file = try PrivateSaveFile(url: path)
        try file.append(JSONSerialization.data(withJSONObject: value))
        try file.finish()
    }

    private func rotateGeneration(home: URL, previous: DesktopBackgroundManagedProfile) throws -> DesktopBackgroundManagedProfile {
        try publish([
            "version": 1, "owner": "omnesis-desktop", "configIdentity": previous.binding.configDirHash,
            "generation": UUID().uuidString.lowercased(),
            "previous": [
                "instance": previous.instance,
                "secretService": previous.secretService,
                "retirementId": UUID().uuidString.lowercased(),
            ],
        ], path: URL(fileURLWithPath: previous.configDir + ".bootstrap/generation.json"))
        return try DesktopBackgroundManagedProfile.current(home: home)
    }

    private func activeRecord(_ profile: DesktopBackgroundManagedProfile) -> [String: Any] {
        [
            "format": 1,
            "owner": "omnesis-desktop",
            "instance": profile.instance,
            "secretService": profile.secretService,
            "epoch": String(repeating: "a", count: 64),
            "productVersion": "1.2.3",
        ]
    }

    private func installer(home: URL) -> DesktopUpdateInstaller {
        DesktopUpdateInstaller(
            application: home.appendingPathComponent("Omnesis.app"),
            runtime: home.appendingPathComponent(String(repeating: "b", count: 64)),
            home: home
        )
    }

    func testActiveRuntimeAcceptsOriginalInstallationNamespace() async throws {
        let home = try ownedHome()
        let profile = try DesktopBackgroundManagedProfile.current(home: home)
        try publish(activeRecord(profile), path: URL(fileURLWithPath: profile.configDir + ".bootstrap/active-runtime.json"))
        let actual = try await installer(home: home).activeRuntime()
        XCTAssertEqual(actual.epoch, String(repeating: "a", count: 64))
        XCTAssertEqual(actual.version, "1.2.3")
    }

    func testActiveRuntimeAcceptsFreshGenerationNamespace() async throws {
        let home = try ownedHome()
        let previous = try DesktopBackgroundManagedProfile.current(home: home)
        let profile = try rotateGeneration(home: home, previous: previous)
        XCTAssertNotEqual(profile.instance, previous.instance)
        try publish(activeRecord(profile), path: URL(fileURLWithPath: profile.configDir + ".bootstrap/active-runtime.json"))
        let actual = try await installer(home: home).activeRuntime()
        XCTAssertEqual(actual.epoch, String(repeating: "a", count: 64))
        XCTAssertEqual(actual.version, "1.2.3")
    }

    func testActiveRuntimeRefusesPreviousGenerationAndAnotherOwnedHome() async throws {
        let home = try ownedHome()
        let previous = try DesktopBackgroundManagedProfile.current(home: home)
        try publish(activeRecord(previous), path: URL(fileURLWithPath: previous.configDir + ".bootstrap/active-runtime.json"))
        _ = try rotateGeneration(home: home, previous: previous)
        do {
            _ = try await installer(home: home).activeRuntime()
            XCTFail("An earlier generation cannot authorize this installation's update")
        } catch {}
        let otherHome = try ownedHome()
        let other = try DesktopBackgroundManagedProfile.current(home: otherHome)
        let current = try DesktopBackgroundManagedProfile.current(home: home)
        try publish(activeRecord(current), path: URL(fileURLWithPath: other.configDir + ".bootstrap/active-runtime.json"))
        do {
            _ = try await installer(home: otherHome).activeRuntime()
            XCTFail("Another home cannot authorize this installation's update")
        } catch {}
    }
}
