// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import CryptoKit
import Darwin
@testable import DesktopCore
import Foundation
import XCTest

final class DataUsageLeaseTests: XCTestCase {
    private var home: URL!
    private var processes: [Process] = []
    private var sockets: [String] = []
    private var scope: DesktopDataUsageLease.Scope!
    private var operationId: String!
    private var runtime: URL!

    override func setUpWithError() throws {
        // macOS per-user temporary paths can exceed sockaddr_un.sun_path with a fixture suffix.
        home = URL(fileURLWithPath: "/tmp", isDirectory: true).appendingPathComponent("omnesis-data-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        home = home.resolvingSymlinksInPath()
        let config = home.appendingPathComponent("library", isDirectory: true)
        for path in [config, URL(fileURLWithPath: config.path + ".bootstrap", isDirectory: true)] {
            try FileManager.default.createDirectory(at: path, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        }
        let identity = hash(Data(config.path.utf8))
        scope = DesktopDataUsageLease.Scope(
            configDir: config.path,
            instance: "desktop-" + String(identity.prefix(16)),
            secretService: "dev.omnesis.desktop." + identity
        )
        operationId = UUID().uuidString.lowercased()
        try write([
            "version": 1,
            "owner": "omnesis-desktop",
            "instance": scope.instance,
            "secretService": scope.secretService,
            "phase": "configured",
        ], to: config.appendingPathComponent("desktop-install.json"))
    }

    override func tearDownWithError() throws {
        for path in sockets {
            try? sendExit(path)
        }
        for process in processes where process.isRunning {
            kill(process.processIdentifier, SIGKILL)
            process.waitUntilExit()
        }
        // Owned orphan commands acknowledge exit by removing their own socket.
        let deadline = Date().addingTimeInterval(5)
        while sockets.contains(where: { FileManager.default.fileExists(atPath: $0) }), Date() < deadline {
            usleep(10000)
        }
        for path in sockets {
            XCTAssertFalse(FileManager.default.fileExists(atPath: path), "Owned data-use child did not drain")
        }
        try FileManager.default.removeItem(at: home)
    }

    func testKilledGatewayDoesNotReleaseItsRawSdkDescendantsDataLease() async throws {
        try makeRuntime(host: "process.stdout.write('ready');process.stdin.resume();")
        let socket = home.appendingPathComponent("consumer.sock").path
        sockets.append(socket)
        let child = socketCommand(socket)
        let script = "import{spawn}from'node:child_process';import{existsSync}from'node:fs';let c=spawn(process.execPath,['--node','-e',\(literal(child))],{stdio:'ignore'});c.unref();let t=setInterval(()=>{if(existsSync(\(literal(socket)))){clearInterval(t);process.stdout.write('ready')}},5);process.stdin.resume();"
        let gateway = try start(["--data-use", encodedScope(), "--node", "-e", script])
        try await waitReady(gateway)
        try retire()
        kill(gateway.process.processIdentifier, SIGKILL)
        try await waitExited(gateway)
        let denied = try start(exclusiveArguments())
        try await waitExited(denied)
        XCTAssertEqual(denied.process.terminationStatus, 78)
        XCTAssertTrue(denied.diagnostics.text.contains("inUse"), denied.diagnostics.text)
        try sendExit(socket)
        try await waitAbsent(socket)
        let available = try start(exclusiveArguments())
        try await waitReady(available)
    }

    func testExclusiveDescriptorSurvivesOperationParentKillThroughWorkerMapping() async throws {
        let socket = home.appendingPathComponent("operation.sock").path
        sockets.append(socket)
        let child = socketCommand(socket)
        let args = try ["--data-inherit", "erase", XCTUnwrap(operationId), encodedScope(), "--node", "-e", child]
        let script = "import{spawn}from'node:child_process';import{existsSync}from'node:fs';let c=spawn(process.execPath,\(literal(args)),{stdio:['ignore','ignore','ignore','ignore','ignore','ignore','ignore',7]});c.unref();let t=setInterval(()=>{if(existsSync(\(literal(socket)))){clearInterval(t);process.stdout.write('ready')}},5);process.stdin.resume();"
        try makeRuntime(host: script)
        try retire()
        let operation = try start(exclusiveArguments())
        try await waitReady(operation)
        kill(operation.process.processIdentifier, SIGKILL)
        try await waitExited(operation)
        let denied = try start(exclusiveArguments())
        try await waitExited(denied)
        XCTAssertEqual(denied.process.terminationStatus, 78)
        XCTAssertTrue(denied.diagnostics.text.contains("inUse"), denied.diagnostics.text)
        try sendExit(socket)
        try await waitAbsent(socket)
        let available = try start(exclusiveArguments())
        try await waitReady(available)
    }

    func testMissingScopeAndLostExclusiveDescriptorRefuseBeforeExecutingNode() async throws {
        try makeRuntime(host: "process.stdout.write('ready');process.stdin.resume();")
        let missing = try start(["--node", "-e", "process.stdout.write('must-not-execute')"])
        try await waitExited(missing)
        XCTAssertEqual(missing.process.terminationStatus, 78)
        XCTAssertFalse(missing.capture.text.contains("must-not-execute"))
        try retire()
        let forged = try start([
            "--data-inherit",
            "erase",
            XCTUnwrap(operationId),
            encodedScope(),
            "--node",
            "-e",
            "process.stdout.write('must-not-execute')",
        ])
        try await waitExited(forged)
        XCTAssertEqual(forged.process.terminationStatus, 78)
        XCTAssertFalse(forged.capture.text.contains("must-not-execute"))
    }

    func testWrongRootAndStaleGenerationNeverGainExclusiveAuthority() throws {
        try retire()
        let path = URL(fileURLWithPath: scope.configDir + ".bootstrap").appendingPathComponent("retirement.json")
        var intent = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(contentsOf: path)) as? [String: Any])
        intent["root"] = ["device": "0", "inode": "0"]
        try write(intent, to: path)
        XCTAssertThrowsError(try DesktopDataUsageLease.acquire(
            scope: scope,
            epoch: String(repeating: "a", count: 64),
            purpose: .erase,
            operationId: operationId
        ))
        let stale = DesktopDataUsageLease.Scope(
            configDir: scope.configDir,
            instance: scope.instance,
            secretService: "dev.omnesis.desktop." + String(repeating: "b", count: 64)
        )
        XCTAssertThrowsError(try DesktopDataUsageLease.acquire(scope: stale, epoch: String(repeating: "a", count: 64)))
    }

