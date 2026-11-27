// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import CryptoKit
import Darwin
@testable import DesktopCore
import Foundation
import XCTest

final class CodexBackendRuntimeTests: XCTestCase {
    private struct BackendFixture: Decodable {
        let format: Int
        let owner: String
        let hashes: [String: String]
        let qualifiedRuntimeVersion: String
    }

    private struct SDKFixture: Decodable {
        let owner: String
        let version: String
        let architecture: String
        let executableSha256: String
        let packageBinary: String
        let packageManifestSha256: String
    }

    private struct NodeFixture: Decodable {
        let owner: String
        let architecture: String
        let nodeVersion: String
        let executableSha256: String
    }

    func testCompiledProductionBackendUsesNativeAuthorityAndOnlyDynamicToolsForBothModelModes() async throws {
        let files = FileManager.default
        let inputs = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let backend = inputs.appendingPathComponent(".codex-backend-fixture")
        let sdk = inputs.appendingPathComponent(".codex-keychain-fixture")
        let node = inputs.appendingPathComponent(".node-fixture")
        let backendMeta = try JSONDecoder().decode(
            BackendFixture.self,
            from: Data(contentsOf: backend.appendingPathComponent("backend-fixture.json"))
        )
        let sdkMeta = try JSONDecoder().decode(SDKFixture.self, from: Data(contentsOf: sdk.appendingPathComponent("codex-fixture.json")))
        let nodeMeta = try JSONDecoder().decode(NodeFixture.self, from: Data(contentsOf: node.appendingPathComponent("node-fixture.json")))
        guard backendMeta.format == 1, backendMeta.owner == "omnesis-desktop-codex-backend-test-fixture",
              sdkMeta.owner == "omnesis-desktop-codex-keychain-test-fixture", sdkMeta.version == backendMeta.qualifiedRuntimeVersion,
              nodeMeta.owner == "omnesis-desktop-node-test-fixture", nodeMeta.nodeVersion.hasPrefix("24.") else { throw Failure.input }
        #if arch(arm64)
        let architecture = "arm64", triple = "aarch64-apple-darwin"
        #else
        let architecture = "x64", triple = "x86_64-apple-darwin"
        #endif
        guard sdkMeta.architecture == architecture, nodeMeta.architecture == architecture,
              sdkMeta.packageBinary == "vendor/" + triple + "/bin/codex",
              Set(backendMeta.hashes.keys) == Set([
                  "program.mjs",
                  "package.json",
                  "packages/core/dist/node-command.js",
                  "packages/core/dist/managed-runtime-bootstrap.js",
              ])
        else { throw Failure.input }
        let temporary = URL(fileURLWithPath: "/tmp").appendingPathComponent("omnesis-backend-" + UUID().uuidString)
        try files.createDirectory(at: temporary, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        let home = try URL(fileURLWithPath: DesktopCanonicalPath.resolve(temporary.path), isDirectory: true)
        let config = home.appendingPathComponent("library", isDirectory: true)
        let cache = home.appendingPathComponent("runtime", isDirectory: true)
        let stage = home.appendingPathComponent("stage", isDirectory: true)
        for path in [config, cache, stage, URL(fileURLWithPath: config.path + ".bootstrap", isDirectory: true)] {
            try files.createDirectory(at: path, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        }
        let identity = digest(Data(config.path.utf8))
        let scope = DesktopDataUsageLease.Scope(
            configDir: config.path,
            instance: "desktop-" + String(identity.prefix(16)),
            secretService: "dev.omnesis.desktop." + identity
        )
        var inventory: [[String: Any]] = []
        func copy(_ source: URL, path: String, expected: String?, executable: Bool = false) throws {
            let hash = try hashFile(source)
            if let expected { guard expected == hash else { throw Failure.input } }
            let target = stage.appendingPathComponent(path)
            try files.createDirectory(
                at: target.deletingLastPathComponent(),
                withIntermediateDirectories: true,
                attributes: [.posixPermissions: 0o700]
            )
            try files.copyItem(at: source, to: target)
            guard try hashFile(target) == hash else { throw Failure.input }
            try files.setAttributes([.posixPermissions: executable ? 0o755 : 0o600], ofItemAtPath: target.path)
            try inventory.append([
                "path": path,
                "sha256": hash,
                "bytes": XCTUnwrap((files.attributesOfItem(atPath: target.path)[.size] as? NSNumber)?.uint64Value),
                "executable": executable,
            ])
        }
        for (path, hash) in backendMeta.hashes {
            try copy(backend.appendingPathComponent(path), path: path, expected: hash)
        }
        try copy(node.appendingPathComponent("node"), path: "node", expected: nodeMeta.executableSha256, executable: true)
        try copy(builtTool(), path: "runtime-exec", expected: nil, executable: true)
        try copy(
            sdk.appendingPathComponent("sdk-package/package.json"),
            path: "sdk-package/package.json",
            expected: sdkMeta.packageManifestSha256
        )
        try copy(
            sdk.appendingPathComponent("sdk-package/" + sdkMeta.packageBinary),
            path: "sdk-package/" + sdkMeta.packageBinary,
            expected: sdkMeta.executableSha256,
            executable: true
        )
        let manifest = try JSONSerialization.data(withJSONObject: [
            "format": 1,
            "codeUsageProtocol": 1,
            "dataUsageProtocol": 1,
            "processAuthorityProtocol": 3,
            "runtimeLauncher": "runtime-exec",
            "inventory": inventory.sorted { ($0["path"] as! String) < ($1["path"] as! String) },
        ], options: [.sortedKeys])
        let epoch = digest(manifest), runtime = cache.appendingPathComponent(digest(manifest), isDirectory: true)
        try manifest.write(to: stage.appendingPathComponent("desktop-runtime.json"))
        try files.moveItem(at: stage, to: runtime)
        let tuple: [String: Any] = [
            "version": 3,
            "owner": "omnesis-desktop",
            "instance": scope.instance,
            "secretService": scope.secretService,
        ]
        try record(tuple, URL(fileURLWithPath: config.path + ".bootstrap/process-authority.json"))
        try record([
            "version": 1,
            "owner": "omnesis-desktop",
            "instance": scope.instance,
            "secretService": scope.secretService,
            "phase": "configured",
            "processAuthorityVersion": 3,
        ], config.appendingPathComponent("desktop-install.json"))
        let process = Process(), output = Pipe(), errors = Pipe()
        let stdout = Capture(), stderr = Capture()
        process.executableURL = runtime.appendingPathComponent("runtime-exec")
        let encoded = try JSONEncoder().encode(scope).base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(
            of: "/",
            with: "_"
        ).replacingOccurrences(of: "=", with: "")
        process.arguments = ["--data-use", encoded, "--node", runtime.appendingPathComponent("program.mjs").path]
        process.environment = [
            "PATH": "/usr/bin:/bin",
            "HOME": home.path,
            "TMPDIR": home.path,
            "OMNESIS_CONFIG_DIR": scope.configDir,
            "OMNESIS_SERVICE_INSTANCE": scope.instance,
            "OMNESIS_SECRET_SERVICE": scope.secretService,
            "OMNESIS_DESKTOP_MANAGED": "1",
            "OMNESIS_SECRET_STORE": "macos-keychain",
        ]
        process.standardInput = FileHandle.nullDevice
        process.standardOutput = output
        process.standardError = errors
        let owned = try OwnedBackendProcess(process: process, output: output, errors: errors, stdout: stdout, stderr: stderr, home: home)
        var originalError: Error?
        do { try await owned.runAndJoin() }
        catch { originalError = error }
        do {
            guard owned.parentJoined || !owned.launched else { throw Failure.cleanupUncertain }
            // Native EX, not parent exit, proves that all real data consumers have drained.
            var root = stat()
            guard lstat(config.path, &root) == 0 else { throw Failure.input }
            let operation = UUID().uuidString.lowercased()
            try record([
                "version": 1,
                "owner": "omnesis-desktop",
                "instance": scope.instance,
                "secretService": scope.secretService,
                "operationId": operation,
                "mode": "erase-data",
                "phase": "requested",
                "root": ["device": String(root.st_dev), "inode": String(root.st_ino)],
            ], URL(fileURLWithPath: config.path + ".bootstrap/retirement.json"))
            let drained = try DesktopDataUsageLease.acquire(scope: scope, epoch: epoch, purpose: .erase, operationId: operation)
            try owned.retireReaders()
            try withExtendedLifetime(drained) { try files.removeItem(at: home) }
        } catch {
            Self.retained.retain(owned)
            if let originalError {
                XCTFail("Owned backend cleanup is unconfirmed; its exact process, readers and private fixture were retained")
                throw originalError
            }
            throw error
        }
        if let originalError { throw originalError }
        XCTAssertEqual(process.terminationStatus, 0, stderr.text)
        XCTAssertEqual(stdout.text, "codex-production-backend:passed\n", stderr.text)
    }

    func testCancelledBackendWaitPhysicallyJoinsItsExactParentBeforeReaderRetirement() async throws {
        let owned = try sleepingBackend()
        defer { retainOrRemove(owned) }
        let work = Task {
            try await owned.runAndJoin(pause: {
                withUnsafeCurrentTask { $0?.cancel() }
                try Task.checkCancellation()
            })
        }
        do {
            try await work.value
            XCTFail("The original wait cancellation must survive physical cleanup")
        } catch is CancellationError {}
        XCTAssertTrue(owned.parentJoined)
        XCTAssertFalse(owned.process.isRunning)
        // This fixed sleep fixture has no descendants or managed DATA scope.
        try owned.retireReaders()
        XCTAssertTrue(owned.readersRetired)
    }

    func testBackendReadersCannotRetireWhileTheirExactParentIsLive() throws {
        let owned = try sleepingBackend()
        defer { retainOrRemove(owned) }
        try owned.launch()
        XCTAssertTrue(owned.process.isRunning)
        XCTAssertThrowsError(try owned.retireReaders())
        XCTAssertFalse(owned.readersRetired)
        XCTAssertGreaterThanOrEqual(fcntl(owned.output.fileHandleForReading.fileDescriptor, F_GETFL), 0)
        XCTAssertGreaterThanOrEqual(fcntl(owned.errors.fileHandleForReading.fileDescriptor, F_GETFL), 0)
        try owned.stopAndJoin()
        try owned.retireReaders()
        XCTAssertTrue(owned.parentJoined)
        XCTAssertTrue(owned.readersRetired)
    }

    private func sleepingBackend() throws -> OwnedBackendProcess {
        let home = FileManager.default.temporaryDirectory.appendingPathComponent("omnesis-backend-cleanup-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: home, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        let process = Process(), output = Pipe(), errors = Pipe(), stdout = Capture(), stderr = Capture()
        process.executableURL = URL(fileURLWithPath: "/bin/sleep")
        process.arguments = ["30"]
        process.currentDirectoryURL = home
        process.environment = ["PATH": "/usr/bin:/bin", "HOME": home.path, "TMPDIR": home.path]
        process.standardInput = FileHandle.nullDevice
        process.standardOutput = output
        process.standardError = errors
        return try OwnedBackendProcess(process: process, output: output, errors: errors, stdout: stdout, stderr: stderr, home: home)
    }

    private func retainOrRemove(_ owned: OwnedBackendProcess) {
        do {
            try owned.stopAndJoin()
            try owned.retireReaders()
            try FileManager.default.removeItem(at: owned.home)
        } catch {
            Self.retained.retain(owned)
            XCTFail("Owned backend regression cleanup is unconfirmed; its private fixture was retained")
        }
    }

    private static let retained = RetainedBackends()
    private final class RetainedBackends: @unchecked Sendable {
        private let lock = NSLock()
        private var owned: [OwnedBackendProcess] = []
        func retain(_ process: OwnedBackendProcess) {
            lock.lock()
            owned.append(process)
            lock.unlock()
        }
    }

    private final class OwnedBackendProcess: @unchecked Sendable {
        let process: Process
        let output: Pipe
        let errors: Pipe
        let home: URL
        private let readers: DesktopOwnedFixturePipeReaders
        private var identity: DesktopBackgroundProcessIdentity?
        private(set) var launched = false
        private(set) var parentJoined = false
        private(set) var readersRetired = false
        private var readerRetirementAttempted = false

        init(process: Process, output: Pipe, errors: Pipe, stdout: Capture, stderr: Capture, home: URL) throws {
            self.process = process
            self.output = output
            self.errors = errors
            readers = try DesktopOwnedFixturePipeReaders(
                output: output, errors: errors, consumeOutput: { stdout.append($0) }, consumeErrors: { stderr.append($0) }
            )
            self.home = home
        }

        func launch() throws {
            defer {
                // A failed run that nevertheless reports a live child still owns its physical cleanup.
                if process.isRunning { launched = true }
                if launched, let observed = try? DesktopBackgroundProcessIdentity.read(process.processIdentifier),
                   observed.parent == getpid() { identity = observed }
            }
            try readers.start()
            try process.run()
            launched = true
        }

        func runAndJoin(pause: () async throws -> Void = { try await Task.sleep(for: .milliseconds(25)) }) async throws {
            var originalError: Error?
            do {
                try Task.checkCancellation()
                try launch()
                let deadline = Date().addingTimeInterval(60)
                while process.isRunning, Date() < deadline {
                    try await pause()
                }
                if process.isRunning { throw Failure.processTimedOut }
            } catch { originalError = error }
            do { try stopAndJoin() }
            catch {
                if let originalError { throw originalError }
                throw error
            }
            if let originalError { throw originalError }
        }

        private func signal(_ value: Int32) -> Bool {
            guard process.isRunning else { return true }
            guard let identity, (try? DesktopBackgroundProcessIdentity.read(identity.pid)) == identity else { return false }
            return Darwin.kill(identity.pid, value) == 0 || errno == ESRCH
        }

        func stopAndJoin() throws {
            guard launched, !parentJoined else { return }
            if process.isRunning { _ = signal(SIGTERM) }
            let stopDeadline = Date().addingTimeInterval(5)
            // Cleanup must not inherit the cancellation that interrupted the test body.
            while process.isRunning, Date() < stopDeadline {
                usleep(25000)
            }
            if process.isRunning, !signal(SIGKILL) { throw Failure.cleanupUncertain }
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
            try readers.retireAfterEOF()
            readersRetired = true
        }
    }

    private func builtTool() throws -> URL {
        var directory = Bundle(for: Self.self).bundleURL.deletingLastPathComponent()
        for _ in 0 ..< 5 {
            let path = directory.appendingPathComponent("OmnesisRuntimeExec")
            if FileManager.default.isExecutableFile(atPath: path.path) { return path }
            directory.deleteLastPathComponent()
        }
        throw Failure.input
    }

    private func digest(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    private func hashFile(_ path: URL) throws -> String {
        let handle = try FileHandle(forReadingFrom: path)
        defer { try? handle.close() }
        var digest = SHA256()
        while let data = try handle.read(upToCount: 1024 * 1024), !data.isEmpty {
            digest.update(data: data)
        }
        return digest.finalize().map { String(format: "%02x", $0) }.joined()
    }

    private func record(_ value: [String: Any], _ path: URL) throws {
        try JSONSerialization.data(withJSONObject: value).write(to: path)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: path.path)
    }

    private enum Failure: Error { case input, processTimedOut, cleanupUncertain }
    private final class Capture: @unchecked Sendable {
        private let lock = NSLock()
        private var value = ""
        func append(_ bytes: Data) {
            lock.lock()
            defer { lock.unlock() }
            value = String((value + String(decoding: bytes, as: UTF8.self)).suffix(32768))
        }

        var text: String {
            lock.lock()
            defer { lock.unlock() }
            return value
        }
    }
}
