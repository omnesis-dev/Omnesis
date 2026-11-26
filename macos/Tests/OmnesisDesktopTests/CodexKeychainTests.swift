// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import CryptoKit
import Darwin
import Foundation
import Security
import XCTest

final class CodexKeychainTests: XCTestCase {
    private struct Fixture: Decodable {
        let format: Int
        let owner: String
        let version: String
        let architecture: String
        let integrity: String
        let executableSha256: String
    }

    private enum Failure: Error {
        case fixtureInvalid, scopeUnavailable, keychainRefused, processTimedOut, cleanupUncertain
        case localSaveRefused(status: Int32, classification: String)
    }

    func testPinnedCodexUsesOnlyItsCanonicalOwnedKeychainAccountWithoutPlaintextFallback() throws {
        let fixture = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().appendingPathComponent(".codex-keychain-fixture", isDirectory: true)
        let metadata = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: fixture.appendingPathComponent("codex-fixture.json")))
        guard metadata.format == 1, metadata.owner == "omnesis-desktop-codex-keychain-test-fixture",
              metadata.integrity.hasPrefix("sha512-"),
              metadata.version.split(separator: ".").count == 3 else { throw Failure.fixtureInvalid }
        #if arch(arm64)
        XCTAssertEqual(metadata.architecture, "arm64")
        #else
        XCTAssertEqual(metadata.architecture, "x64")
        #endif
        let codex = fixture.appendingPathComponent("codex")
        let handle = try FileHandle(forReadingFrom: codex)
        var digest = SHA256()
        while let chunk = try handle.read(upToCount: 1024 * 1024), !chunk.isEmpty {
            digest.update(data: chunk)
        }
        try handle.close()
        guard digest.finalize().map({ String(format: "%02x", $0) }).joined() == metadata.executableSha256
        else { throw Failure.fixtureInvalid }

        let root = FileManager.default.temporaryDirectory.appendingPathComponent("omnesis-codex-keychain-" + UUID().uuidString)
            .resolvingSymlinksInPath()
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        let first = root.appendingPathComponent("first", isDirectory: true)
        let second = root.appendingPathComponent("second", isDirectory: true)
        for home in [first, second] {
            try FileManager.default.createDirectory(at: home, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        }
        // Match Rust std::fs::canonicalize using POSIX realpath, independently of URL normalization.
        let firstCanonical = try canonicalPath(first)
        XCTAssertEqual(try canonicalPath(URL(fileURLWithPath: firstCanonical)), firstCanonical)
        let account = try namespace(first), other = try namespace(second)
        let service = ["Codex", "Auth"].joined(separator: " ")
        var explicitKeychainPath: String?
        func security(_ command: String, _ selected: String, explicit: Bool = false) throws -> Int32 {
            var arguments = [command, "-a", selected, "-s", service]
            if explicit { try arguments.append(XCTUnwrap(explicitKeychainPath)) }
            return try run(URL(fileURLWithPath: "/usr/bin/security"), arguments, home: root)
        }
        var userKeychain: SecKeychain?
        guard SecKeychainCopyDomainDefault(.user, &userKeychain) == errSecSuccess,
              let selectedKeychain = userKeychain else { throw Failure.scopeUnavailable }
        var pathBytes = [CChar](repeating: 0, count: 4096)
        var pathLength = UInt32(pathBytes.count - 1)
        guard SecKeychainGetPath(selectedKeychain, &pathLength, &pathBytes) == errSecSuccess else {
            throw Failure.scopeUnavailable
        }
        explicitKeychainPath = String(cString: pathBytes)
        func nativeMetadataStatus(_ selected: String) -> OSStatus {
            var item: SecKeychainItem?
            return service.withCString { serviceBytes in
                selected.withCString { accountBytes in
                    SecKeychainFindGenericPassword(
                        selectedKeychain, UInt32(service.utf8.count), serviceBytes,
                        UInt32(selected.utf8.count), accountBytes, nil, nil, &item
                    )
                }
            }
        }
        guard nativeMetadataStatus(account) == errSecItemNotFound,
              nativeMetadataStatus(other) == errSecItemNotFound else { throw Failure.scopeUnavailable }
        // Existing or unreadable scopes are never overwritten, adopted, or deleted.
        guard try security("find-generic-password", account) == 44,
              try security("find-generic-password", other) == 44 else { throw Failure.scopeUnavailable }
        XCTAssertNotEqual(account, other)
        let policy = [
            "-c",
            "cli_auth_credentials_store=\"keyring\"",
            "-c",
            "features.secret_auth_storage=false",
            "-c",
            "history.persistence=\"none\"",
            "-c",
            "analytics.enabled=false",
            "-c",
            "otel.log_user_prompt=false",
        ]
        var mayHaveCreated = false
        defer {
            var absent = !mayHaveCreated
            if mayHaveCreated {
                do {
                    // Vendor status independently checks the same namespace used by its writer.
                    // A security-tool not-found result alone cannot establish vendor absence.
                    let loggedOut = try run(codex, ["logout"] + policy, home: first)
                    let vendorAbsent = try run(codex, ["login", "status"] + policy, home: first) == 1
                    let deleted = try security("delete-generic-password", account)
                    let cliAbsent = try security("find-generic-password", account) == 44
                    absent = loggedOut == 0 && vendorAbsent && (deleted == 0 || deleted == 44)
                        && cliAbsent && nativeMetadataStatus(account) == errSecItemNotFound
                } catch { absent = false }
            }
            if absent { try? FileManager.default.removeItem(at: root) }
            else { XCTFail("The owned dummy Keychain scope could not be confirmed removed; its private fixture folder was retained.") }
        }
        let receipt = try JSONSerialization.data(withJSONObject: [
            "format": 1, "owner": "omnesis-desktop-keychain-fixture", "phase": "cleanup-pending",
            "home": firstCanonical, "account": account, "service": service,
        ], options: [.sortedKeys])
        let receiptURL = root.appendingPathComponent("cleanup-pending.json")
        guard FileManager.default.createFile(
            atPath: receiptURL.path,
            contents: receipt,
            attributes: [.posixPermissions: 0o600]
        ) else { throw Failure.fixtureInvalid }
        let receiptHandle = try FileHandle(forWritingTo: receiptURL)
        try receiptHandle.synchronize()
        try receiptHandle.close()
        let directory = open(root.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
        guard directory >= 0 else { throw Failure.fixtureInvalid }
        defer { close(directory) }
        guard fsync(directory) == 0 else { throw Failure.fixtureInvalid }
        let dummy = "omnesis-fixture-not-a-credential-" + UUID().uuidString
        mayHaveCreated = true
        // Upstream's pinned API-key path saves locally; authentication happens only on a later request.
        // This dummy value is never sent to an API, browser, model, or real account login.
        guard try run(codex, ["login", "--with-api-key"] + policy, home: first, input: dummy + "\n", classifyFailure: true) == 0 else {
            throw Failure.keychainRefused
        }
        XCTAssertEqual(
            nativeMetadataStatus(account),
            errSecSuccess,
            "The explicit User-domain metadata query must find the vendor-created account"
        )
        XCTAssertEqual(
            try security("find-generic-password", account, explicit: true),
            0,
            "The security tool must find the same account in the explicit vendor User-domain keychain"
        )
        XCTAssertEqual(
            try security("find-generic-password", account),
            0,
            "Default search must agree before it can authorize absence during removal"
        )
        XCTAssertEqual(try security("find-generic-password", other), 44)
        XCTAssertEqual(try run(codex, ["login", "status"] + policy, home: first), 0)
        XCTAssertEqual(try run(codex, ["login", "status"] + policy, home: second), 1)
        XCTAssertFalse(FileManager.default.fileExists(atPath: first.appendingPathComponent("auth.json").path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: second.appendingPathComponent("auth.json").path))
        if let entries = FileManager.default.enumerator(at: root, includingPropertiesForKeys: [.isRegularFileKey]) {
            for case let file as URL in entries where try file.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile == true {
                XCTAssertNil(try Data(contentsOf: file).range(of: Data(dummy.utf8)), "The dummy credential must stay in Keychain")
            }
        }
        XCTAssertEqual(try run(codex, ["logout"] + policy, home: first), 0)
        guard try security("find-generic-password", account) == 44 else { throw Failure.cleanupUncertain }
        // Removal uses the OS selector directly; prove this exact vendor-created account is deletable.
        XCTAssertEqual(try run(
            codex,
            ["login", "--with-api-key"] + policy,
            home: first,
            input: dummy + "\n",
            classifyFailure: true
        ), 0)
        XCTAssertEqual(try security("delete-generic-password", account), 0)
        guard try security("find-generic-password", account) == 44 else { throw Failure.cleanupUncertain }
        XCTAssertEqual(try security("find-generic-password", other), 44)
    }

    private func canonicalPath(_ home: URL) throws -> String {
        guard let canonical = realpath(home.path, nil) else { throw Failure.fixtureInvalid }
        defer { free(canonical) }
        return String(cString: canonical)
    }

    private func namespace(_ home: URL) throws -> String {
        // Foundation may shorten /private/var back to /var; Rust hashes POSIX realpath.
        try "cli|" + String(SHA256.hash(data: Data(canonicalPath(home).utf8))
            .map { String(format: "%02x", $0) }.joined().prefix(16))
    }

    private final class ErrorClassification: @unchecked Sendable {
        private let lock = NSLock()
        private var bounded = Data()
        func append(_ bytes: Data) {
            lock.lock()
            defer { lock.unlock() }
            if bounded.count < 16384 { bounded.append(bytes.prefix(16384 - bounded.count)) }
        }

        func result() -> String {
            lock.lock()
            defer { lock.unlock() }
            let text = String(decoding: bounded, as: UTF8.self).lowercased()
            if text.contains("unexpected argument") || text.contains("unrecognized") { return "arguments-refused" }
            if text.contains("interaction is not allowed") || text.contains("locked") { return "keychain-interaction-unavailable" }
            if text.contains("keyring") || text.contains("keychain") { return "keychain-operation-refused" }
            if text.contains("config") { return "configuration-refused" }
            return "unclassified-local-save-refusal"
        }
    }

    private func run(
        _ executable: URL,
        _ arguments: [String],
        home: URL,
        input: String? = nil,
        classifyFailure: Bool = false
    ) throws
        -> Int32 {
        let process = Process()
        process.executableURL = executable
        process.arguments = arguments
        process.currentDirectoryURL = home
        process.environment = [
            "PATH": "/usr/bin:/bin:/usr/sbin:/sbin",
            "HOME": FileManager.default.homeDirectoryForCurrentUser.path,
            "CODEX_HOME": home.path,
            "TMPDIR": home.path,
            "RUST_LOG": "off",
        ]
        let output = Pipe(), errors = Pipe(), stdin = Pipe()
        process.standardOutput = output
        process.standardError = errors
        if input == nil { process.standardInput = FileHandle.nullDevice } else { process.standardInput = stdin }
        // Preserve real OS HOME for Keychain, with vendor state and temporary files explicitly scoped.
        // Only a fixed classification escapes this bounded in-memory buffer; never print raw stderr.
        let classification = ErrorClassification()
        output.fileHandleForReading.readabilityHandler = { _ = $0.availableData }
        errors.fileHandleForReading.readabilityHandler = {
            let bytes = $0.availableData
            if classifyFailure { classification.append(bytes) }
        }
        defer {
            output.fileHandleForReading.readabilityHandler = nil
            errors.fileHandleForReading.readabilityHandler = nil
        }
        let closed = DispatchSemaphore(value: 0)
        process.terminationHandler = { _ in closed.signal() }
        try process.run()
        if let input {
            try stdin.fileHandleForWriting.write(contentsOf: Data(input.utf8))
            try stdin.fileHandleForWriting.close()
        }
        if closed.wait(timeout: .now() + 10) == .timedOut {
            process.terminate()
            if closed.wait(timeout: .now() + 2) == .timedOut {
                kill(process.processIdentifier, SIGKILL)
                _ = closed.wait(timeout: .now() + 2)
            }
            throw Failure.processTimedOut
        }
        if classifyFailure, process.terminationStatus != 0 {
            throw Failure.localSaveRefused(status: process.terminationStatus, classification: classification.result())
        }
        return process.terminationStatus
    }
}