    func testControllerDoesNotDeadlockItsOwnExclusiveErase() async throws {
        try makeRuntime(host: "process.stdout.write('ready');process.stdin.resume();")
        let controller = try start(["--node", runtime.appendingPathComponent("packages/cli/dist/index.js").path, "desktop", "bridge"])
        try await waitReady(controller)
        try retire()
        let operation = try start(exclusiveArguments())
        try await waitReady(operation)
        XCTAssertTrue(controller.process.isRunning)
    }

    func testRetiredMetadataChecksBindOnlyOwnedAccountsWithoutOpeningCorpus() throws {
        try retire()
        try FileManager.default.removeItem(atPath: scope.configDir)
        try DesktopDataUsageLease.validateKeychainMetadata(scope, account: "install-root-key-v1", service: scope.secretService)
        let legacy = scope.configDir + "/codex-home"
        try DesktopDataUsageLease.validateKeychainMetadata(
            scope,
            account: "cli|" + String(hash(Data(legacy.utf8)).prefix(16)),
            service: "Codex Auth"
        )
        XCTAssertThrowsError(try DesktopDataUsageLease.validateKeychainMetadata(
            scope,
            account: "cli|" + String(repeating: "0", count: 16),
            service: "Codex Auth"
        ))
        XCTAssertThrowsError(try DesktopDataUsageLease.acquire(scope: scope, epoch: String(repeating: "a", count: 64)))
    }

    func testRecoveryRootReadsUseExactScopedMarkerAccounts() throws {
        let suffix = Data(SHA256.hash(data: Data(scope.configDir.utf8))).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
        for prefix in ["storage-encryption-state-v1:", "secret-files-state-v1:"] {
            XCTAssertTrue(DesktopDataUsageLease.isKeychainRead(scope, account: prefix + String(suffix.prefix(12))))
            XCTAssertFalse(DesktopDataUsageLease.isKeychainRead(scope, account: prefix + "wrong-scope"))
        }
        XCTAssertFalse(DesktopDataUsageLease.isKeychainRead(scope, account: "storage-encryption-state-v1"))
        try retire()
        let lease = try DesktopDataUsageLease.acquire(scope: scope, epoch: String(repeating: "a", count: 64), keychainRead: true)
        withExtendedLifetime(lease) {
            XCTAssertThrowsError(try DesktopDataUsageLease.acquire(
                scope: scope,
                epoch: String(repeating: "a", count: 64),
                purpose: .erase,
                operationId: operationId
            ))
        }
    }

