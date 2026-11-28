// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import CryptoKit
import Darwin
import DesktopCore
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
        case injectedInputWrite, injectedInputClose
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
            var absent = !mayHaveCreated && !cleanupBlocked
            if mayHaveCreated, !cleanupBlocked {
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

    private var cleanupBlocked = false
    private static let retained = RetainedInvocations()

    private func run(
        _ executable: URL,
        _ arguments: [String],
        home: URL,
        input: String? = nil,
        classifyFailure: Bool = false
    ) throws
        -> Int32 {
        guard !cleanupBlocked else { throw Failure.cleanupUncertain }
        let invocation = try makeInvocation(executable, arguments, home: home, input: input != nil, classifyFailure: classifyFailure)
        return try execute(invocation, input: input)
    }

    private func makeInvocation(
        _ executable: URL,
        _ arguments: [String],
        home: URL,
        input: Bool,
        classifyFailure: Bool = false
    ) throws
        -> OwnedInvocation {
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
        if input { process.standardInput = stdin }
        else { process.standardInput = FileHandle.nullDevice }
        if input {
            guard fcntl(stdin.fileHandleForWriting.fileDescriptor, F_SETNOSIGPIPE, 1) == 0 else { throw Failure.fixtureInvalid }
        }
        // Preserve real OS HOME for Keychain, with vendor state and temporary files explicitly scoped.
        // Only a fixed classification escapes this bounded in-memory buffer; never print raw stderr.
        let classification = ErrorClassification()
        return try OwnedInvocation(
            process: process, output: output, errors: errors, stdin: stdin, home: home,
            classification: classification, classifyFailure: classifyFailure
        )
    }

    private func execute(
        _ invocation: OwnedInvocation,
        input: String?,
        writeInput: (FileHandle, Data) throws -> Void = { handle, bytes in
            try handle.write(contentsOf: bytes)
            try handle.close()
        },
        wait: (DispatchSemaphore, DispatchTime) -> DispatchTimeoutResult = { $0.wait(timeout: $1) }
    ) throws
        -> Int32 {
        guard !cleanupBlocked else { throw Failure.cleanupUncertain }
        var originalError: Error?
        do {
            try invocation.launch()
            if let input { try writeInput(invocation.stdin.fileHandleForWriting, Data(input.utf8)) }
            guard invocation.observeExit(until: .now() + 10, wait: wait) else { throw Failure.processTimedOut }
        } catch { originalError = error }
        do {
            try invocation.stopAndJoin(wait: wait)
            try invocation.retireReaders()
        } catch {
            cleanupBlocked = true
            Self.retained.retain(invocation)
            if let originalError { throw originalError }
            throw error
        }
        if let originalError { throw originalError }
        if invocation.classifyFailure, invocation.process.terminationStatus != 0 {
            throw Failure.localSaveRefused(status: invocation.process.terminationStatus, classification: invocation.classification.result())
        }
        return invocation.process.terminationStatus
    }

    func testPostLaunchInputFailuresJoinTheirExactWriterBeforeRethrowing() throws {
        for failAfterClose in [false, true] {
            let root = try cleanupRegressionRoot()
            let invocation = try makeInvocation(URL(fileURLWithPath: "/bin/cat"), [], home: root, input: true)
            defer { cleanupRegression([invocation], root: root) }
            do {
                _ = try execute(invocation, input: "fictional fixture input\n", writeInput: { handle, bytes in
                    XCTAssertTrue(invocation.launched)
                    XCTAssertEqual(fcntl(handle.fileDescriptor, F_GETNOSIGPIPE), 1)
                    if failAfterClose {
                        try handle.write(contentsOf: bytes)
                        try handle.close()
                        throw Failure.injectedInputClose
                    }
                    throw Failure.injectedInputWrite
                })
                XCTFail("Post-launch input errors must not become successful commands")
            } catch Failure.injectedInputWrite { XCTAssertFalse(failAfterClose) }
            catch Failure.injectedInputClose { XCTAssertTrue(failAfterClose) }
            XCTAssertTrue(invocation.parentJoined)
            XCTAssertTrue(invocation.readersRetired)
            XCTAssertFalse(invocation.process.isRunning)
            XCTAssertFalse(cleanupBlocked, "A confirmed physical retirement must remain distinct from the input error")
        }
    }

    func testUnconfirmedFinalReceiptBlocksEveryLaterKeychainCleanupInvocation() throws {
        let root = try cleanupRegressionRoot()
        let invocation = try makeInvocation(URL(fileURLWithPath: "/usr/bin/true"), [], home: root, input: false)
        let later = try makeInvocation(URL(fileURLWithPath: "/usr/bin/true"), [], home: root, input: false)
        defer { cleanupRegression([invocation, later], root: root) }
        var waits = 0
        do {
            _ = try execute(invocation, input: nil, wait: { _, _ in
                waits += 1
                // Model missing receipts only; no successful join or liveness result is fabricated.
                return .timedOut
            })
            XCTFail("An unconfirmed final receipt must refuse completion")
        } catch Failure.processTimedOut {}
        XCTAssertEqual(waits, 3, "The original command, TERM and KILL receipt checks must all run")
        XCTAssertFalse(invocation.parentJoined)
        XCTAssertFalse(invocation.readersRetired)
        XCTAssertTrue(cleanupBlocked)
        XCTAssertThrowsError(try execute(later, input: nil))
        XCTAssertFalse(later.launched, "No logout, delete or absence subprocess may start after uncertain writer cleanup")
        // The regression itself must collect the real receipt before disposing its private home.
        try invocation.stopAndJoin()
        try invocation.retireReaders()
        XCTAssertTrue(invocation.parentJoined)
        XCTAssertTrue(invocation.readersRetired)
        XCTAssertTrue(cleanupBlocked, "Physical test teardown must not reset the invocation admission fence")
    }

    private func cleanupRegressionRoot() throws -> URL {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("omnesis-codex-cleanup-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        return root
    }

    private func cleanupRegression(_ invocations: [OwnedInvocation], root: URL) {
        var confirmed = true
        for invocation in invocations {
            do {
                try invocation.stopAndJoin()
                try invocation.retireReaders()
                Self.retained.releaseJoined(invocation)
            } catch {
                confirmed = false
                Self.retained.retain(invocation)
            }
        }
        if confirmed { try? FileManager.default.removeItem(at: root) }
        else { XCTFail("Owned process regression cleanup is unconfirmed; its private fixture was retained") }
    }

    private final class RetainedInvocations: @unchecked Sendable {
        private let lock = NSLock()
        private var owned: [OwnedInvocation] = []
        func retain(_ invocation: OwnedInvocation) {
            lock.lock()
            owned.append(invocation)
            lock.unlock()
        }

        func releaseJoined(_ invocation: OwnedInvocation) {
            guard invocation.parentJoined, invocation.readersRetired else { return }
            lock.lock()
            owned.removeAll { $0 === invocation }
            lock.unlock()
        }
    }

    private final class OwnedInvocation {
        let process: Process
        let output: Pipe
        let errors: Pipe
        let stdin: Pipe
        let home: URL
        let classification: ErrorClassification
        let classifyFailure: Bool
        private let closed = DispatchSemaphore(value: 0)
        private let readers: DesktopOwnedFixturePipeReaders
        private var retirementDeadline: DispatchTime?
        private var identity: DesktopBackgroundProcessIdentity?
        private var exitObserved = false
        private var readerRetirementAttempted = false
        private(set) var launched = false
        private(set) var parentJoined = false
        private(set) var readersRetired = false

        init(
            process: Process, output: Pipe, errors: Pipe, stdin: Pipe, home: URL,
            classification: ErrorClassification, classifyFailure: Bool
        ) throws {
            self.process = process
            self.output = output
            self.errors = errors
            self.stdin = stdin
            self.home = home
            self.classification = classification
            self.classifyFailure = classifyFailure
            readers = try DesktopOwnedFixturePipeReaders(
                output: output, errors: errors, consumeOutput: { _ in },
                consumeErrors: { if classifyFailure { classification.append($0) } }
            )
            let receipt = closed
            process.terminationHandler = { _ in receipt.signal() }
        }

        func launch() throws {
            defer {
                // A failed run that nevertheless reports a live child still owns its physical cleanup.
                if process.isRunning { launched = true }
                if launched, let observed = try? DesktopBackgroundProcessIdentity.read(process.processIdentifier),
                   observed.parent == getpid() { identity = observed }
            }
            // Failed launch still uses this command budget, never a fresh reader-retirement budget.
            retirementDeadline = .now() + 10
            try readers.start()
            try process.run()
            launched = true
        }

        func observeExit(
            until deadline: DispatchTime,
            wait: (DispatchSemaphore, DispatchTime) -> DispatchTimeoutResult
        )
            -> Bool {
            retirementDeadline = deadline
            if exitObserved { return true }
            exitObserved = wait(closed, deadline) == .success
            return exitObserved
        }

        private func signal(_ value: Int32) {
            guard process.isRunning, let identity,
                  (try? DesktopBackgroundProcessIdentity.read(identity.pid)) == identity else { return }
            _ = Darwin.kill(identity.pid, value)
        }

        func stopAndJoin(
            wait: (DispatchSemaphore, DispatchTime) -> DispatchTimeoutResult = { $0.wait(timeout: $1) }
        ) throws {
            guard launched, !parentJoined else { return }
            // Closing only the owned input may let a failed writer observe EOF before a signal is needed.
            try? stdin.fileHandleForWriting.close()
            if !exitObserved {
                signal(SIGTERM)
                if !observeExit(until: .now() + 2, wait: wait) {
                    signal(SIGKILL)
                    guard observeExit(until: .now() + 2, wait: wait) else { throw Failure.cleanupUncertain }
                }
            }
            process.waitUntilExit()
            parentJoined = true
        }

        func retireReaders() throws {
            guard !readersRetired else { return }
            guard parentJoined || !launched, !readerRetirementAttempted else { throw Failure.cleanupUncertain }
            readerRetirementAttempted = true
            if !launched {
                try output.fileHandleForWriting.close()
                try errors.fileHandleForWriting.close()
            }
            readers.requestCancellation()
            // A never-started invocation has no asynchronous callback; join closes its owned ends directly.
            try readers.join(until: retirementDeadline ?? .now())
            readersRetired = true
        }
    }
}
