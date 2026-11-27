// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import CryptoKit
import Darwin
@testable import DesktopCore
import Foundation
import XCTest

final class RuntimeUsageLeaseTests: XCTestCase {
    private static let retentionLock = NSLock()
    private static var retainedFixtures: [RuntimeUsageLeaseTests] = []
    private var capturedReaders: [(reader: FileHandle, capture: Capture, parent: Process?)] = []
    private var launchedParents: [Process] = []
    private var joinedParents = Set<ObjectIdentifier>()
    private var descendantJoins: [ObjectIdentifier: Bool] = [:]
    private var trackedChildren: [ObjectIdentifier: CatalogFixtureChild] = [:]
    private var readerClosureFailed = false
    private var home: URL!
    private var startedEpochs = Set<String>()
    private var cleanupSockets: [String] = []
    private var cache: URL {
        home.appendingPathComponent("runtime", isDirectory: true)
    }

    override func setUpWithError() throws {
        home = FileManager.default.temporaryDirectory.appendingPathComponent("omnesis-usage-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        home = try URL(fileURLWithPath: DesktopCanonicalPath.resolve(home.path), isDirectory: true)
        try FileManager.default.createDirectory(at: cache, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    }

    override func tearDownWithError() throws {
        var retired = false
        defer {
            if !retired { Self.retentionLock.withLock { Self.retainedFixtures.append(self) } }
        }
        guard !readerClosureFailed, !descendantJoins.values.contains(false) else { throw FixtureFailure.busyOwnedChild }
        for parent in launchedParents {
            guard !parent.isRunning else { throw FixtureFailure.busyOwnedChild }
            // Known-launched, already-ended Process: observe Foundation's exit receipt.
            _ = (status: parent.terminationStatus, reason: parent.terminationReason)
            joinedParents.insert(ObjectIdentifier(parent))
        }
        try retireCapturedReaders()
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
        launchedParents.removeAll()
        trackedChildren.removeAll()
        retired = true
    }

    func testOwnedRuntimePipeFinalBytesAndEOFDisarmBeforeReaderRetirement() async throws {
        let pipe = Pipe(), capture = Capture()
        installCapture(capture, on: pipe.fileHandleForReading)
        defer { try? pipe.fileHandleForWriting.close() }
        let text = String(repeating: "x", count: 12000) + "final-ready"
        try pipe.fileHandleForWriting.write(contentsOf: Data(text.utf8))
        try pipe.fileHandleForWriting.close()
        let deadline = ContinuousClock.now.advanced(by: .seconds(5))
        while !capture.reachedEOF, ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(10))
        }
        guard capture.reachedEOF, ContinuousClock.now < deadline else {
            XCTFail("The exact owned pipe must observe final bytes and EOF before its deadline")
            return
        }
        XCTAssertNil(pipe.fileHandleForReading.readabilityHandler)
        XCTAssertEqual(capture.text, String(text.suffix(8192)))
        XCTAssertTrue(capture.ready)
        XCTAssertFalse(capture.readerClosed)
        try retireCapturedReaders()
        XCTAssertTrue(capture.readerClosed)
        // Repeating owner retirement has no entries to close or descriptors to inspect.
        try retireCapturedReaders()
        XCTAssertEqual(capture.text, String(text.suffix(8192)))
    }