    func testFutureGenerationMetadataRequiresCompletedEraseAndAbsentRoot() throws {
        try retire()
        let path = URL(fileURLWithPath: scope.configDir + ".bootstrap/retirement.json")
        let seed = UUID().uuidString.lowercased()
        var material = Data(scope.configDir.utf8)
        material.append(0)
        material.append(contentsOf: seed.utf8)
        let identity = hash(material), nextService = "dev.omnesis.desktop." + identity
        XCTAssertThrowsError(try DesktopDataUsageLease.validateKeychainMetadata(
            scope,
            account: "install-root-key-v1",
            service: nextService,
            proposedGeneration: seed
        ))
        var intent = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(contentsOf: path)) as? [String: Any])
        intent["phase"] = "complete"
        try write(intent, to: path)
        XCTAssertThrowsError(try DesktopDataUsageLease.validateKeychainMetadata(
            scope,
            account: "install-root-key-v1",
            service: nextService,
            proposedGeneration: seed
        ))
        try FileManager.default.removeItem(atPath: scope.configDir)
        try DesktopDataUsageLease.validateKeychainMetadata(
            scope,
            account: "install-root-key-v1",
            service: nextService,
            proposedGeneration: seed
        )
        let home = scope.configDir + "/codex-home/desktop-" + String(identity.prefix(16))
        try DesktopDataUsageLease.validateKeychainMetadata(
            scope,
            account: "cli|" + String(hash(Data(home.utf8)).prefix(16)),
            service: "Codex Auth",
            proposedGeneration: seed
        )
        XCTAssertThrowsError(try DesktopDataUsageLease.validateKeychainMetadata(
            scope,
            account: "install-root-key-v1",
            service: scope.secretService,
            proposedGeneration: seed
        ))
    }

    func testFailedRestoreStartCanRollBackButCannotRepublishAsNewRestore() throws {
        try retire()
        let parent = URL(fileURLWithPath: scope.configDir + ".bootstrap")
        let retirement = parent.appendingPathComponent("retirement.json")
        var intent = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(contentsOf: retirement)) as? [String: Any])
        intent["phase"] = "starting"
        try FileManager.default.removeItem(at: retirement)
        try write(intent, to: parent.appendingPathComponent("restore.json"))
        XCTAssertThrowsError(try DesktopDataUsageLease.acquire(
            scope: scope,
            epoch: String(repeating: "a", count: 64),
            purpose: .restore,
            operationId: operationId
        ))
        let lease = try DesktopDataUsageLease.acquire(
            scope: scope,
            epoch: String(repeating: "a", count: 64),
            purpose: .rollback,
            operationId: operationId
        )
        withExtendedLifetime(lease) {}
    }

    private func makeRuntime(host: String) throws {
        var build = Bundle(for: DataUsageLeaseTests.self).bundleURL.deletingLastPathComponent()
        var tool: URL?
        for _ in 0 ..< 5 {
            let candidate = build.appendingPathComponent("OmnesisRuntimeExec")
            if FileManager.default.isExecutableFile(atPath: candidate.path) { tool = candidate
                break
            }
            build.deleteLastPathComponent()
        }
        let input = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().appendingPathComponent(".node-fixture", isDirectory: true)
        let metadata = try JSONSerialization
            .jsonObject(with: Data(contentsOf: input.appendingPathComponent("node-fixture.json"))) as! [String: Any]
        let node = input.appendingPathComponent("node")
        XCTAssertEqual(try hash(Data(contentsOf: node)), metadata["executableSha256"] as? String)
        let cache = home.appendingPathComponent("runtime", isDirectory: true)
        let stage = home.appendingPathComponent("stage", isDirectory: true)
        try FileManager.default.createDirectory(at: cache, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        for directory in ["packages/core/dist", "packages/cli/dist/desktop"] {
            try FileManager.default.createDirectory(at: stage.appendingPathComponent(directory), withIntermediateDirectories: true)
        }
        try FileManager.default.copyItem(at: XCTUnwrap(tool), to: stage.appendingPathComponent("runtime-exec"))
        try FileManager.default.copyItem(at: node, to: stage.appendingPathComponent("node"))
        let preload = "import{fileURLToPath}from'node:url';Object.defineProperty(process,'execPath',{value:fileURLToPath(new URL('../../../runtime-exec',import.meta.url)),writable:false,configurable:false});"
        try Data(preload.utf8).write(to: stage.appendingPathComponent("packages/core/dist/managed-runtime-bootstrap.js"))
        try Data(host.utf8).write(to: stage.appendingPathComponent("packages/cli/dist/desktop/data-operation.js"))
        try Data("process.stdout.write('ready');process.stdin.resume();".utf8)
            .write(to: stage.appendingPathComponent("packages/cli/dist/index.js"))
        let manifest: [String: Any] = [
            "format": 1,
            "codeUsageProtocol": 1,
            "dataUsageProtocol": 1,
            "runtimeLauncher": "runtime-exec",
            "fixture": host,
            "inventory": [["path": "node", "executable": true], ["path": "runtime-exec", "executable": true]],
        ]
        let bytes = try JSONSerialization.data(withJSONObject: manifest, options: [.sortedKeys])
        try bytes.write(to: stage.appendingPathComponent("desktop-runtime.json"))
        runtime = cache.appendingPathComponent(hash(bytes), isDirectory: true)
        try FileManager.default.moveItem(at: stage, to: runtime)
    }

    private func retire() throws {
        var info = stat()
        guard lstat(scope.configDir, &info) == 0 else { throw TestFailure.fixture }
        try write(
            [
                "version": 1,
                "owner": "omnesis-desktop",
                "instance": scope.instance,
                "secretService": scope.secretService,
                "operationId": operationId!,
                "phase": "requested",
                "mode": "erase-data",
                "root": ["device": String(info.st_dev), "inode": String(info.st_ino)],
            ],
            to: URL(fileURLWithPath: scope.configDir + ".bootstrap").appendingPathComponent("retirement.json")
        )
    }

    private func encodedScope() throws -> String {
        try JSONEncoder().encode(scope!).base64EncodedString().replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }

    private func exclusiveArguments() throws -> [String] {
        try ["--data-exclusive", "erase", operationId!, encodedScope()]
    }

    private func write(_ value: [String: Any], to path: URL) throws {
        try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]).write(to: path)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: path.path)
    }

    private func hash(_ value: Data) -> String {
        SHA256.hash(data: value).map { String(format: "%02x", $0) }.joined()
    }

    private func literal(_ value: some Encodable) -> String {
        String(data: try! JSONEncoder().encode(value), encoding: .utf8)!
    }

    private enum TestFailure: Error { case fixture
        case diagnostics(String)
    }

    private final class Capture: @unchecked Sendable {
        private let lock = NSLock()
        private var value = ""
        func append(_ data: Data) {
            lock.lock()
            defer { lock.unlock() }
            value = String((value + String(decoding: data, as: UTF8.self)).suffix(8192))
        }

        var text: String {
            lock.lock()
            defer { lock.unlock() }
            return value
        }
    }

    private struct Running { let process: Process
        let capture: Capture
        let diagnostics: Capture
        let input: Pipe
        let output: Pipe
        let errors: Pipe
    }

    private func start(_ arguments: [String]) throws -> Running {
        let process = Process(), output = Pipe(), errors = Pipe(), input = Pipe()
        let capture = Capture(), diagnostics = Capture()
        process.executableURL = runtime.appendingPathComponent("runtime-exec")
        process.arguments = arguments
        process.environment = ["PATH": "/usr/bin:/bin"]
        process.standardInput = input
        process.standardOutput = output
        process.standardError = errors
        output.fileHandleForReading.readabilityHandler = { capture.append($0.availableData) }
        errors.fileHandleForReading.readabilityHandler = { diagnostics.append($0.availableData) }
        try process.run()
        processes.append(process)
        return Running(process: process, capture: capture, diagnostics: diagnostics, input: input, output: output, errors: errors)
    }

    private func waitReady(_ running: Running) async throws {
        let deadline = Date().addingTimeInterval(5)
        while !running.capture.text.contains("ready"), running.process.isRunning,
              Date() < deadline {
            try await Task.sleep(for: .milliseconds(10))
        }
        guard running.capture.text.contains("ready") else { throw TestFailure.diagnostics(running.diagnostics.text) }
    }

    private func waitExited(_ running: Running) async throws {
        let deadline = Date().addingTimeInterval(5)
        while running.process.isRunning, Date() < deadline {
            try await Task.sleep(for: .milliseconds(10))
        }
        guard !running.process.isRunning else { throw TestFailure.diagnostics(running.diagnostics.text) }
    }

    private func waitAbsent(_ path: String) async throws {
        let deadline = Date().addingTimeInterval(5)
        while FileManager.default.fileExists(atPath: path), Date() < deadline {
            try await Task.sleep(for: .milliseconds(10))
        }
        guard !FileManager.default.fileExists(atPath: path) else { throw TestFailure.fixture }
    }

    private func socketCommand(_ path: String) -> String {
        "import net from'node:net';import fs from'node:fs';let s=net.createServer(c=>c.once('data',()=>s.close(()=>{try{fs.unlinkSync(\(literal(path)))}catch{};process.exit(0)})));s.listen(\(literal(path)));"
    }

    private func sendExit(_ path: String) throws {
        guard FileManager.default.fileExists(atPath: path) else { return }
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { throw TestFailure.fixture }
        defer { Darwin.close(fd) }
        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        let bytes = Array(path.utf8CString)
        guard bytes.count <= MemoryLayout.size(ofValue: address.sun_path) else { throw TestFailure.fixture }
        withUnsafeMutableBytes(of: &address.sun_path) { $0.copyBytes(from: bytes.map { UInt8(bitPattern: $0) }) }
        let connected = withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
        }
        guard connected == 0 else { throw TestFailure.fixture }
        let byte: [UInt8] = [1]
        _ = byte.withUnsafeBytes { Darwin.write(fd, $0.baseAddress, 1) }
    }
}
