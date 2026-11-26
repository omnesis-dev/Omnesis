// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import CryptoKit
import Darwin
@testable import DesktopCore
import Foundation
import Security
import XCTest

/// Hosted, explicitly serialized component proof. This is not fixed-entry, signing, or TCC qualification.
final class DesktopRecoveryKeychainInteropTests: XCTestCase {
    func testOwnedUserKeychainLegacyReaderAndPrivateStdinAbsentOnlyInsertion() throws {
        var previous = DarwinBoolean(false)
        guard SecKeychainGetUserInteractionAllowed(&previous) == errSecSuccess else { throw InteropFailure.unavailable }
        defer {
            XCTAssertEqual(
                SecKeychainSetUserInteractionAllowed(previous.boolValue),
                errSecSuccess,
                "The prior process-local interaction policy must be restored"
            )
        }
        guard SecKeychainSetUserInteractionAllowed(false) == errSecSuccess else { throw InteropFailure.unavailable }
        let fixture = try RecoveryKeychainFixture()
        defer { fixture.cleanup() }
        try fixture.preflightAndArm()
        let initialKeychainStatus = fixture.keychainStatusSummary()
        print("KEY_RECOVERY_KEYCHAIN_STATUS " + initialKeychainStatus)
        try fixture.addLegacyMarker(fixture.storageMarker, value: "required")
        try fixture.addLegacyMarker(fixture.secretMarker, value: "different")

        // These nonsecret markers use the same ordinary CLI constructor as existing installations.
        let legacy = try fixture.operation("read", account: fixture.storageMarker)
        let physical = try fixture.readFailureDiagnostic(
            reply: legacy, account: fixture.storageMarker, expected: "required", initialStatus: initialKeychainStatus
        )
        XCTAssertTrue(legacy.code == 0 && legacy.stdout == "required\n", "The ordinary reader must open the legacy item; " + physical)
        XCTAssertEqual(try fixture.operation("repair-marker", account: fixture.storageMarker, value: "required").code, 0)
        XCTAssertEqual(try fixture.operation("repair-marker", account: fixture.secretMarker, value: "required").code, 1)
        let unchanged = try fixture.operation("read", account: fixture.secretMarker)
        let unchangedPhysical = try fixture.readFailureDiagnostic(
            reply: unchanged, account: fixture.secretMarker, expected: "different", initialStatus: initialKeychainStatus
        )
        XCTAssertTrue(
            unchanged.code == 0 && unchanged.stdout == "different\n",
            "Different existing state must remain unchanged; " + unchangedPhysical
        )

        XCTAssertEqual(DesktopKeyRecoveryWriteOnly.arguments, ["/usr/bin/security", "-q", "-i"])
        XCTAssertFalse(DesktopKeyRecoveryWriteOnly.arguments.contains { $0.contains(fixture.key) })
        XCTAssertEqual(try fixture.operation("insert-root", account: fixture.rootAccount, value: fixture.key).code, 0)
        let saved = try fixture.operation("read", account: fixture.rootAccount)
        let savedPhysical = try fixture.readFailureDiagnostic(
            reply: saved, account: fixture.rootAccount, expected: fixture.key, initialStatus: initialKeychainStatus
        )
        XCTAssertTrue(
            saved.code == 0 && saved.stdout == fixture.key + "\n",
            "The security reader must open the newly inserted root; " + savedPhysical
        )
        XCTAssertEqual(try fixture.operation("insert-root", account: fixture.rootAccount, value: fixture.key).code, 1)
        let again = try fixture.operation("read", account: fixture.rootAccount)
        let againPhysical = try fixture.readFailureDiagnostic(
            reply: again, account: fixture.rootAccount, expected: fixture.key, initialStatus: initialKeychainStatus
        )
        XCTAssertTrue(
            again.code == 0 && again.stdout == fixture.key + "\n",
            "A second insertion must not replace the root; " + againPhysical
        )
        XCTAssertTrue(try fixture.controlsContainNoKey(), "Invented key bytes must never be written into fixture controls")
    }
}