    func testFailedRuntimeLaunchRetainsExactReadersUntilKnownNoChildRetirement() throws {
        XCTAssertThrowsError(try start(runtime: home.appendingPathComponent("missing-runtime"), arguments: []))
        XCTAssertTrue(launchedParents.isEmpty)
        XCTAssertEqual(capturedReaders.count, 2)
        let retained = capturedReaders
        XCTAssertTrue(retained.allSatisfy { !$0.capture.readerClosed })
        try retireCapturedReaders()
        XCTAssertTrue(capturedReaders.isEmpty)
        for entry in retained {
            XCTAssertNil(entry.reader.readabilityHandler)
            XCTAssertTrue(entry.capture.readerClosed)
        }
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

    func testUnknownProcessAuthorityPayloadCannotLaunch() throws {
        for version in [nil, 1, 2, 4] as [Int?] {
            let runtime = try fixture(tag: "unknown-process-ownership", processProtocol: version)
            XCTAssertThrowsError(try DesktopRuntimeUsageLease.acquire(runtime: runtime))
            XCTAssertThrowsError(try DesktopRuntimeUsageLease.reserveLegacyDataConsumers(cache: cache))
            XCTAssertFalse(try DesktopRuntimeUsageLease.removeReclaimableRuntime(
                cache: cache, epoch: runtime.lastPathComponent, currentEpoch: String(repeating: "f", count: 64)
            ))
            XCTAssertTrue(FileManager.default.fileExists(atPath: runtime.path))
        }
    }

    private func fixture(tag: String, usageProtocol: Bool = true, processProtocol: Int? = 3) throws -> URL {
        let source = home.appendingPathComponent("stage-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: source.appendingPathComponent("packages/core/dist"), withIntermediateDirectories: true)
        try FileManager.default.copyItem(at: builtTool(), to: source.appendingPathComponent("runtime-exec"))
        try FileManager.default.copyItem(at: hostNode(), to: source.appendingPathComponent("node"))
        try Data(
            "import{writeSync}from'node:fs';if(process.env.OMNESIS_TEST_READY_STAGES==='1')writeSync(2,'fixture-stage:preload-enter\\n');import {fileURLToPath} from 'node:url';Object.defineProperty(process,'execPath',{value:fileURLToPath(new URL('../../../runtime-exec',import.meta.url)),writable:false,configurable:false});\n"
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
        if let processProtocol { manifest["processAuthorityProtocol"] = processProtocol }
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
        private var ended = false
        private var stopped = false
        private var closed = false

        func receive(_ reader: FileHandle) {
            lock.lock()
            defer { lock.unlock() }
            guard !stopped, !ended else { return }
            let data = reader.availableData
            if data.isEmpty {
                reader.readabilityHandler = nil
                ended = true
                return
            }
            value = String((value + (String(data: data, encoding: .utf8) ?? "")).suffix(8192))
        }

        func close(_ reader: FileHandle) throws {
            reader.readabilityHandler = nil
            lock.lock()
            defer { lock.unlock() }
            stopped = true
            guard !closed else { return }
            try reader.close()
            closed = true
        }

        var readerClosed: Bool {
            lock.withLock { closed }
        }

        var text: String {
            lock.lock()
            defer { lock.unlock() }
            return value
        }

        var ready: Bool {
            text.contains("ready")
        }

        var reachedEOF: Bool {
            lock.lock()
            defer { lock.unlock() }
            return ended
        }
    }

    private struct Running {
        let process: Process
        let input: Pipe
        let output: Pipe
        let errors: Pipe
        let capture: Capture
        let diagnostics: Capture
        let readinessStage: String
        let bootstrapDeadline: ContinuousClock.Instant
        let diagnosticTarget: DesktopReadinessFailureDiagnostic.Target?
    }

    private func start(runtime: URL, arguments: [String], readinessStage: String = "other") throws -> Running {
        let process = Process(), input = Pipe(), output = Pipe(), errors = Pipe()
        let capture = Capture(), diagnostics = Capture()
        process.executableURL = runtime.appendingPathComponent("runtime-exec")
        process.arguments = arguments
        if readinessStage != "other" {
            process.environment = ProcessInfo.processInfo.environment.merging(["OMNESIS_TEST_READY_STAGES": "1"]) { _, value in value }
        }
        process.currentDirectoryURL = runtime
        process.standardInput = input
        process.standardOutput = output
        process.standardError = errors
        installCapture(capture, on: output.fileHandleForReading, parent: process)
        installCapture(diagnostics, on: errors.fileHandleForReading, parent: process)
        let bootstrapDeadline = FixtureReadiness.bootstrapDeadline()
        do { try process.run() }
        catch {
            if process.isRunning { launchedParents.append(process) }
            throw error
        }
        launchedParents.append(process)
        startedEpochs.insert(runtime.lastPathComponent)
        return Running(
            process: process,
            input: input,
            output: output,
            errors: errors,
            capture: capture,
            diagnostics: diagnostics,
            readinessStage: readinessStage,
            bootstrapDeadline: bootstrapDeadline,
            diagnosticTarget: .init(process: process, runtime: runtime)
        )
    }

    /// Failure-only metadata for this exact owned child; no path, PID, body or raw log is published.
    private func readinessDiagnostics(_ running: Running) -> String {
        var executable = [CChar](repeating: 0, count: 4096)
        let inspected = proc_pidpath(running.process.processIdentifier, &executable, UInt32(executable.count)) > 0
        let image: String
        if inspected, let expected = running.process.executableURL {
            let actual = String(cString: executable)
            image = actual == expected.path ? "runtime-exec" :
                actual == expected.deletingLastPathComponent().appendingPathComponent("node").path ? "node" : "other"
        } else { image = "unavailable" }
        func pipeState(_ handle: FileHandle) -> String {
            var descriptor = pollfd(fd: handle.fileDescriptor, events: Int16(POLLIN), revents: 0)
            let result = Darwin.poll(&descriptor, 1, 0)
            return "poll=\(result),readable=\(descriptor.revents & Int16(POLLIN) != 0),hangup=\(descriptor.revents & Int16(POLLHUP) != 0),error=\(descriptor.revents & Int16(POLLERR) != 0)"
        }
        var allowed: Set = [
            "preload-enter", "controller-script-enter", "controller-ready-written", "exclusive-host-enter",
            "exclusive-ready-written", "scrub-enter", "scrub-complete", "catalog-parent-enter", "catalog-child-spawned",
            "catalog-socket-observed", "catalog-ready-written", "fork-parent-enter", "fork-child-spawned",
            "fork-child-enter", "fork-child-sent", "fork-parent-message", "fork-ready-written", "relative-node-enter",
            "fork-parent-initialized", "fork-child-initialized", "fork-child-joined", "fork-child-disconnected", "fork-child-error",
        ]
        for mode in [
            "key-recovery",
            "background-start",
            "background-daemon",
            "background-retire",
            "verify-background-owner",
            "verify-background-retirement",
            "background-binding",
            "background-rebind",
        ] {
            allowed.insert("scrub-before---" + mode)
            allowed.insert("scrub-after---" + mode)
        }
        let stages = running.diagnostics.text.split(separator: "\n").compactMap { line -> String? in
            let prefix = "fixture-stage:"
            guard line.hasPrefix(prefix) else { return nil }
            let stage = String(line.dropFirst(prefix.count))
            return allowed.contains(stage) ? stage : nil
        }.suffix(24).joined(separator: ",")
        return "image=\(image); stdoutBytes=\(running.capture.text.utf8.count); stderrBytes=\(running.diagnostics.text.utf8.count); stdout[\(pipeState(running.output.fileHandleForReading))]; stderr[\(pipeState(running.errors.fileHandleForReading))]; stages=\(stages); nativeRefusal=\(running.diagnostics.text.contains("The managed runtime lease could not be established")); nativeCode=\(DesktopReadinessFailureDiagnostic.nativeRefusalCode(running.diagnostics.text))"
    }

    private enum ReadinessPhase: String, Sendable { case stdout, forkParent, forkChild }

    private func waitReady(
        _ running: Running, phase: ReadinessPhase = .stdout,
        budget: FixtureReadiness.Budget = .postStart,
        catalog: CatalogFixtureChild? = nil,
        until: ContinuousClock.Instant? = nil
    ) async throws {
        let observed: @Sendable () -> Bool = { [capture = running.capture, diagnostics = running.diagnostics] in
            switch phase {
            case .stdout: return capture.ready
            case .forkParent: return diagnostics.text.split(separator: "\n").contains("fixture-stage:fork-parent-initialized")
            case .forkChild: return diagnostics.text.split(separator: "\n").contains("fixture-stage:fork-child-initialized")
            }
        }
        try await FixtureReadiness.wait(budget: budget, until: until, isRunning: { running.process.isRunning }, isReady: {
            try catalog?.tryAdopt()
            return observed() && (catalog == nil || catalog?.identity != nil)
        }) { _ in
            let status = running.process.isRunning ? "running" : String(running.process.terminationStatus)
            let detail = "fixture readiness failed (" + status + "); stage=" + running.readinessStage +
                "; phase=" + phase.rawValue + "; " + readinessDiagnostics(running)
            let observation = await DesktopReadinessFailureDiagnostic.collect(target: running.diagnosticTarget, captureReady: observed)
            stop(running)
            // The shared waiter latched failure before this diagnostic callback.
            throw FixtureFailure.detail(detail + "; " + observation)
        }
    }

    /// Every writer must physically close before the fixture can assert a complete captured transcript.
    private func waitCapturedEOF(_ running: Running) async throws {
        let deadline = Date().addingTimeInterval(5)
        while !(running.capture.reachedEOF && running.diagnostics.reachedEOF), Date() < deadline {
            try await Task.sleep(for: .milliseconds(10))
        }
        guard running.capture.reachedEOF, running.diagnostics.reachedEOF else {
            throw FixtureFailure.detail("owned fork pipes did not physically close")
        }
    }

    private func waitExited(_ running: Running, until: ContinuousClock.Instant? = nil) async throws {
        let deadline = until ?? ContinuousClock.now.advanced(by: .seconds(5))
        while running.process.isRunning, ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(10))
        }
        if running.process.isRunning || (until != nil && ContinuousClock.now >= deadline) { stop(running)
            throw FixtureFailure.detail("fixture exit timed out: " + running.diagnostics.text)
        }
    }

    private func installCapture(_ capture: Capture, on reader: FileHandle, parent: Process? = nil) {
        capturedReaders.append((reader, capture, parent))
        reader.readabilityHandler = { capture.receive($0) }
    }

    private func canRetire(_ parent: Process?) -> Bool {
        guard let parent else { return true }
        let id = ObjectIdentifier(parent)
        return !parent.isRunning && descendantJoins[id] != false &&
            (!launchedParents.contains(where: { $0 === parent }) || joinedParents.contains(id))
    }

    private func retireCapturedReaders(for parent: Process? = nil) throws {
        let selected = capturedReaders.filter { parent == nil || $0.parent === parent }
        guard selected.allSatisfy({ canRetire($0.parent) }) else { throw FixtureFailure.busyOwnedChild }
        for entry in selected {
            try entry.capture.close(entry.reader)
        }
        capturedReaders.removeAll { parent == nil || $0.parent === parent }
    }

    private func stop(_ running: Running) {
        if running.process.isRunning {
            guard kill(running.process.processIdentifier, SIGKILL) == 0 || errno == ESRCH else {
                readerClosureFailed = true
                XCTFail("Owned fixture stop was refused; exact readers and owner retained")
                return
            }
            running.process.waitUntilExit()
        }
        // stop receives only a successfully launched exact Process; live children
        // still join above, while already-ended children need no second wait.
        _ = (status: running.process.terminationStatus, reason: running.process.terminationReason)
        joinedParents.insert(ObjectIdentifier(running.process))
        try? running.input.fileHandleForWriting.close()
        // A tracked descendant can still own the same pipe writers after its parent exits.
        // Existing async child teardown must confirm that cohort before reader retirement.
        guard canRetire(running.process) else { return }
        do { try retireCapturedReaders(for: running.process) }
        catch {
            readerClosureFailed = true
            XCTFail("Owned reader closure is unconfirmed; exact fixture retained")
        }
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
        try await waitReady(child, until: child.bootstrapDeadline)
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
                "process.stderr.write('fixture-stage:relative-node-enter\\n');process.stdout.write('ready:'+process.execPath);process.stdin.once('data',()=>process.exit(0));process.stdin.resume();",
            ],
            readinessStage: "relative-node"
        )
        defer { stop(relative) }
        try await waitReady(relative, until: relative.bootstrapDeadline)
        XCTAssertTrue(relative.capture.text.contains("runtime-exec"))
        try relative.input.fileHandleForWriting.write(contentsOf: Data("stop\n".utf8))
        try await waitExited(relative)
        XCTAssertEqual(relative.process.terminationStatus, 0, relative.diagnostics.text)
    }

    /// Fork is requested only after the first actual Node process has initialized.
    /// Parent and child share one absolute bootstrap deadline; later IPC/drain stay five seconds.
    private func forkRecipe() throws -> (code: String, receipt: URL) {
        let entry = home.appendingPathComponent("invented-fork-child.cjs")
        let receipt = home.appendingPathComponent("invented-fork-child.json")
        try Data("""
        const fs=require('node:fs');
        fs.writeSync(2,'fixture-stage:fork-child-enter\\n');
        if(!process.execArgv.includes('--use-system-ca'))process.exit(2);
        process.once('disconnect',()=>{fs.writeSync(2,'fixture-stage:fork-child-disconnected\\n');process.exit(0)});
        if(!process.connected)process.exit(1);
        let verified=false,timer=null;
        process.on('message',message=>{
          if(message==='stop'){if(timer)clearTimeout(timer);process.exit(0)}
          if(message!=='verify'||verified)process.exit(2);
          verified=true;timer=setTimeout(()=>process.exit(1),5000);
          process.send({ready:true},error=>{if(error)process.exit(1);fs.writeSync(2,'fixture-stage:fork-child-sent\\n')});
        });
        fs.writeSync(2,'fixture-stage:fork-child-initialized\\n');
        """.utf8).write(to: entry)
        let code = """
        const fs=require('node:fs');
        function stage(name){fs.writeSync(2,'fixture-stage:'+name+'\\n')}
        stage('fork-parent-enter');
        if(!process.execArgv.includes('--use-system-ca'))process.exit(2);
        let child=null,closing=false,failed=false;
        function stop(){if(closing)return;closing=true;if(!child){stage('fork-child-joined');process.exit(0);return}if(child.connected)child.send('stop',error=>{if(error)child.kill('SIGTERM')});else child.kill('SIGTERM')}
        process.once('SIGTERM',stop);
        process.stdin.once('data',request=>{
          if(request.toString().trim()!=='fork')process.exit(2);
          child=require('node:child_process').fork(\(String(reflecting: entry.path)),[],{stdio:['ignore','ignore',2,'ipc']});
          child.once('error',()=>{failed=true;stage('fork-child-error');stop()});
          child.once('spawn',()=>{try{fs.writeFileSync(\(String(reflecting: receipt
                  .path + ".partial")),JSON.stringify({pid:child.pid}),{mode:0o600,flag:'wx'});fs.renameSync(\(String(reflecting: receipt
                .path + ".partial")),\(String(reflecting: receipt
                .path)));stage('fork-child-spawned')}catch{failed=true;stage('fork-child-error');stop()}});
          child.once('message',message=>{if(closing||failed)return;if(!message||message.ready!==true){failed=true;child.kill('SIGKILL');return}stage('fork-parent-message');process.stdout.write('ready',()=>stage('fork-ready-written'))});
          child.once('close',(code,signal)=>{stage('fork-child-joined');process.exit(failed||signal||code===null?1:code)});
          process.stdin.once('data',request=>{
            if(request.toString().trim()!=='verify'){failed=true;stop();return}
            child.send('verify',error=>{if(error){failed=true;stop()}});
            process.stdin.once('data',stop);
          });
        });
        stage('fork-parent-initialized');
        process.stdin.resume();
        """
        return (code, receipt)
    }

    private func trackForkChild(_ parent: Running, runtime: URL, receipt: URL) throws -> CatalogFixtureChild {
        let parentID = ObjectIdentifier(parent.process)
        descendantJoins[parentID] = false
        let child = try CatalogFixtureChild(
            parent: parent.process, receipt: receipt,
            images: [runtime.appendingPathComponent("runtime-exec").path, runtime.appendingPathComponent("node").path],
            node: runtime.appendingPathComponent("node"),
            joined: { parent.diagnostics.text.contains("fixture-stage:fork-child-joined") }
        )
        trackedChildren[parentID] = child
        addTeardownBlock {
            try await child.cleanup(sendExit: {})
            self.descendantJoins[parentID] = true
        }
        return child
    }

    func testNodeCompatibleDefaultSupportsForkIPCAndStdinEvaluation() async throws {
        let runtime = try fixture(tag: "node-compatible")
        let recipe = try forkRecipe()
        let child = try start(runtime: runtime, arguments: ["-e", recipe.code], readinessStage: "fork-parent")
        defer { stop(child) }
        let forked = try trackForkChild(child, runtime: runtime, receipt: recipe.receipt)
        try await waitReady(child, phase: .forkParent, until: child.bootstrapDeadline)
        XCTAssertFalse(child.capture.ready)
        XCTAssertFalse(FileManager.default.fileExists(atPath: recipe.receipt.path))
        try child.input.fileHandleForWriting.write(contentsOf: Data("fork\n".utf8))
        try await waitReady(child, phase: .forkChild, catalog: forked, until: child.bootstrapDeadline)
        XCTAssertFalse(child.capture.ready)
        let verificationDeadline = ContinuousClock.now.advanced(by: .seconds(5))
        try child.input.fileHandleForWriting.write(contentsOf: Data("verify\n".utf8))
        try await waitReady(child, until: verificationDeadline)
        try child.input.fileHandleForWriting.write(contentsOf: Data("stop\n".utf8))
        try await waitExited(child)
        child.process.waitUntilExit()
        try await waitCapturedEOF(child)
        XCTAssertEqual(child.process.terminationStatus, 0, readinessDiagnostics(child))
        XCTAssertTrue(child.diagnostics.text.contains("fixture-stage:fork-child-joined"))
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
        // Node reads stdin through EOF before applying --import. This one-shot path
        // is the sole tiny-invariant terminal bootstrap exception; all ordinary exits keep five seconds.
        try await waitExited(stdin, until: stdin.bootstrapDeadline)
        XCTAssertEqual(stdin.process.terminationStatus, 0, stdin.diagnostics.text)
    }

    func testForkReceiptPublicationFailureJoinsChildAndNeverReportsReady() async throws {
        let runtime = try fixture(tag: "fork-receipt-refused")
        let recipe = try forkRecipe()
        try Data("occupied".utf8).write(to: URL(fileURLWithPath: recipe.receipt.path + ".partial"))
        let parent = try start(runtime: runtime, arguments: ["-e", recipe.code], readinessStage: "fork-parent")
        defer { stop(parent) }
        _ = try trackForkChild(parent, runtime: runtime, receipt: recipe.receipt)
        try await waitReady(parent, phase: .forkParent, until: parent.bootstrapDeadline)
        try parent.input.fileHandleForWriting.write(contentsOf: Data("fork\n".utf8))
        try await waitExited(parent)
        parent.process.waitUntilExit()
        try await waitCapturedEOF(parent)
        XCTAssertEqual(parent.process.terminationStatus, 1)
        XCTAssertFalse(parent.capture.ready)
        XCTAssertTrue(parent.diagnostics.text.contains("fixture-stage:fork-child-error"))
        XCTAssertTrue(parent.diagnostics.text.contains("fixture-stage:fork-child-joined"))
        XCTAssertEqual(
            try DesktopRuntimeUsageLease.withReclaimableEpoch(cache: cache, epoch: runtime.lastPathComponent, currentEpoch: String(
                repeating: "0",
                count: 64
            ), operation: { _ in true }),
            true
        )
    }

    func testForkAbortedAfterInitializationBeforeVerificationJoinsWithoutReady() async throws {
        let runtime = try fixture(tag: "fork-before-verify")
        let recipe = try forkRecipe()
        let parent = try start(runtime: runtime, arguments: ["-e", recipe.code], readinessStage: "fork-parent")
        defer { stop(parent) }
        let forked = try trackForkChild(parent, runtime: runtime, receipt: recipe.receipt)
        try await waitReady(parent, phase: .forkParent, until: parent.bootstrapDeadline)
        try parent.input.fileHandleForWriting.write(contentsOf: Data("fork\n".utf8))
        try await waitReady(parent, phase: .forkChild, catalog: forked, until: parent.bootstrapDeadline)
        XCTAssertFalse(parent.capture.ready)
        parent.process.terminate()
        try await waitExited(parent)
        parent.process.waitUntilExit()
        try await waitCapturedEOF(parent)
        try await forked.cleanup(sendExit: {})
        XCTAssertFalse(parent.capture.ready)
        XCTAssertTrue(parent.diagnostics.text.contains("fixture-stage:fork-child-joined"))
        XCTAssertEqual(try DesktopRuntimeUsageLease.withReclaimableEpoch(
            cache: cache, epoch: runtime.lastPathComponent,
            currentEpoch: String(repeating: "0", count: 64), operation: { _ in true }
        ), true)
    }

    func testActualForkChildDisconnectDrainsAfterOwnedParentDeathAndReleasesEpoch() async throws {
        let runtime = try fixture(tag: "fork-disconnect")
        let recipe = try forkRecipe()
        let parent = try start(runtime: runtime, arguments: ["-e", recipe.code], readinessStage: "fork-parent")
        defer { stop(parent) }
        let ownedChild = try trackForkChild(parent, runtime: runtime, receipt: recipe.receipt)
        try await waitReady(parent, phase: .forkParent, until: parent.bootstrapDeadline)
        try parent.input.fileHandleForWriting.write(contentsOf: Data("fork\n".utf8))
        try await waitReady(parent, phase: .forkChild, catalog: ownedChild, until: parent.bootstrapDeadline)
        XCTAssertFalse(parent.capture.ready)
        let verificationDeadline = ContinuousClock.now.advanced(by: .seconds(5))
        try parent.input.fileHandleForWriting.write(contentsOf: Data("verify\n".utf8))
        try await waitReady(parent, until: verificationDeadline)
        try ownedChild.tryAdopt()
        XCTAssertNotNil(ownedChild.identity)
        let current = String(repeating: "0", count: 64)
        XCTAssertNil(try DesktopRuntimeUsageLease.withReclaimableEpoch(
            cache: cache,
            epoch: runtime.lastPathComponent,
            currentEpoch: current,
            operation: { _ in true }
        ))
        try ownedChild.killControllerAfterReady()
        try await waitExited(parent)
        parent.process.waitUntilExit()
        try await ownedChild.cleanup(sendExit: {})
        try await waitCapturedEOF(parent)
        XCTAssertEqual(parent.process.terminationReason, .uncaughtSignal)
        XCTAssertEqual(parent.process.terminationStatus, SIGKILL)
        XCTAssertTrue(parent.diagnostics.text.contains("fixture-stage:fork-child-disconnected"))
        XCTAssertEqual(
            try DesktopRuntimeUsageLease
                .withReclaimableEpoch(cache: cache, epoch: runtime.lastPathComponent, currentEpoch: current, operation: { _ in true }),
            true
        )
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
        try await waitReady(parent, budget: .rawOrphanBootstrap)
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
