// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import CryptoKit
import Darwin
@testable import DesktopCore
import Foundation
import XCTest

final class SnapshotGcLeaseTests: XCTestCase {
    private var home: URL!
    private var runtime: URL!
    private var node: URL!
    private var inputs: URL!
    private var scope: DesktopDataUsageLease.Scope!
    private var id = ""
    private var children: [Process] = []
    private var errorReaders: [FileHandle] = []
    private var startedChildren = Set<ObjectIdentifier>()

    override func setUpWithError() throws {
        home = URL(fileURLWithPath: "/tmp").appendingPathComponent("omnesis-snapshot-gc-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        home = try URL(fileURLWithPath: DesktopCanonicalPath.resolve(home.path))
        inputs = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().appendingPathComponent(".node-fixture")
        node = inputs.appendingPathComponent("node")
        let meta = try XCTUnwrap(JSONSerialization
            .jsonObject(with: Data(contentsOf: inputs.appendingPathComponent("node-fixture.json"))) as? [String: Any])
        XCTAssertEqual(try digest(Data(contentsOf: node)), meta["executableSha256"] as? String)
        let hashes = try XCTUnwrap(meta["privateKeyFiles"] as? [String: String])
        for name in ["gateway-lock.js", "windows-powershell.js", "node-command.js"] {
            XCTAssertEqual(try digest(Data(contentsOf: inputs.appendingPathComponent("private-key/" + name))), hashes[name])
        }
        let config = home.appendingPathComponent("library"), binding = digest(Data(config.path.utf8))
        scope = .init(
            configDir: config.path,
            instance: "desktop-" + String(binding.prefix(16)),
            secretService: "dev.omnesis.desktop." + binding
        )
        for path in [config, URL(fileURLWithPath: config.path + ".bootstrap")] {
            try FileManager.default.createDirectory(at: path, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        }
        try write(
            ["version": 3, "owner": "omnesis-desktop", "instance": scope.instance, "secretService": scope.secretService],
            to: URL(fileURLWithPath: config.path + ".bootstrap/process-authority.json")
        )
        try write([
            "version": 1,
            "owner": "omnesis-desktop",
            "instance": scope.instance,
            "secretService": scope.secretService,
            "phase": "configured",
            "processAuthorityVersion": 3,
        ], to: config.appendingPathComponent("desktop-install.json"))
        id = UUID().uuidString.lowercased()
        try makeRuntime()
        var root = stat()
        XCTAssertEqual(lstat(config.path, &root), 0)
        try write(
            [
                "format": 1,
                "owner": "omnesis-desktop",
                "instance": scope.instance,
                "secretService": scope.secretService,
                "root": ["device": String(root.st_dev), "inode": String(root.st_ino)],
                "pending": [
                    "operationId": id,
                    "currentEpoch": runtime.lastPathComponent,
                    "oldEpoch": runtime.lastPathComponent,
                    "mode": "redundant-snapshot",
                    "phase": "planned",
                ],
            ],
            to: URL(fileURLWithPath: config.path + ".bootstrap/code-retention.json")
        )
    }

    override func tearDownWithError() throws {
        for child in children where child.isRunning {
            guard kill(child.processIdentifier, SIGKILL) == 0 || errno == ESRCH else {
                throw FixtureFailure.readiness("Owned fixture cleanup signal refused; readers retained")
            }
            let deadline = ContinuousClock.now.advanced(by: .seconds(5))
            while child.isRunning, ContinuousClock.now < deadline {
                usleep(10000)
            }
            guard !child.isRunning else { throw FixtureFailure.readiness("Owned fixture cleanup unconfirmed; readers retained") }
            child.waitUntilExit()
        }
        // Joining an already-exited successful launch is nonblocking. Never wait on
        // an unlaunched Process retained solely for its failed-run reader resources.
        for child in children where startedChildren.contains(ObjectIdentifier(child)) {
            child.waitUntilExit()
        }
        try closeReadersAfterJoin()
        try FileManager.default.removeItem(at: home)
    }

    private func closeReadersAfterJoin() throws {
        guard !children.contains(where: \.isRunning) else {
            throw FixtureFailure.readiness("Owned fixture still running; readers retained")
        }
        var failed = false
        for reader in errorReaders {
            reader.readabilityHandler = nil
            do { try reader.close() } catch { failed = true }
        }
        guard !failed else { throw FixtureFailure.readiness("Owned fixture reader closure unconfirmed") }
        errorReaders.removeAll()
    }

    private func makeRuntime(productionHost: Bool = false) throws {
        var build = Bundle(for: Self.self).bundleURL.deletingLastPathComponent()
        var tool: URL?
        for _ in 0 ..< 5 {
            let candidate = build.appendingPathComponent("OmnesisRuntimeExec")
            if FileManager.default.isExecutableFile(atPath: candidate.path) { tool = candidate
                break
            }
            build.deleteLastPathComponent()
        }
        let cache = home.appendingPathComponent("runtime"), stage = home.appendingPathComponent("stage")
        try FileManager.default.createDirectory(at: cache, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        try FileManager.default.createDirectory(at: stage.appendingPathComponent("packages/core/dist"), withIntermediateDirectories: true)
        try FileManager.default.createDirectory(
            at: stage.appendingPathComponent("packages/cli/dist/desktop"),
            withIntermediateDirectories: true
        )
        try FileManager.default.copyItem(at: XCTUnwrap(tool), to: stage.appendingPathComponent("runtime-exec"))
        try FileManager.default.copyItem(at: node, to: stage.appendingPathComponent("node"))
        try FileManager.default.copyItem(at: inputs.appendingPathComponent("private-key"), to: stage.appendingPathComponent("test-inputs"))
        let preload = "import{writeSync}from'node:fs';if(process.env.OMNESIS_TEST_READY_STAGES==='1')writeSync(2,'fixture-stage:snapshot-preload\\n');import{fileURLToPath}from'node:url';Object.defineProperty(process,'execPath',{value:fileURLToPath(new URL('../../../runtime-exec',import.meta.url)),writable:false,configurable:false});"
        try Data(preload.utf8).write(to: stage.appendingPathComponent("packages/core/dist/managed-runtime-bootstrap.js"))
        let host = """
        import{readFileSync,fstatSync}from'node:fs';import{installManagedRuntimeLauncher,assertManagedDesktopSnapshotGcAuthority,managedRuntimeExecutableInvocation}from'../../../../test-inputs/node-command.js';
        let data=JSON.parse(Buffer.from(process.env.OMNESIS_DESKTOP_DATA_CONTEXT,'base64url'));let root=new URL('../../../../',import.meta.url).pathname.replace(/\\/$/,'');
        installManagedRuntimeLauncher({root,launcher:root+'/runtime-exec',preload:root+'/packages/core/dist/managed-runtime-bootstrap.js',data});
        assertManagedDesktopSnapshotGcAuthority(data.scope,process.argv[3]);
        try{managedRuntimeExecutableInvocation('/bin/ps',[]);process.exit(93)}catch{}
        process.stdout.write('performed:'+process.pid+'\\n');process.stdin.resume();process.stdin.once('data',()=>process.exit(0));
        """
        try Data(host.utf8).write(to: stage.appendingPathComponent("packages/cli/dist/desktop/snapshot-retention-host.js"))
        if productionHost {
            for name in ["managed-runtime-bootstrap.js", "node-command.js"] {
                let path = stage.appendingPathComponent("packages/core/dist/" + name)
                if FileManager.default.fileExists(atPath: path.path) { try FileManager.default.removeItem(at: path) }
                try FileManager.default.copyItem(at: inputs.appendingPathComponent("private-key/" + name), to: path)
            }
            for name in [
                "environment",
                "generation",
                "fresh-install-errors",
                "data-operation-frame",
                "snapshot-retention-errors",
                "snapshot-retention-host",
                "snapshot-retention-delete",
                "snapshot-retention-record",
                "snapshot-retention-witness",
                "snapshot-owner",
            ] {
                let path = stage.appendingPathComponent("packages/cli/dist/desktop/" + name + ".js")
                if FileManager.default.fileExists(atPath: path.path) { try FileManager.default.removeItem(at: path) }
                try FileManager.default.copyItem(at: inputs.appendingPathComponent("private-key/" + name + ".js"), to: path)
            }
            try write(
                ["type": "module", "exports": ["./node-command": "./dist/node-command.js"]],
                to: stage.appendingPathComponent("packages/core/package.json")
            )
            let modules = stage.appendingPathComponent("node_modules/@omnesis")
            try FileManager.default.createDirectory(at: modules, withIntermediateDirectories: true)
            try FileManager.default.createSymbolicLink(
                atPath: modules.appendingPathComponent("core").path,
                withDestinationPath: "../../packages/core"
            )
        }
        let manifest: [String: Any] = [
            "format": 1,
            "codeUsageProtocol": 1,
            "dataUsageProtocol": 1,
            "processAuthorityProtocol": 3,
            "fixture": productionHost ? "production-phase-two" : "authority-boundary",
            "runtimeLauncher": "runtime-exec",
            "inventory": [["path": "node", "executable": true], ["path": "runtime-exec", "executable": true]],
        ]
        let bytes = try JSONSerialization.data(withJSONObject: manifest, options: [.sortedKeys])
        try bytes.write(to: stage.appendingPathComponent("desktop-runtime.json"))
        runtime = cache.appendingPathComponent(digest(bytes))
        try FileManager.default.moveItem(at: stage, to: runtime)
    }

    private struct Running { let process: Process
        let input: Pipe
        let output: Pipe
        let errors: Pipe
        let diagnostics: Capture
    }

    private final class Capture: @unchecked Sendable {
        private let lock = NSLock()
        private var value = ""
        func append(_ bytes: Data) {
            lock.lock()
            defer { lock.unlock() }
            value = String((value + String(decoding: bytes, as: UTF8.self)).suffix(8192))
        }

        var text: String {
            lock.lock()
            defer { lock.unlock() }
            return value
        }
    }

    private enum FixtureFailure: Error { case readiness(String), unexpectedFixedReply }

    private func start(_ executable: URL, _ args: [String]) throws -> Running {
        guard errorReaders.count < 16 else { throw FixtureFailure.readiness("Owned fixture reader bound") }
        let process = Process(), input = Pipe(), output = Pipe(), errors = Pipe(), diagnostics = Capture()
        // Register before launch: a failed run still owns a live reader callback and pipes.
        errorReaders.append(errors.fileHandleForReading)
        children.append(process)
        guard fcntl(input.fileHandleForWriting.fileDescriptor, F_SETNOSIGPIPE, 1) == 0 else {
            throw FixtureFailure.readiness("Owned fixture input setup refused")
        }
        process.environment = ProcessInfo.processInfo.environment.merging([
            "OMNESIS_TEST_READY_STAGES": "1",
            "OMNESIS_RUNTIME_MODE": "test",
            "OMNESIS_TELEMETRY": "0",
            "OMNESIS_E2E_NATIVE_SNAPSHOT": "1",
        ]) { _, value in value }
        errors.fileHandleForReading.readabilityHandler = { diagnostics.append($0.availableData) }
        process.executableURL = executable
        process.arguments = args
        process.standardInput = input
        process.standardOutput = output
        process.standardError = errors
        try process.run()
        startedChildren.insert(ObjectIdentifier(process))
        return Running(process: process, input: input, output: output, errors: errors, diagnostics: diagnostics)
    }

    private func phaseOne(prepare: String = "") throws -> Running {
        let lock = runtime.appendingPathComponent("test-inputs/gateway-lock.js").absoluteString
        let encoded = try encodedScope()
        let script = """
        import{acquireGatewayLock}from\(literal(lock));import{spawnSync}from'node:child_process';
        function stage(name){process.stderr.write('fixture-stage:'+name+'\\n');}
        stage('phase-one-enter');stage('install-lock-before');
        await acquireGatewayLock(\(literal(scope.configDir + ".bootstrap")),{waitMs:0});
        stage('install-lock-held');stage('prepare-before');
        \(prepare)
        stage('prepare-after');stage('reserve-before');
        let result=spawnSync(process.execPath,['--gc-reserve',\(literal(
            id
        )),\(literal(encoded))],{env:process.env,stdio:['ignore','ignore','pipe']});
        stage('reserve-after');
        if(result.status!==0){process.stderr.write(result.stderr);process.exit(94)}
        process.stdout.write('reserved\\n');process.stdin.resume();process.stdin.once('data',()=>process.execve(process.execPath,[process.execPath,'--gc-snapshot',\(
            literal(id)
        ),\(literal(encoded))],process.env));
        """
        return try start(
            runtime.appendingPathComponent("runtime-exec"),
            ["--data-use", encodedScope(), "--node", "--input-type=module", "-e", script]
        )
    }

    private func competitor() throws -> Running {
        let script = """
        import{acquireGatewayLock}from\(literal(runtime.appendingPathComponent("test-inputs/gateway-lock.js").absoluteString));
        process.stdin.resume();process.stdin.once('data',async()=>{try{let lease=await acquireGatewayLock(\(literal(scope
                .configDir +
                ".bootstrap")),{waitMs:0});lease.release();process.exit(91)}catch{process.exit(0)}});process.stdout.write('competitor\\n');
        """
        return try start(node, ["--input-type=module", "-e", script])
    }

    private func line(_ running: Running) throws -> String {
        let deadline = Date().addingTimeInterval(10), fd = running.output.fileHandleForReading.fileDescriptor
        var bytes = Data()
        while Date() < deadline {
            var event = pollfd(fd: fd, events: Int16(POLLIN), revents: 0)
            if Darwin.poll(&event, 1, 50) > 0 {
                var byte: UInt8 = 0
                if Darwin.read(fd, &byte, 1) != 1 { break }
                if byte == 10 { return String(decoding: bytes, as: UTF8.self) }
                bytes.append(byte)
                if bytes.count > 4096 { break }
            }
        }
        throw FixtureFailure.readiness(readinessDiagnostics(running, partialBytes: bytes.count))
    }

    private func requireLine(_ running: Running, _ expected: String) throws {
        guard try line(running) == expected else { throw FixtureFailure.unexpectedFixedReply }
    }

    private func readinessDiagnostics(_ running: Running, partialBytes: Int) -> String {
        var path = [CChar](repeating: 0, count: 4096)
        let known = proc_pidpath(running.process.processIdentifier, &path, UInt32(path.count)) > 0
        let actual = known ? String(cString: path) : ""
        let image = actual == runtime.appendingPathComponent("node").path ? "node" : actual == runtime
            .appendingPathComponent("runtime-exec").path ? "runtime-exec" : known ? "other" : "unavailable"
        let allowed: Set = [
            "snapshot-preload",
            "phase-one-enter",
            "install-lock-before",
            "install-lock-held",
            "prepare-before",
            "prepare-after",
            "reserve-before",
            "reserve-after",
        ]
        let text = running.diagnostics.text
        let stages = text.split(separator: "\n").compactMap { line -> String? in
            let prefix = "fixture-stage:"
            guard line.hasPrefix(prefix) else { return nil }
            let value = String(line.dropFirst(prefix.count))
            return allowed.contains(value) ? value : nil
        }.suffix(16).joined(separator: ",")
        let state = running.process.isRunning ? "running" : "exited"
        let code = running.process.isRunning ? "unknown" : String(running.process.terminationStatus)
        return "Snapshot reserved-line readiness absent; process=\(state); exit=\(code); image=\(image); stdoutPartialBytes=\(partialBytes); stderrBytes=\(text.utf8.count); stages=\(stages); nativeCode=\(DesktopReadinessFailureDiagnostic.nativeRefusalCode(text))"
    }

    private func exited(_ child: Process) throws {
        let deadline = Date().addingTimeInterval(10)
        while child.isRunning, Date() < deadline {
            usleep(10000)
        }
        guard !child.isRunning else {
            kill(child.processIdentifier, SIGKILL)
            child.waitUntilExit()
            throw FixtureFailure.readiness("Owned fixture exit deadline")
        }
    }

    func testFailedLaunchReaderIsRetainedUntilOwnedCleanup() throws {
        XCTAssertThrowsError(try start(home.appendingPathComponent("invented-absent-tool"), []))
        let reader = try XCTUnwrap(errorReaders.last)
        let descriptor = reader.fileDescriptor
        XCTAssertNotNil(reader.readabilityHandler)
        XCTAssertGreaterThanOrEqual(fcntl(descriptor, F_GETFD), 0)
        try closeReadersAfterJoin()
        XCTAssertNil(reader.readabilityHandler)
        let closed = fcntl(descriptor, F_GETFD), closedErrno = errno
        XCTAssertEqual(closed, -1)
        XCTAssertEqual(closedErrno, EBADF)
    }

    func testLiveChildReaderCannotCloseBeforeActualEOFAndJoin() throws {
        let child = try start(URL(fileURLWithPath: "/bin/cat"), [])
        let reader = try XCTUnwrap(errorReaders.last)
        XCTAssertThrowsError(try closeReadersAfterJoin())
        XCTAssertNotNil(reader.readabilityHandler)
        try child.input.fileHandleForWriting.close()
        try exited(child.process)
        child.process.waitUntilExit()
        try closeReadersAfterJoin()
        XCTAssertNil(reader.readabilityHandler)
    }

    func testRequiredLineRejectsUnknownReplyBeforeContinuation() throws {
        let child = try start(node, ["-e", "process.stdout.write('not-reserved\\n');"])
        var continued = false
        XCTAssertThrowsError(try {
            try requireLine(child, "reserved")
            continued = true
        }())
        XCTAssertFalse(continued)
        try exited(child.process)
    }

    func testActualExecveRetainsInstallOwnershipAndReestablishesExclusivePublication() throws {
        let competing = try competitor()
        try requireLine(competing, "competitor")
        let owner = try phaseOne()
        try requireLine(owner, "reserved")
        let pid = owner.process.processIdentifier
        try owner.input.fileHandleForWriting.write(contentsOf: Data("go".utf8))
        try requireLine(owner, "performed:" + String(pid))
        try competing.input.fileHandleForWriting.write(contentsOf: Data("try".utf8))
        try exited(competing.process)
        XCTAssertEqual(
            competing.process.terminationStatus,
            0,
            "A real competing acquireGatewayLock must refuse while the same-PID host owns publication EX"
        )
        let publication = try DesktopSnapshotGcRecords
            .openPrivate(runtime.deletingLastPathComponent().appendingPathComponent(".publication-lock"))
        defer { Darwin.close(publication) }
        XCTAssertNotEqual(flock(publication, LOCK_EX | LOCK_NB), 0)
        XCTAssertFalse(FileManager.default
            .fileExists(atPath: runtime.deletingLastPathComponent().appendingPathComponent(".snapshot-reservations/" + id + ".json").path))
        try owner.input.fileHandleForWriting.write(contentsOf: Data("exit".utf8))
        try exited(owner.process)
        XCTAssertEqual(owner.process.terminationStatus, 0)
        XCTAssertEqual(flock(publication, LOCK_EX | LOCK_NB), 0)
    }

    func testOrphanReservationBlocksBothCodeCleanupPathsWithoutExpiry() throws {
        let owner = try phaseOne()
        try requireLine(owner, "reserved")
        kill(owner.process.processIdentifier, SIGKILL)
        owner.process.waitUntilExit()
        let cache = runtime.deletingLastPathComponent()
        XCTAssertTrue(DesktopSnapshotGcLease.blocksReclamation(cache: cache, epoch: runtime.lastPathComponent))
        XCTAssertNil(try DesktopRuntimeUsageLease.withReclaimableEpoch(
            cache: cache,
            epoch: runtime.lastPathComponent,
            currentEpoch: String(repeating: "0", count: 64),
            operation: { _ in true }
        ))
        XCTAssertFalse(try DesktopRuntimeUsageLease.removeReclaimableRuntime(
            cache: cache,
            epoch: runtime.lastPathComponent,
            currentEpoch: String(repeating: "0", count: 64)
        ))
        XCTAssertTrue(FileManager.default.fileExists(atPath: runtime.path))
    }

    func testKnownOrphanReservationCanBeRetriedOnlyUnderTheNewActualInstallOwner() throws {
        let original = try phaseOne()
        try requireLine(original, "reserved")
        kill(original.process.processIdentifier, SIGKILL)
        try exited(original.process)
        let resumed = try phaseOne()
        try requireLine(resumed, "reserved")
        let path = runtime.deletingLastPathComponent().appendingPathComponent(".snapshot-reservations/" + id + ".json")
        let (_, value) = try DesktopSnapshotGcRecords.read(path)
        XCTAssertEqual((value["pid"] as? NSNumber)?.int32Value, resumed.process.processIdentifier)
        try resumed.input.fileHandleForWriting.write(contentsOf: Data("go".utf8))
        try requireLine(resumed, "performed:" + String(resumed.process.processIdentifier))
        try resumed.input.fileHandleForWriting.write(contentsOf: Data("exit".utf8))
        try exited(resumed.process)
        XCTAssertEqual(resumed.process.terminationStatus, 0)
    }

    func testExplicitCancellationReleasesOnlyTheKnownReservationBeforeItsPlannedIntentDisappears() throws {
        let original = try phaseOne()
        try requireLine(original, "reserved")
        kill(original.process.processIdentifier, SIGKILL)
        try exited(original.process)
        let lock = runtime.appendingPathComponent("test-inputs/gateway-lock.js").absoluteString
        let encoded = try encodedScope()
        let script = """
        import{acquireGatewayLock}from\(literal(lock));import{spawnSync}from'node:child_process';
        await acquireGatewayLock(\(literal(scope.configDir + ".bootstrap")),{waitMs:0});
        let result=spawnSync(process.execPath,['--gc-reserve-cancel',\(literal(
            id
        )),\(literal(encoded))],{env:process.env,stdio:['ignore','ignore','pipe']});
        if(result.status!==0){process.stderr.write(result.stderr);process.exit(95)}process.stdout.write('cancelled\\n');
        """
        let cancellation = try start(runtime.appendingPathComponent("runtime-exec"), [
            "--data-use",
            encoded,
            "--node",
            "--input-type=module",
            "-e",
            script,
        ])
        try requireLine(cancellation, "cancelled")
        try exited(cancellation.process)
        XCTAssertEqual(cancellation.process.terminationStatus, 0)
        let cache = runtime.deletingLastPathComponent()
        XCTAssertFalse(DesktopSnapshotGcLease.blocksReclamation(cache: cache, epoch: runtime.lastPathComponent))
        let (_, ledger) = try DesktopSnapshotGcRecords.read(URL(fileURLWithPath: scope.configDir + ".bootstrap/code-retention.json"))
        XCTAssertEqual((ledger["pending"] as? [String: Any])?["phase"] as? String, "planned")
        XCTAssertNotNil(try DesktopRuntimeUsageLease.withReclaimableEpoch(
            cache: cache,
            epoch: runtime.lastPathComponent,
            currentEpoch: String(repeating: "0", count: 64),
            operation: { _ in true }
        ))
    }

    func testChangedLedgerRefusesNativeHandoffWithoutConsumingReservation() throws {
        let owner = try phaseOne()
        try requireLine(owner, "reserved")
        let path = URL(fileURLWithPath: scope.configDir + ".bootstrap/code-retention.json")
        var ledger = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: path)) as? [String: Any])
        var pending = try XCTUnwrap(ledger["pending"] as? [String: Any])
        pending["phase"] = "deleting"
        ledger["pending"] = pending
        try write(ledger, to: path)
        try owner.input.fileHandleForWriting.write(contentsOf: Data("go".utf8))
        try exited(owner.process)
        XCTAssertEqual(owner.process.terminationStatus, 78)
        XCTAssertTrue(DesktopSnapshotGcLease.blocksReclamation(
            cache: runtime.deletingLastPathComponent(),
            epoch: runtime.lastPathComponent
        ))
        XCTAssertTrue(FileManager.default.fileExists(atPath: scope.configDir))
    }

