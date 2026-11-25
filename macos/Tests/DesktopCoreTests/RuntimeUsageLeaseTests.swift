// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import CryptoKit
import Darwin
@testable import DesktopCore
import Foundation
import XCTest

final class RuntimeUsageLeaseTests: XCTestCase {
    private var home: URL!
    private var startedEpochs = Set<String>()
    private var cleanupSockets: [String] = []
    private var cache: URL {
        home.appendingPathComponent("runtime", isDirectory: true)
    }

    override func setUpWithError() throws {
        home = FileManager.default.temporaryDirectory.appendingPathComponent("omnesis-usage-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        home = home.resolvingSymlinksInPath()
        try FileManager.default.createDirectory(at: cache, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    }

    override func tearDownWithError() throws {
        for path in cleanupSockets {
            _ = sendExit(path)
        }
        for epoch in startedEpochs where FileManager.default.fileExists(atPath: cache.appendingPathComponent(epoch).path) {
            let deadline = Date().addingTimeInterval(5)
            var released = false
            while Date() < deadline {
                let available = try DesktopRuntimeUsageLease.withReclaimableEpoch(
                    cache: cache,
                    epoch: epoch,
                    currentEpoch: String(repeating: "0", count: 64),
                    operation: { _ in true }
                )
                if available == true { released = true
                    break
                }
                usleep(10000)
            }
            if !released { throw FixtureFailure.busyOwnedChild }
        }
        for path in cleanupSockets {
            try? FileManager.default.removeItem(atPath: path)
        }
        try FileManager.default.removeItem(at: home)
    }

    private func builtTool() throws -> URL {
        var directory = Bundle(for: RuntimeUsageLeaseTests.self).bundleURL.deletingLastPathComponent()
        for _ in 0 ..< 5 {
            let candidate = directory.appendingPathComponent("OmnesisRuntimeExec")
            if FileManager.default.isExecutableFile(atPath: candidate.path) { return candidate }
            directory.deleteLastPathComponent()
        }
        throw FixtureFailure.missingBuiltTool
    }

    private enum FixtureFailure: Error { case missingBuiltTool, missingNode, fixtureFailed, busyOwnedChild
        case detail(String)
    }

    private struct NodeFixture: Decodable {
        let format: Int
        let owner: String
        let nodeVersion: String
        let architecture: String
        let archiveSha256: String
        let executableSha256: String
    }

    private func hostNode() throws -> URL {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().appendingPathComponent(".node-fixture", isDirectory: true)
        let metadataBytes = try Data(contentsOf: root.appendingPathComponent("node-fixture.json"))
        guard metadataBytes.count <= 4096 else { throw FixtureFailure.missingNode }
        let metadata = try JSONDecoder().decode(NodeFixture.self, from: metadataBytes)
        #if arch(arm64)
        let architecture = "arm64"
        #else
        let architecture = "x64"
        #endif
        guard metadata.format == 1, metadata.owner == "omnesis-desktop-node-test-fixture",
              metadata.nodeVersion.hasPrefix("24."), metadata.architecture == architecture,
              metadata.archiveSha256.count == 64 else { throw FixtureFailure.missingNode }
        let node = root.appendingPathComponent("node")
        let file = try FileHandle(forReadingFrom: node)
        defer { try? file.close() }
        var digest = SHA256()
        while let bytes = try file.read(upToCount: 1024 * 1024), !bytes.isEmpty {
            digest.update(data: bytes)
        }
        guard digest.finalize().map({ String(format: "%02x", $0) }).joined() == metadata.executableSha256 else {
            throw FixtureFailure.detail("The pinned Node build-input fixture failed its integrity check")
        }
        return node
    }

    private func fixture(tag: String, usageProtocol: Bool = true) throws -> URL {
        let source = home.appendingPathComponent("stage-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: source.appendingPathComponent("packages/core/dist"), withIntermediateDirectories: true)
        try FileManager.default.copyItem(at: builtTool(), to: source.appendingPathComponent("runtime-exec"))
        try FileManager.default.copyItem(at: hostNode(), to: source.appendingPathComponent("node"))
        try Data(
            "import {fileURLToPath} from 'node:url';Object.defineProperty(process,'execPath',{value:fileURLToPath(new URL('../../../runtime-exec',import.meta.url)),writable:false,configurable:false});\n"
                .utf8
        )
        .write(to: source.appendingPathComponent("packages/core/dist/managed-runtime-bootstrap.js"))
        var manifest: [String: Any] = [
            "format": 1,
            "fixture": tag,
            "inventory": [["path": "node", "executable": true], ["path": "runtime-exec", "executable": true]],
        ]
        if usageProtocol { manifest["codeUsageProtocol"] = 1
            manifest["runtimeLauncher"] = "runtime-exec"
        }
        let data = try JSONSerialization.data(withJSONObject: manifest, options: [.sortedKeys])
        try data.write(to: source.appendingPathComponent("desktop-runtime.json"))
        let epoch = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        let runtime = cache.appendingPathComponent(epoch, isDirectory: true)
        try FileManager.default.moveItem(at: source, to: runtime)
        return runtime
    }

    private final class Capture: @unchecked Sendable {
        private let lock = NSLock()
        private var value = ""
        func append(_ data: Data) {
            lock.lock()
            defer { lock.unlock() }
            value = String((value + (String(data: data, encoding: .utf8) ?? "")).suffix(8192))
        }

        var text: String {
            lock.lock()
            defer { lock.unlock() }
            return value
        }

        var ready: Bool {
            text.contains("ready")
        }
    }

    private struct Running {
        let process: Process
        let input: Pipe
        let output: Pipe
        let errors: Pipe
        let capture: Capture
        let diagnostics: Capture
    }

    private func start(runtime: URL, arguments: [String]) throws -> Running {
        let process = Process(), input = Pipe(), output = Pipe(), errors = Pipe()
        let capture = Capture(), diagnostics = Capture()
        process.executableURL = runtime.appendingPathComponent("runtime-exec")
        process.arguments = arguments
        process.currentDirectoryURL = runtime
        process.standardInput = input
        process.standardOutput = output
        process.standardError = errors
        output.fileHandleForReading.readabilityHandler = { capture.append($0.availableData) }
        errors.fileHandleForReading.readabilityHandler = { diagnostics.append($0.availableData) }
        try process.run()
        startedEpochs.insert(runtime.lastPathComponent)
        return Running(process: process, input: input, output: output, errors: errors, capture: capture, diagnostics: diagnostics)
    }

    private func waitReady(_ running: Running) async throws {
        let deadline = Date().addingTimeInterval(5)
        while !running.capture.ready, running.process.isRunning, Date() < deadline {
            try await Task.sleep(for: .milliseconds(10))
        }
        guard running.capture.ready else {
            let status = running.process.isRunning ? "running" : String(running.process.terminationStatus)
            let detail = "fixture readiness failed (" + status + "): " + running.diagnostics.text
            stop(running)
            throw FixtureFailure.detail(detail)
        }
    }

    private func waitExited(_ running: Running) async throws {
        let deadline = Date().addingTimeInterval(5)
        while running.process.isRunning, Date() < deadline {
            try await Task.sleep(for: .milliseconds(10))
        }
        if running.process.isRunning { stop(running)
            throw FixtureFailure.detail("fixture exit timed out: " + running.diagnostics.text)
        }
    }

    private func stop(_ running: Running) {
        running.output.fileHandleForReading.readabilityHandler = nil
        running.errors.fileHandleForReading.readabilityHandler = nil
        if running.process.isRunning { kill(running.process.processIdentifier, SIGKILL)
            running.process.waitUntilExit()
        }
        try? running.input.fileHandleForWriting.close()
        try? running.output.fileHandleForReading.close()
        try? running.errors.fileHandleForReading.close()
    }

    private func probe(from runtime: URL, target: URL) async throws -> Int32 {
        let running = try start(runtime: runtime, arguments: ["--gc-probe", target.lastPathComponent])
        defer { stop(running) }
        try await waitExited(running)
        guard !running.process.isRunning else { throw FixtureFailure.fixtureFailed }
        return running.process.terminationStatus
    }

    private func assertProbe(from runtime: URL, target: URL, expected: Int32) async throws {
        let status = try await probe(from: runtime, target: target)
        XCTAssertEqual(status, expected)
    }

    func testLegacyDataReservationRefusesLiveAndUnknownCodeMembership() throws {
        let legacy = try fixture(tag: "legacy-data-consumer")
        var live: DesktopRuntimeUsageLease? = try DesktopRuntimeUsageLease.acquire(runtime: legacy)
        XCTAssertThrowsError(try DesktopRuntimeUsageLease.reserveLegacyDataConsumers(cache: cache))
        withExtendedLifetime(live) {}
        live = nil
        var reservation: DesktopRuntimeUsageLease.LegacyDataReservation? = try DesktopRuntimeUsageLease
            .reserveLegacyDataConsumers(cache: cache)
        XCTAssertNotNil(reservation)
        withExtendedLifetime(reservation) {}
        reservation = nil
        _ = try fixture(tag: "unknown-data-consumer", usageProtocol: false)
        XCTAssertThrowsError(try DesktopRuntimeUsageLease.reserveLegacyDataConsumers(cache: cache))
    }

    func testNativeReservationAndActualExecBothPinTheEpoch() async throws {
        let first = try fixture(tag: "controller"), second = try fixture(tag: "held")
        var native: DesktopRuntimeUsageLease? = try DesktopRuntimeUsageLease.acquire(runtime: second)
        try await assertProbe(from: first, target: second, expected: 3)
        withExtendedLifetime(native) {}
        native = nil
        try await assertProbe(from: first, target: second, expected: 0)
        let child = try start(
            runtime: second,
            arguments: [
                "--node",
                "-e",
                "process.stdout.write('ready');process.stdin.once('data',()=>process.exit(0));process.stdin.resume();",
            ]
        )
        defer { stop(child) }
        try await waitReady(child)
        try await assertProbe(from: first, target: second, expected: 3)
        try child.input.fileHandleForWriting.write(contentsOf: Data("stop\n".utf8))
        try await waitExited(child)
        XCTAssertEqual(child.process.terminationStatus, 0)
        try await assertProbe(from: first, target: second, expected: 0)
    }

    func testLegacyEpochAndEscapingExecutableNeverAcquireReclamationPermission() async throws {
        let first = try fixture(tag: "controller"), legacy = try fixture(tag: "legacy", usageProtocol: false)
        try await assertProbe(from: first, target: legacy, expected: 3)
        let lease = try DesktopRuntimeUsageLease.acquire(runtime: first)
        XCTAssertThrowsError(try lease.invocation(arguments: ["--exec", "../outside"]))
        XCTAssertThrowsError(try lease.invocation(arguments: ["--exec", "node", "-e", "0"]))
    }

    func testExternalInterpreterRetainsLeaseAndRuntimeRelativeTargetsCannotBypassInventory() async throws {
        let first = try fixture(tag: "controller"), second = try fixture(tag: "external")
        var lease: DesktopRuntimeUsageLease? = try DesktopRuntimeUsageLease.acquire(runtime: second)
        do {
            let held = try XCTUnwrap(lease)
            XCTAssertThrowsError(try held.invocation(arguments: [
                "--external", second.appendingPathComponent("packages/core/dist/managed-runtime-bootstrap.js").path,
            ]))
            XCTAssertEqual(
                try held.invocation(arguments: ["--external", second.appendingPathComponent("node").path, "-e", "0"]).executable,
                second.appendingPathComponent("node")
            )
        }
        withExtendedLifetime(lease) {}
        lease = nil
        let child = try start(runtime: second, arguments: ["--external", "/bin/sh", "-c", "printf ready; read line"])
        defer { stop(child) }
        try await waitReady(child)
        try await assertProbe(from: first, target: second, expected: 3)
        try child.input.fileHandleForWriting.write(contentsOf: Data("stop\n".utf8))
        try await waitExited(child)
        XCTAssertEqual(child.process.terminationStatus, 0)
        try await assertProbe(from: first, target: second, expected: 0)
        let relative = try start(
            runtime: second,
            arguments: [
                "--external",
                "./node",
                "-e",
                "process.stdout.write('ready:'+process.execPath);process.stdin.once('data',()=>process.exit(0));process.stdin.resume();",
            ]
        )
        defer { stop(relative) }
        try await waitReady(relative)
        XCTAssertTrue(relative.capture.text.contains("runtime-exec"))
        try relative.input.fileHandleForWriting.write(contentsOf: Data("stop\n".utf8))
        try await waitExited(relative)
        XCTAssertEqual(relative.process.terminationStatus, 0, relative.diagnostics.text)
    }

    func testNodeCompatibleDefaultSupportsForkIPCAndStdinEvaluation() async throws {
        let runtime = try fixture(tag: "node-compatible")
        let entry = home.appendingPathComponent("invented-fork-child.cjs")
        try Data(
            "if(!process.execArgv.includes('--use-system-ca'))process.exit(2);process.send({ready:true});process.once('message',()=>process.exit(0));setTimeout(()=>process.exit(1),5000);"
                .utf8
        )
        .write(to: entry)
        let code = "if(!process.execArgv.includes('--use-system-ca'))process.exit(2);const child=require('node:child_process').fork(\(String(reflecting: entry.path)),[],{stdio:['ignore','ignore','ignore','ipc']});child.once('message',()=>process.stdout.write('ready'));process.stdin.once('data',()=>child.send('stop'));child.once('exit',code=>process.exit(code));process.stdin.resume();"
        let child = try start(runtime: runtime, arguments: ["-e", code])
        defer { stop(child) }
        try await waitReady(child)
        try child.input.fileHandleForWriting.write(contentsOf: Data("stop\n".utf8))
        try await waitExited(child)
        XCTAssertEqual(child.process.terminationStatus, 0, child.diagnostics.text)
        let stdin = try start(runtime: runtime, arguments: ["--input-type=module"])
        defer { stop(stdin) }
        try stdin.input.fileHandleForWriting
            .write(
                contentsOf: Data(
                    "if (!process.execArgv.includes('--use-system-ca') || !process.execPath.endsWith('/runtime-exec') || !process.argv[0].endsWith('/node')) process.exit(1);\n"
                        .utf8
                )
            )
        try stdin.input.fileHandleForWriting.close()
        try await waitExited(stdin)
        XCTAssertEqual(stdin.process.terminationStatus, 0, stdin.diagnostics.text)
    }

    func testCleanupRefusesHeldCurrentAndLegacyEpochsAndActuallyRemovesIdleCode() throws {
        let first = try fixture(tag: "current"), second = try fixture(tag: "unused")
        let legacy = try fixture(tag: "legacy-cleanup", usageProtocol: false)
        XCTAssertFalse(try DesktopRuntimeUsageLease.removeReclaimableRuntime(
            cache: cache, epoch: first.lastPathComponent, currentEpoch: first.lastPathComponent
        ))
        XCTAssertFalse(try DesktopRuntimeUsageLease.removeReclaimableRuntime(
            cache: cache, epoch: legacy.lastPathComponent, currentEpoch: first.lastPathComponent
        ))
        var held: DesktopRuntimeUsageLease? = try DesktopRuntimeUsageLease.acquire(runtime: second)
        XCTAssertFalse(try DesktopRuntimeUsageLease.removeReclaimableRuntime(
            cache: cache, epoch: second.lastPathComponent, currentEpoch: first.lastPathComponent
        ))
        withExtendedLifetime(held) {}
        held = nil
        XCTAssertTrue(try DesktopRuntimeUsageLease.removeReclaimableRuntime(
            cache: cache, epoch: second.lastPathComponent, currentEpoch: first.lastPathComponent
        ))
        XCTAssertFalse(FileManager.default.fileExists(atPath: second.path))
    }

    func testPartialCleanupReceiptBlocksStartupAndAllowsOnlySameInodeRetry() throws {
        let first = try fixture(tag: "current"), second = try fixture(tag: "partial")
        XCTAssertThrowsError(try DesktopRuntimeUsageLease.removeReclaimableRuntime(
            cache: cache, epoch: second.lastPathComponent, currentEpoch: first.lastPathComponent
        ) { target in
            try FileManager.default.removeItem(at: target.appendingPathComponent("node"))
            throw FixtureFailure.fixtureFailed
        })
        XCTAssertThrowsError(try DesktopRuntimeUsageLease.acquire(runtime: second))
        XCTAssertTrue(try DesktopRuntimeUsageLease.removeReclaimableRuntime(
            cache: cache, epoch: second.lastPathComponent, currentEpoch: first.lastPathComponent
        ))
        XCTAssertFalse(FileManager.default.fileExists(atPath: second.path))
    }

    func testRetainedApplicationLaunchReservationBlocksRuntimeCleanupUntilAcknowledged() throws {
        let first = try fixture(tag: "current"), second = try fixture(tag: "launch-reserved")
        let applications = home.appendingPathComponent("applications", isDirectory: true)
        let reservations = applications.appendingPathComponent(".launch-reservations", isDirectory: true)
        try FileManager.default.createDirectory(at: reservations, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let record = reservations.appendingPathComponent(UUID().uuidString + ".json")
        let payload: [String: Any] = [
            "format": 1,
            "owner": "omnesis-desktop-application-launch",
            "epoch": second.lastPathComponent,
            "application": applications.appendingPathComponent(second.lastPathComponent)
                .appendingPathComponent("Omnesis.app").path,
        ]
        try JSONSerialization.data(withJSONObject: payload).write(to: record)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: record.path)
        XCTAssertNil(try DesktopRuntimeUsageLease.withReclaimableEpoch(
            cache: cache,
            epoch: second.lastPathComponent,
            currentEpoch: first.lastPathComponent
        ) { _ in true })
        XCTAssertFalse(try DesktopRuntimeUsageLease.removeReclaimableRuntime(
            cache: cache,
            epoch: second.lastPathComponent,
            currentEpoch: first.lastPathComponent
        ))
        try Data("malformed interrupted reservation".utf8).write(to: record)
        XCTAssertFalse(try DesktopRuntimeUsageLease.removeReclaimableRuntime(
            cache: cache,
            epoch: second.lastPathComponent,
            currentEpoch: first.lastPathComponent
        ))
        try FileManager.default.removeItem(at: record)
        XCTAssertTrue(try DesktopRuntimeUsageLease.removeReclaimableRuntime(
            cache: cache,
            epoch: second.lastPathComponent,
            currentEpoch: first.lastPathComponent
        ))
    }

    func testCleanupReceiptCannotAuthorizeReplacementDirectory() throws {
        let first = try fixture(tag: "current"), second = try fixture(tag: "replaced")
        XCTAssertThrowsError(try DesktopRuntimeUsageLease.removeReclaimableRuntime(
            cache: cache, epoch: second.lastPathComponent, currentEpoch: first.lastPathComponent
        ) { _ in throw FixtureFailure.fixtureFailed })
        // Keep the original inode alive to ensure the replacement cannot reuse its inode number.
        let retired = home.appendingPathComponent("retired-directory")
        try FileManager.default.moveItem(at: second, to: retired)
        try FileManager.default.createDirectory(at: second, withIntermediateDirectories: false)
        let sentinel = second.appendingPathComponent("must-stay")
        try Data("invented fixture".utf8).write(to: sentinel)
        XCTAssertThrowsError(try DesktopRuntimeUsageLease.removeReclaimableRuntime(
            cache: cache, epoch: second.lastPathComponent, currentEpoch: first.lastPathComponent
        ))
        XCTAssertTrue(FileManager.default.fileExists(atPath: sentinel.path))
    }

    func testGCReservationWinningStartupRefusesBeforeAnyNodeCodeLoads() async throws {
        let first = try fixture(tag: "controller"), second = try fixture(tag: "starting")
        let marker = home.appendingPathComponent("must-not-exist")
        let code = "require('node:fs').writeFileSync(\(String(reflecting: marker.path)), 'unsafe')"
        let child = try XCTUnwrap(DesktopRuntimeUsageLease.withReclaimableEpoch(
            cache: cache,
            epoch: second.lastPathComponent,
            currentEpoch: first.lastPathComponent
        ) { target in
            let child = try start(runtime: second, arguments: ["--node", "-e", code])
            try FileManager.default.removeItem(at: target)
            return child
        })
        defer { stop(child) }
        try await waitExited(child)
        let diagnostics = "reason=\(child.process.terminationReason.rawValue), status=\(child.process.terminationStatus): \(child.diagnostics.text)"
        // Deleting the reserved epoch can invalidate the mapped static adapter before it reaches
        // its explicit refusal. Neither permitted outcome may load the guarded Node entry.
        if child.process.terminationReason == .exit {
            XCTAssertEqual(child.process.terminationStatus, 78, diagnostics)
        } else {
            XCTAssertEqual(child.process.terminationReason, .uncaughtSignal, diagnostics)
            XCTAssertEqual(child.process.terminationStatus, SIGKILL, diagnostics)
        }
        XCTAssertFalse(FileManager.default.fileExists(atPath: marker.path))
    }

    func testOrphanChildRetainsLeaseAfterActualParentSIGKILL() async throws {
        let first = try fixture(tag: "controller"), second = try fixture(tag: "orphan")
        let socketPath = "/tmp/omnesis-usage-" + String(UUID().uuidString.prefix(12)) + ".sock"
        cleanupSockets.append(socketPath)
        let readyPath = home.appendingPathComponent("raw-child-ready").path
        let childCode = "const net=require('node:net');const server=net.createServer(s=>s.once('data',()=>{s.end();server.close(()=>process.exit(0));}));server.listen(\(String(reflecting: socketPath)),()=>require('node:fs').writeFileSync(\(String(reflecting: readyPath)),'ready'));setTimeout(()=>process.exit(0),10000);"
        let encoded = try XCTUnwrap(try String(data: JSONSerialization.data(withJSONObject: [childCode]), encoding: .utf8))
        let parentCode = "require('node:child_process').spawn(process.execPath,['-e',JSON.parse(\(String(reflecting: encoded)))[0]],{stdio:['ignore','ignore','ignore']});const timer=setInterval(()=>{if(require('node:fs').existsSync(\(String(reflecting: readyPath)))){process.stdout.write('ready');clearInterval(timer);}},10);setInterval(()=>{},1000);"
        let parent = try start(runtime: second, arguments: ["--node", "-e", parentCode])
        defer { stop(parent) }
        try await waitReady(parent)
        kill(parent.process.processIdentifier, SIGKILL)
        try await waitExited(parent)
        try await assertProbe(from: first, target: second, expected: 3)
        XCTAssertTrue(sendExit(socketPath))
        for attempt in 0 ..< 40 {
            if try await probe(from: first, target: second) == 0 { return }
            if attempt == 39 { XCTFail("The fixture child did not release its kernel lease")
                return
            }
            try await Task.sleep(for: .milliseconds(25))
        }
    }

    private func sendExit(_ path: String) -> Bool {
        let descriptor = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
        guard descriptor >= 0 else { return false }
        defer { Darwin.close(descriptor) }
        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        let bytes = Array(path.utf8) + [0]
        guard bytes.count <= MemoryLayout.size(ofValue: address.sun_path) else { return false }
        withUnsafeMutableBytes(of: &address.sun_path) { buffer in buffer.copyBytes(from: bytes) }
        let connected = withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.connect(
                descriptor,
                $0,
                socklen_t(MemoryLayout<sockaddr_un>.size)
            ) }
        }
        guard connected == 0 else { return false }
        return "exit".withCString { Darwin.write(descriptor, $0, 4) == 4 }
    }
}