private enum InteropFailure: Error { case unavailable, unsafeFixture, refused, timedOut, cleanupUncertain }

private final class RecoveryKeychainFixture {
    let home: URL
    let config: URL
    let external: URL
    let service: String
    let rootAccount = "install-root-key-v1"
    let storageMarker: String
    let secretMarker: String
    let key: String
    private let keychain: SecKeychain
    private let context: DesktopKeyRecoveryAuthority.Context
    private let lease: DesktopDataUsageLease
    private let epoch = String(repeating: "a", count: 64)
    private var armed = false
    private var physicalReadRecorded = false
    private var accounts: [String] {
        [rootAccount, storageMarker, secretMarker]
    }

    init() throws {
        let epoch = String(repeating: "a", count: 64)
        let temporary = FileManager.default.temporaryDirectory.appendingPathComponent("recovery-keychain-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: temporary, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        let home = try URL(fileURLWithPath: DesktopCanonicalPath.resolve(temporary.path), isDirectory: true)
        let config = home.appendingPathComponent("library", isDirectory: true)
        let external = URL(fileURLWithPath: config.path + ".bootstrap", isDirectory: true)
        for path in [config, external] {
            try FileManager.default.createDirectory(at: path, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        }
        let hash = SHA256.hash(data: Data(config.path.utf8))
        let identity = hash.map { String(format: "%02x", $0) }.joined()
        let suffix = Data(hash).base64EncodedString().replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
        let service = "dev.omnesis.desktop." + identity
        let storageMarker = "storage-encryption-state-v1:" + String(suffix.prefix(12))
        let secretMarker = "secret-files-state-v1:" + String(suffix.prefix(12))
        let invented = Data(SHA256.hash(data: Data(UUID().uuidString.utf8)))
        let key = "omn_root_v1_" + Self.base64(invented)
        let instance = "desktop-" + String(identity.prefix(16))
        let binding: [String: Any] = ["owner": "omnesis-desktop", "instance": instance, "secretService": service]
        func bound(_ values: [String: Any]) -> [String: Any] {
            binding.merging(values) { _, value in value }
        }
        try Self.write(bound(["version": 3]), to: external.appendingPathComponent("process-authority.json"))
        try Self.write(
            bound(["version": 1, "phase": "configured", "mode": "home", "processAuthorityVersion": 3]),
            to: config.appendingPathComponent("desktop-install.json")
        )
        try Self.write(bound(["format": 1, "epoch": epoch]), to: external.appendingPathComponent("active-runtime.json"))
        var info = stat()
        guard lstat(config.path, &info) == 0 else { throw InteropFailure.unsafeFixture }
        let root = ["device": String(info.st_dev), "inode": String(info.st_ino)]
        let updateId = UUID().uuidString.lowercased(), restoreId = UUID().uuidString.lowercased()
        let keyDigest = SHA256.hash(data: invented).map { String(format: "%02x", $0) }.joined()
        try Self.write(
            bound([
                "format": 1,
                "operationId": updateId,
                "phase": "complete",
                "root": root,
                "oldEpoch": String(repeating: "b", count: 64),
                "candidateEpoch": epoch,
            ]),
            to: external.appendingPathComponent("update.json")
        )
        try Self.write(bound([
            "version": 1,
            "operationId": restoreId,
            "phase": "recovery-required",
            "root": root,
            "targetKeyDigest": keyDigest,
        ]), to: external.appendingPathComponent("restore.json"))
        let metadata: [String: Any] = [
            "version": 1, "scope": ["format": 1, "configDir": config.path, "instance": instance, "secretService": service],
            "root": root, "update": ["operationId": updateId, "phase": "complete"],
            "restore": ["operationId": restoreId, "phase": "recovery-required", "targetKeyDigest": keyDigest],
        ]
        let context = try DesktopKeyRecoveryAuthority.decode(Self.base64(JSONSerialization.data(withJSONObject: metadata)))
        let lease = try DesktopDataUsageLease.acquireKeyRecovery(context, epoch: epoch)
        var selected: SecKeychain?
        guard SecKeychainCopyDomainDefault(.user, &selected) == errSecSuccess, let selected else { throw InteropFailure.unavailable }
        self.home = home
        self.config = config
        self.external = external
        self.service = service
        self.storageMarker = storageMarker
        self.secretMarker = secretMarker
        self.key = key
        self.context = context
        self.lease = lease
        keychain = selected
    }

    func preflightAndArm() throws {
        guard service.hasPrefix("dev.omnesis.desktop."), service.count == 84 else { throw InteropFailure.unsafeFixture }
        for account in accounts {
            guard metadataStatus(account) == errSecItemNotFound,
                  try security(.find, account: account) == 44 else { throw InteropFailure.unavailable }
        }
        // No existing, unreadable or uncertain namespace is adopted. No key value enters this receipt.
        try Self.write([
            "format": 1,
            "owner": "omnesis-recovery-keychain-fixture",
            "phase": "cleanup-pending",
            "service": service,
            "accounts": accounts,
        ], to: home.appendingPathComponent("cleanup-pending.json"))
        let fd = Darwin.open(home.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
        guard fd >= 0 else { throw InteropFailure.unsafeFixture }
        defer { Darwin.close(fd) }
        guard fsync(fd) == 0 else { throw InteropFailure.unsafeFixture }
        armed = true
    }

    func addLegacyMarker(_ account: String, value: String) throws {
        guard armed, [storageMarker, secretMarker].contains(account), ["required", "different"].contains(value) else {
            throw InteropFailure.unsafeFixture
        }
        guard metadataStatus(account) == errSecItemNotFound, try security(.find, account: account) == 44 else {
            throw InteropFailure.unsafeFixture
        }
        var path = [CChar](repeating: 0, count: Int(PATH_MAX) + 1)
        var count = UInt32(path.count)
        guard SecKeychainGetPath(keychain, &count, &path) == errSecSuccess, count > 0, count < UInt32(path.count) else {
            throw InteropFailure.unavailable
        }
        let selectedPath = String(cString: path)
        guard selectedPath.hasPrefix("/") else { throw InteropFailure.unsafeFixture }
        let arguments = [
            "add-generic-password", "-a", account, "-s", service, "-w", value, "-T", "/usr/bin/security", selectedPath,
        ]
        // Only the two fixed nonsecret marker values may be password arguments. Never pass the root key or update flags.
        guard !arguments.contains("-U"), !arguments.contains("-A"), try runSecurity(arguments) == 0,
              metadataStatus(account) == errSecSuccess else { throw InteropFailure.refused }
    }

    func operation(_ operation: String, account: String, value: String? = nil) throws -> DesktopKeyRecoveryKeychain.Reply {
        guard armed, accounts.contains(account) else { throw InteropFailure.unsafeFixture }
        var request: [String: Any] = ["version": 1, "operation": operation, "account": account]
        if let value { request["value"] = value }
        return try DesktopKeyRecoveryKeychain.perform(
            input: JSONSerialization.data(withJSONObject: request),
            context: context,
            epoch: epoch,
            lease: lease
        )
    }

    func keychainStatusSummary() -> String {
        var status: SecKeychainStatus = 0
        guard SecKeychainGetStatus(keychain, &status) == errSecSuccess else { return "status=unavailable" }
        return "status=available unlocked=\(status & SecKeychainStatus(kSecUnlockStateStatus) != 0) "
            + "read=\(status & SecKeychainStatus(kSecReadPermStatus) != 0) write=\(status & SecKeychainStatus(kSecWritePermStatus) != 0)"
    }

    func readFailureDiagnostic(
        reply: DesktopKeyRecoveryKeychain.Reply, account: String, expected: String, initialStatus: String
    ) throws
        -> String {
        guard armed, accounts.contains(account) else { throw InteropFailure.unsafeFixture }
        if reply.code == 0, reply.stdout == expected + "\n" { return "" }
        guard !physicalReadRecorded else { return "physicalReadRecordedEarlier=true" }
        physicalReadRecorded = true
        let selectorKind = account == storageMarker ? "cliRequiredMarker" : account == secretMarker ? "cliDifferentMarker" : "nativeRoot"
        try DesktopKeyRecoveryAuthority.validate(context, epoch: epoch)
        let held = try lease.keyRecoveryDescriptor(scope: context.scope)
        defer { Darwin.close(held) }
        let currentStatus = keychainStatusSummary()
        // Discard secret bytes immediately; only fixed metadata leaves this fixture method.
        let outcome = try DesktopKeyRecoveryReadOnly.run(
            account: account, scope: context.scope, secret: true, dataDescriptor: held
        ).physical
        try DesktopKeyRecoveryAuthority.validate(context, epoch: epoch)
        return "selectorKind=\(selectorKind) before[\(initialStatus)] current[\(currentStatus)] " + outcome.summary
    }

    func controlsContainNoKey() throws -> Bool {
        for directory in [home, config, external] {
            for file in try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: [.isRegularFileKey])
                where try file.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile == true {
                if try Data(contentsOf: file).range(of: Data(key.utf8)) != nil { return false }
            }
        }
        return true
    }

    func cleanup() {
        var absent = true
        if armed {
            for account in accounts {
                do {
                    let deleted = try security(.delete, account: account)
                    if try !(deleted == 0 || deleted == 44) || metadataStatus(account) != errSecItemNotFound ||
                        security(.find, account: account) != 44 { absent = false }
                } catch { absent = false }
            }
        }
        if absent { try? FileManager.default.removeItem(at: home) }
        else { XCTFail("Owned recovery Keychain cleanup could not be confirmed; its private cleanup receipt was retained.") }
    }

    private func metadataStatus(_ account: String) -> OSStatus {
        guard accounts.contains(account) else { return errSecParam }
        var item: SecKeychainItem?
        return service.withCString { serviceBytes in account.withCString { accountBytes in
            SecKeychainFindGenericPassword(
                keychain,
                UInt32(service.utf8.count),
                serviceBytes,
                UInt32(account.utf8.count),
                accountBytes,
                nil,
                nil,
                &item
            )
        } }
    }

    private enum SecurityAction: String { case find = "find-generic-password", delete = "delete-generic-password" }
    private func security(_ action: SecurityAction, account: String) throws -> Int32 {
        guard accounts.contains(account) else { throw InteropFailure.unsafeFixture }
        let arguments = [action.rawValue, "-a", account, "-s", service]
        return try runSecurity(arguments)
    }

    private func runSecurity(_ arguments: [String]) throws -> Int32 {
        guard !arguments.contains(key) else { throw InteropFailure.unsafeFixture }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/security")
        process.arguments = arguments
        process.environment = [
            "HOME": FileManager.default.homeDirectoryForCurrentUser.path,
            "PATH": "/usr/bin:/bin:/usr/sbin:/sbin",
            "LANG": "en_US.UTF-8",
        ]
        process.standardInput = FileHandle.nullDevice
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        let terminate = DispatchWorkItem { if process.isRunning { process.terminate() } }
        let kill = DispatchWorkItem { if process.isRunning { Darwin.kill(process.processIdentifier, SIGKILL) } }
        try process.run()
        DispatchQueue.global().asyncAfter(deadline: .now() + 10, execute: terminate)
        DispatchQueue.global().asyncAfter(deadline: .now() + 12, execute: kill)
        defer { terminate.cancel()
            kill.cancel()
        }
        process.waitUntilExit()
        guard process.terminationReason == .exit else { throw InteropFailure.timedOut }
        return process.terminationStatus
    }

    private static func write(_ value: [String: Any], to path: URL) throws {
        let file = try PrivateSaveFile(url: path)
        try file.append(JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]))
        try file.finish()
    }

    private static func base64(_ data: Data) -> String {
        data.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}