    func testMalformedGlobalReservationNeverGrantsCodeReclamation() throws {
        let cache = runtime.deletingLastPathComponent(), folder = DesktopSnapshotGcLease.directory(cache: cache)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let path = folder.appendingPathComponent(id + ".json")
        try Data("{\"format\":1}".utf8).write(to: path)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: path.path)
        XCTAssertTrue(DesktopSnapshotGcLease.blocksReclamation(cache: cache, epoch: runtime.lastPathComponent))
        XCTAssertFalse(try DesktopRuntimeUsageLease.removeReclaimableRuntime(
            cache: cache,
            epoch: runtime.lastPathComponent,
            currentEpoch: String(repeating: "0", count: 64)
        ))
    }

    func testFixedNativeHostRunsProductionDeletionAndRetainsTheVerifiedKeeper() throws {
        try makeRuntime(productionHost: true)
        let ledgerPath = URL(fileURLWithPath: scope.configDir + ".bootstrap/code-retention.json")
        try FileManager.default.removeItem(at: ledgerPath)
        let target = UUID().uuidString.lowercased(), keeper = UUID().uuidString.lowercased()
        let recordModule = runtime.appendingPathComponent("test-inputs/snapshot-retention-record.js").absoluteString
        let witnessModule = runtime.appendingPathComponent("test-inputs/snapshot-retention-witness.js").absoluteString
        let prepare = try """
        const{mkdir,writeFile,stat}=await import('node:fs/promises');
        const{captureDesktopSnapshotWitness}=await import(\(literal(witnessModule)));
        const{writeDesktopSnapshotRetention}=await import(\(literal(recordModule)));
        const profile=JSON.parse(Buffer.from(\(literal(encodedScope())),'base64url'));
        const rootStat=await stat(profile.configDir,{bigint:true});const root={device:String(rootStat.dev),inode:String(rootStat.ino)};
        const rows=[], witnesses=[];
        for(const[id,order]of[[\(literal(target)),1],[\(literal(keeper)),2]]){
          const path=profile.configDir+'/backups/desktop-update-'+id;await mkdir(path,{recursive:true,mode:0o700});
          await writeFile(path+'/snapshot.json',JSON.stringify({fixture:'invented sealed copy'}),{mode:0o600});
          await writeFile(path+'/sealed.enc',Buffer.alloc(32,29),{mode:0o600});
          const witness=await captureDesktopSnapshotWitness(profile,id,false,'manifest',AbortSignal.timeout(5000));witnesses.push(witness);
          rows.push({operationId:id,oldEpoch:\(literal(runtime
                  .lastPathComponent)),purpose:'update',oldVersion:'1.2.3',registeredAt:'2030-01-01T00:00:00.000Z',manifestSha256:witness.inventory.sha256,bytes:32,directory:witness.directory,order,pinned:false});
        }
        await writeDesktopSnapshotRetention(profile,{format:1,owner:'omnesis-desktop',instance:profile.instance,secretService:profile.secretService,root,sequence:2,records:rows,pending:{operationId:\(
            literal(id)
        ),snapshotId:\(literal(target)),journals:{updateId:\(literal(keeper)),restoreId:null},currentEpoch:\(literal(runtime
                .lastPathComponent)),oldEpoch:\(literal(runtime
                .lastPathComponent)),mode:'redundant-snapshot',phase:'planned',target:witnesses[0],keeper:witnesses[1]}});
        """
        let owner = try phaseOne(prepare: prepare)
        try requireLine(owner, "reserved")
        try owner.input.fileHandleForWriting.write(contentsOf: Data("go".utf8))
        try exited(owner.process)
        let output = try owner.output.fileHandleForReading.readToEnd() ?? Data()
        let diagnostic = "nativeCode=" + DesktopReadinessFailureDiagnostic.nativeRefusalCode(owner.diagnostics.text)
        XCTAssertEqual(
            owner.process.terminationStatus,
            0,
            diagnostic
        )
        let reply = try XCTUnwrap(JSONSerialization.jsonObject(with: output) as? [String: Any])
        XCTAssertEqual(reply["ok"] as? Bool, true)
        let result = try XCTUnwrap(reply["result"] as? [String: Any])
        XCTAssertEqual(result["status"] as? String, "removed")
        XCTAssertEqual(result["snapshotId"] as? String, target)
        XCTAssertEqual(result["bytes"] as? Int, 32)
        XCTAssertFalse(FileManager.default.fileExists(atPath: scope.configDir + "/backups/desktop-update-" + target))
        XCTAssertTrue(FileManager.default.fileExists(atPath: scope.configDir + "/backups/desktop-update-" + keeper + "/sealed.enc"))
        let ledger = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: ledgerPath)) as? [String: Any])
        XCTAssertTrue(ledger["pending"] is NSNull)
        XCTAssertEqual((ledger["records"] as? [[String: Any]])?.count, 1)
    }

    private func write(_ value: [String: Any], to path: URL) throws {
        try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]).write(to: path)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: path.path)
    }

    private func digest(_ bytes: Data) -> String {
        SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
    }

    private func literal(_ value: String) -> String {
        String(data: try! JSONEncoder().encode(value), encoding: .utf8)!
    }

    private func encodedScope() throws -> String {
        try JSONEncoder().encode(scope!).base64EncodedString().replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }
}
