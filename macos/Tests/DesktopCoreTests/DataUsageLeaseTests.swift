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
    private var fixtureNode: URL!
    private var catalogChildren: [(CatalogFixtureChild, String)] = []
    private var uncertainChildRegistration = false
    private var setupMilliseconds = 0

    override func setUpWithError() throws {
        // macOS per-user temporary paths can exceed sockaddr_un.sun_path with a fixture suffix.
        home = URL(fileURLWithPath: "/tmp", isDirectory: true).appendingPathComponent("omnesis-data-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        home = try URL(fileURLWithPath: DesktopCanonicalPath.resolve(home.path), isDirectory: true)
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
        try write(
            ["version": 3, "owner": "omnesis-desktop", "instance": scope.instance, "secretService": scope.secretService],
            to: URL(fileURLWithPath: scope.configDir + ".bootstrap/process-authority.json")
        )
        try write([
            "version": 1,
            "owner": "omnesis-desktop",
            "instance": scope.instance,
            "secretService": scope.secretService,
            "phase": "configured",
            "processAuthorityVersion": 3,
        ], to: config.appendingPathComponent("desktop-install.json"))
    }

    override func tearDown() async throws {
        guard !uncertainChildRegistration else {
            XCTFail("Child ownership registration is uncertain; the owned fixture was retained")
            throw TestFailure.fixture
        }
        var physicallyDrained = Set<String>()
        for (child, socket) in catalogChildren {
            do {
                try await child.cleanup { try self.sendExit(socket) }
                physicallyDrained.insert(socket)
            } catch {
                XCTFail("Catalog child drain is uncertain; the owned fixture was retained")
                throw error
            }
        }
        let untrackedSockets = sockets.filter { !physicallyDrained.contains($0) }
        for path in untrackedSockets {
            try? sendExit(path)
        }
        for process in processes where process.isRunning {
            kill(process.processIdentifier, SIGKILL)
            process.waitUntilExit()
        }
        // Untracked commands still use their socket as the legacy exit acknowledgement.
        // Tracked children have stronger physical join/incarnation-gone proof above; TERM can
        // leave their owned Unix entry, which the private home removal retires afterward.
        let deadline = Date().addingTimeInterval(5)
        while untrackedSockets.contains(where: { FileManager.default.fileExists(atPath: $0) }), Date() < deadline {
            usleep(10000)
        }
        for path in untrackedSockets {
            XCTAssertFalse(FileManager.default.fileExists(atPath: path), "Owned data-use child did not drain")
        }
        try FileManager.default.removeItem(at: home)
    }

    func testReadinessTimingKeepsOnlyBoundedFixedRelativePhases() {
        let capture = Capture()
        capture
            .append(
                Data(
                    "fixture-stage:catalog-child-enter\nfixture-uptime:catalog-child-enter:12\nfixture-uptime:unknown:77\nfixture-stage:unknown\nfixture-uptime:catalog-listening:60001\nfixture-stage:catalog-listening\n"
                        .utf8
                )
            )
        XCTAssertTrue(capture.timingSummary.contains("catalog-child-enter:emitted=12,arrived="))
        XCTAssertTrue(capture.timingSummary.contains("catalog-listening:emitted=unknown,arrived="))
        XCTAssertFalse(capture.timingSummary.contains("60001"))
        XCTAssertFalse(capture.timingSummary.contains("unknown:emitted"))
    }

    func testKilledGatewayDoesNotReleaseItsRawSdkDescendantsDataLease() async throws {
        try makeRuntime(host: "process.stdout.write('ready');process.stdin.resume();")
        let socket = home.appendingPathComponent("consumer.sock").path
        sockets.append(socket)
        let receipt = home.appendingPathComponent("consumer-child.json")
        let script = try CatalogFixtureChild.script(
            command: nil,
            arguments: ["--node", "-e", socketCommand(socket, catalogStages: true)],
            receipt: receipt,
            socket: socket
        )
        let gateway = try start(["--data-use", encodedScope(), "--node", "-e", script])
        let child = try trackChild(gateway, receipt: receipt, socket: socket)
        try await waitReady(gateway, catalog: child)
        try retire()
        try child.killControllerAfterReady()
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
        let args = try [
            "--data-inherit",
            "erase",
            XCTUnwrap(operationId),
            encodedScope(),
            "--node",
            "-e",
            socketCommand(socket, catalogStages: true),
        ]
        let receipt = home.appendingPathComponent("operation-child.json")
        let script = try CatalogFixtureChild.script(
            command: nil,
            arguments: args,
            receipt: receipt,
            socket: socket,
            inheritDataDescriptor: true
        )
        try makeRuntime(host: script)
        try retire()
        let operation = try start(exclusiveArguments())
        let child = try trackChild(operation, receipt: receipt, socket: socket)
        try await waitReady(operation, catalog: child)
        try child.killControllerAfterReady()
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

    func testSharedDataDescriptorCannotScrubEnvironmentAndEnterBackgroundControl() async throws {
        let script = scrubbedBackgroundModesScript()
        try makeRuntime(host: script)
        let consumer = try start(["--data-use", encodedScope(), "--node", "-e", script], readinessStage: "shared-scrub")
        try await waitReady(consumer)
    }

    func testExclusiveDataDescriptorCannotScrubEnvironmentAndEnterBackgroundControl() async throws {
        try makeRuntime(host: scrubbedBackgroundModesScript())
        try retire()
        let operation = try start(exclusiveArguments())
        try await waitReady(operation)
    }

    private func scrubbedBackgroundModesScript() -> String {
        """
        import {spawnSync} from 'node:child_process';
        import {fstatSync} from 'node:fs';
        process.stderr.write('fixture-stage:scrub-enter\\n');
        if (!fstatSync(7).isFile()) throw new Error('Owned DATA descriptor was not installed');
        for (const mode of ['--key-recovery','--background-start','--background-daemon','--background-retire','--verify-background-owner','--verify-background-retirement','--background-binding','--background-rebind']) {
          process.stderr.write('fixture-stage:scrub-before-'+mode+'\\n');
          const child=spawnSync(process.execPath,[mode,'invalid'],{env:{},stdio:['ignore','pipe','pipe','ignore','ignore','ignore','ignore',7],timeout:3000});
          if (child.status!==78 || !child.stderr.toString().includes('missingAuthority') || child.stdout.length!==0) throw new Error('DATA control boundary refusal missing');
          process.stderr.write('fixture-stage:scrub-after-'+mode+'\\n');
        }
        process.stderr.write('fixture-stage:scrub-complete\\n');
        process.stdout.write('ready');process.stdin.resume();
        """
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
        try makeRuntime(
            host: "process.stderr.write('fixture-stage:exclusive-host-enter\\n');process.stdout.write('ready',()=>process.stderr.write('fixture-stage:exclusive-ready-written\\n'));process.stdin.resume();"
        )
        let controller = try start(
            ["--node", runtime.appendingPathComponent("packages/cli/dist/index.js").path, "desktop", "bridge"],
            readinessStage: "erase-controller"
        )
        try await waitReady(controller)
        try retire()
        let operation = try start(exclusiveArguments(), readinessStage: "erase-exclusive")
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
        defer { withExtendedLifetime(lease) {} }
        XCTAssertThrowsError(try DesktopDataUsageLease.acquire(
            scope: scope, epoch: String(repeating: "a", count: 64), purpose: .erase, operationId: operationId
        ))
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

    func testCatalogDiscoveryWitnessAndExclusiveLeaseRejectConcurrentWriters() throws {
        let cache = try catalogCache()
        let bytes = Data("{\"fixture\":true}".utf8)
        try bytes.write(to: cache)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: cache.path)
        let epoch = String(repeating: "a", count: 64), nonce = UUID().uuidString.lowercased()
        let data = try DesktopDataUsageLease.acquire(scope: scope, epoch: epoch)
        let catalog = try data.acquireCatalogDiscovery(nonce: nonce, epoch: epoch)
        let receipt = try catalogReceipt()
        XCTAssertEqual(receipt["nonce"] as? String, nonce)
        XCTAssertEqual(receipt["previousSha256"] as? String, hash(bytes))
        defer { withExtendedLifetime(catalog) {} }
        XCTAssertThrowsError(try data.acquireCatalogDiscovery(nonce: UUID().uuidString.lowercased(), epoch: epoch))
    }

    func testKilledDiscoveryControllerCannotReleaseSdkCatalogWriterOrDeleteItsWitness() async throws {
        try makeRuntime(host: "process.stdout.write('ready');process.stdin.resume();")
        _ = try catalogCache()
        let socket = home.appendingPathComponent("catalog.sock").path
        sockets.append(socket)
        let nonce = UUID().uuidString.lowercased()
        let args = try [
            "--catalog-discovery",
            nonce,
            "--data-use",
            encodedScope(),
            "--external",
            XCTUnwrap(fixtureNode).path,
            "-e",
            socketCommand(socket, catalogStages: true),
        ]
        let receipt = home.appendingPathComponent("catalog-child.json")
        let script = try CatalogFixtureChild.script(
            command: runtime.appendingPathComponent("runtime-exec").path,
            arguments: args, receipt: receipt, socket: socket
        )
        let controller = try start(["--data-use", encodedScope(), "--node", "-e", script], readinessStage: "catalog-controller")
        let child = try trackChild(controller, receipt: receipt, socket: socket, externalNode: fixtureNode)
        try await waitReady(controller, catalog: child)
        let witness = try catalogReceipt()
        try child.killControllerAfterReady()
        try await waitExited(controller)
        let denied = try start([
            "--catalog-discovery",
            UUID().uuidString.lowercased(),
            "--data-use",
            encodedScope(),
            "--external",
            fixtureNode.path,
            "-e",
            "process.stdout.write('must-not-execute')",
        ])
        try await waitExited(denied)
        XCTAssertEqual(denied.process.terminationStatus, 78, denied.diagnostics.text)
        XCTAssertTrue(denied.diagnostics.text.contains("inUse"), denied.diagnostics.text)
        XCTAssertEqual(try catalogReceipt()["nonce"] as? String, witness["nonce"] as? String)
        XCTAssertFalse(denied.capture.text.contains("must-not-execute"))
        try sendExit(socket)
        try await waitAbsent(socket)
    }

    func testActualPinnedNativeSdkRetainsBothDataAndCatalogAuthority() async throws {
        try makeRuntime(host: "process.stdout.write('ready');process.stdin.resume();")
        let cache = try catalogCache()
        let fixture = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().appendingPathComponent(".codex-keychain-fixture", isDirectory: true)
        let metadata = try XCTUnwrap(JSONSerialization
            .jsonObject(with: Data(contentsOf: fixture.appendingPathComponent("codex-fixture.json"))) as? [String: Any])
        let qualifiedPolicy = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: fixture.deletingLastPathComponent()
                .appendingPathComponent(".codex-backend-fixture/backend-fixture.json"))) as? [String: Any])
        guard qualifiedPolicy["owner"] as? String == "omnesis-desktop-codex-backend-test-fixture",
              let qualified = qualifiedPolicy["qualifiedRuntimeVersion"] as? String,
              metadata["owner"] as? String == "omnesis-desktop-codex-keychain-test-fixture",
              metadata["version"] as? String == qualified else { throw TestFailure.fixture }
        let binary = fixture.appendingPathComponent("codex"), handle = try FileHandle(forReadingFrom: binary)
        var digest = SHA256()
        while let bytes = try handle.read(upToCount: 1024 * 1024), !bytes.isEmpty {
            digest.update(data: bytes)
        }
        try handle.close()
        guard digest.finalize().map({ String(format: "%02x", $0) }).joined() == metadata["executableSha256"] as? String
        else { throw TestFailure.fixture }
        let policy = [
            "cli_auth_credentials_store=\"keyring\"", "features.shell_tool=false", "features.shell_snapshot=false",
            "features.hooks=false", "features.plugins=false", "mcp_servers={}", "notify=[]", "allow_login_shell=false",
            "project_doc_max_bytes=0", "history.persistence=\"none\"", "web_search=\"disabled\"", "features.memories=false",
            "analytics.enabled=false", "otel.log_user_prompt=false", "otel.log_agent_responses=false", "otel.log_sse_deltas=false",
            "otel.exporter=\"none\"", "otel.trace_exporter=\"none\"", "otel.metrics_exporter=\"none\"",
        ]
        let args = try [
            "--catalog-discovery",
            UUID().uuidString.lowercased(),
            "--data-use",
            encodedScope(),
            "--external",
            binary.path,
            "app-server",
            "--listen",
            "stdio://",
        ] + policy.flatMap { ["-c", $0] }
        let workspace = home.appendingPathComponent("sdk-workspace", isDirectory: true)
        try FileManager.default.createDirectory(at: workspace, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let sdk = try start(args, environment: [
            "HOME": home.path,
            "CODEX_HOME": cache.deletingLastPathComponent().path,
            "TMPDIR": home.path,
            "HTTP_PROXY": "http://127.0.0.1:9",
            "HTTPS_PROXY": "http://127.0.0.1:9",
            "RUST_LOG": "off",
        ], workingDirectory: workspace)
        try sdk.input.fileHandleForWriting
            .write(
                contentsOf: Data(
                    "{\"id\":1,\"method\":\"initialize\",\"params\":{\"clientInfo\":{\"name\":\"omnesis-fixture\",\"version\":\"1\"},\"capabilities\":{\"experimentalApi\":true}}}\n"
                        .utf8
                )
            )
        let deadline = Date().addingTimeInterval(10)
        while !sdk.capture.text.contains("\"id\":1"), !sdk.capture.text.contains("\"id\": 1"), sdk.process.isRunning, Date() < deadline {
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTAssertTrue(sdk.capture.text.contains("\"id\":1") || sdk.capture.text.contains("\"id\": 1"), sdk.diagnostics.text)
        let initialized = sdk.capture.text.split(separator: "\n").compactMap { line in
            (try? JSONSerialization.jsonObject(with: Data(line.utf8))) as? [String: Any]
        }.first { $0["id"] as? Int == 1 }
        guard initialized?["result"] != nil, initialized?["error"] == nil else {
            throw TestFailure.diagnostics("SDK initialize failed: " + sdk.diagnostics.text + sdk.capture.text)
        }
        try sdk.input.fileHandleForWriting
            .write(
                contentsOf: Data(
                    "{\"method\":\"initialized\",\"params\":{}}\n{\"id\":2,\"method\":\"model/list\",\"params\":{\"limit\":1,\"includeHidden\":false}}\n"
                        .utf8
                )
            )
        let modelsDeadline = Date().addingTimeInterval(10)
        while !sdk.capture.text.contains("\"id\":2"), !sdk.capture.text.contains("\"id\": 2"), sdk.process.isRunning,
              Date() < modelsDeadline {
            try await Task.sleep(for: .milliseconds(10))
        }
        let models = sdk.capture.text.split(separator: "\n").compactMap { line in
            (try? JSONSerialization.jsonObject(with: Data(line.utf8))) as? [String: Any]
        }.first { $0["id"] as? Int == 2 }
        XCTAssertNotNil(models?["result"], sdk.diagnostics.text)
        XCTAssertNil(models?["error"])
        let competing = try start([
            "--catalog-discovery",
            UUID().uuidString.lowercased(),
            "--data-use",
            encodedScope(),
            "--external",
            fixtureNode.path,
            "-e",
            "process.stdout.write('must-not-execute')",
        ])
        try await waitExited(competing)
        XCTAssertEqual(competing.process.terminationStatus, 78, competing.diagnostics.text)
        XCTAssertTrue(competing.diagnostics.text.contains("inUse"), competing.diagnostics.text)
        try retire()
        let erase = try start(exclusiveArguments())
        try await waitExited(erase)
        XCTAssertEqual(erase.process.terminationStatus, 78, erase.diagnostics.text)
        XCTAssertTrue(erase.diagnostics.text.contains("inUse"), erase.diagnostics.text)
        try sdk.input.fileHandleForWriting.close()
        if sdk.process.isRunning { sdk.process.terminate() }
        try await waitExited(sdk)
        let available = try start(exclusiveArguments())
        try await waitReady(available)
    }

    func testLegacyIncarnationNeverObtainsDestructiveOrCatalogAuthority() throws {
        try FileManager.default.removeItem(atPath: scope.configDir + ".bootstrap/process-authority.json")
        try retire()
        XCTAssertThrowsError(try DesktopDataUsageLease.acquire(
            scope: scope,
            epoch: String(repeating: "a", count: 64),
            purpose: .erase,
            operationId: operationId
        )) { error in
            guard case DesktopDataUsageLease.Failure.legacyUnverified = error else { return XCTFail("Expected explicit legacy refusal") }
        }
        XCTAssertTrue(FileManager.default.fileExists(atPath: scope.configDir))
    }

    private func catalogCache() throws -> URL {
        let home = URL(fileURLWithPath: scope.configDir, isDirectory: true)
            .appendingPathComponent("codex-home", isDirectory: true)
            .appendingPathComponent(scope.instance, isDirectory: true)
        try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        return home.appendingPathComponent("models_cache.json")
    }

    private func catalogReceipt() throws -> [String: Any] {
        let path = URL(fileURLWithPath: scope.configDir + ".bootstrap", isDirectory: true)
            .appendingPathComponent(".catalog-" + String(scope.secretService.suffix(64)) + ".lock")
        return try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: path)) as? [String: Any])
    }

    private func makeRuntime(host: String) throws {
        let began = ContinuousClock.now
        defer { setupMilliseconds = Self.milliseconds(began.duration(to: .now)) }
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
        fixtureNode = node
        XCTAssertEqual(try hash(Data(contentsOf: node)), metadata["executableSha256"] as? String)
        let cache = home.appendingPathComponent("runtime", isDirectory: true)
        let stage = home.appendingPathComponent("stage", isDirectory: true)
        try FileManager.default.createDirectory(at: cache, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        for directory in ["packages/core/dist", "packages/cli/dist/desktop"] {
            try FileManager.default.createDirectory(at: stage.appendingPathComponent(directory), withIntermediateDirectories: true)
        }
        try FileManager.default.copyItem(at: XCTUnwrap(tool), to: stage.appendingPathComponent("runtime-exec"))
        try FileManager.default.copyItem(at: node, to: stage.appendingPathComponent("node"))
        let preload = "import{writeSync}from'node:fs';if(process.env.OMNESIS_TEST_READY_STAGES==='1')writeSync(2,'fixture-stage:preload-enter\\n');import{fileURLToPath}from'node:url';Object.defineProperty(process,'execPath',{value:fileURLToPath(new URL('../../../runtime-exec',import.meta.url)),writable:false,configurable:false});"
        try Data(preload.utf8).write(to: stage.appendingPathComponent("packages/core/dist/managed-runtime-bootstrap.js"))
        try Data(host.utf8).write(to: stage.appendingPathComponent("packages/cli/dist/desktop/data-operation.js"))
        try Data(
            "process.stderr.write('fixture-stage:controller-script-enter\\n');process.stdout.write('ready',()=>process.stderr.write('fixture-stage:controller-ready-written\\n'));process.stdin.resume();"
                .utf8
        )
        .write(to: stage.appendingPathComponent("packages/cli/dist/index.js"))
        let manifest: [String: Any] = [
            "format": 1,
            "codeUsageProtocol": 1,
            "dataUsageProtocol": 1,
            "processAuthorityProtocol": 3,
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

    private static func milliseconds(_ duration: Duration) -> Int {
        let value = Double(duration.components.seconds) * 1000 + Double(duration.components.attoseconds) / 1e15
        return Int(max(0, min(60000, value)))
    }

    private final class Capture: @unchecked Sendable {
        private let lock = NSLock()
        private var value = ""
        private var pending = ""
        private let began = ContinuousClock.now
        private var arrivals: [String: Int] = [:]
        private var uptimes: [String: Int] = [:]
        private let phases: Set<String> = [
            "preload-enter",
            "catalog-parent-enter",
            "catalog-child-spawned",
            "catalog-child-enter",
            "catalog-child-imported",
            "catalog-before-listen",
            "catalog-listening",
            "catalog-listen-error",
            "catalog-socket-observed",
            "catalog-ready-written",
            "catalog-child-joined",
        ]
        func append(_ data: Data) {
            lock.lock()
            defer { lock.unlock() }
            let text = String(decoding: data, as: UTF8.self)
            value = String((value + text).suffix(8192))
            let lines = (pending + text).split(separator: "\n", omittingEmptySubsequences: false)
            pending = String((lines.last ?? "").suffix(4096))
            for line in lines.dropLast() {
                if line.hasPrefix("fixture-stage:") {
                    let phase = String(line.dropFirst("fixture-stage:".count))
                    if phases.contains(phase),
                       arrivals[phase] == nil { arrivals[phase] = DataUsageLeaseTests.milliseconds(began.duration(to: .now)) }
                } else if line.hasPrefix("fixture-uptime:") {
                    let parts = line.dropFirst("fixture-uptime:".count).split(separator: ":")
                    if parts.count == 2, phases.contains(String(parts[0])), let number = Int(parts[1]),
                       (0 ... 60000).contains(number) { uptimes[String(parts[0])] = number }
                }
            }
        }

        var timingSummary: String {
            lock.lock()
            defer { lock.unlock() }
            return arrivals.keys.sorted()
                .map { phase in "\(phase):emitted=\(uptimes[phase].map(String.init) ?? "unknown"),arrived=\(arrivals[phase]!)" }
                .joined(separator: "|")
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
        let readinessStage: String
        let diagnosticTarget: DesktopReadinessFailureDiagnostic.Target?
        let setupMilliseconds: Int
        let spawnMilliseconds: Int
    }

    private func start(
        _ arguments: [String],
        environment: [String: String] = [:],
        workingDirectory: URL? = nil,
        readinessStage: String = "other"
    ) throws
        -> Running {
        let process = Process(), output = Pipe(), errors = Pipe(), input = Pipe()
        // A refused fixture child must produce diagnostics, never terminate the XCTest runner via SIGPIPE.
        guard fcntl(input.fileHandleForWriting.fileDescriptor, F_SETNOSIGPIPE, 1) == 0 else { throw TestFailure.fixture }
        let capture = Capture(), diagnostics = Capture()
        process.executableURL = runtime.appendingPathComponent("runtime-exec")
        process.arguments = arguments
        process.currentDirectoryURL = workingDirectory
        process.environment = ["PATH": "/usr/bin:/bin"].merging(environment) { _, value in value }
        if readinessStage != "other" { process.environment?["OMNESIS_TEST_READY_STAGES"] = "1" }
        process.standardInput = input
        process.standardOutput = output
        process.standardError = errors
        output.fileHandleForReading.readabilityHandler = { capture.append($0.availableData) }
        errors.fileHandleForReading.readabilityHandler = { diagnostics.append($0.availableData) }
        let spawning = ContinuousClock.now
        try process.run()
        let spawnMilliseconds = Self.milliseconds(spawning.duration(to: .now))
        processes.append(process)
        return Running(
            process: process,
            capture: capture,
            diagnostics: diagnostics,
            input: input,
            output: output,
            errors: errors,
            readinessStage: readinessStage,
            diagnosticTarget: .init(process: process, runtime: runtime),
            setupMilliseconds: setupMilliseconds,
            spawnMilliseconds: spawnMilliseconds
        )
    }

    /// Failure-only metadata for this exact owned child; no path, PID, body or raw log is published.
    private func readinessDiagnostics(_ running: Running, catalog: CatalogFixtureChild? = nil) -> String {
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
            "catalog-socket-observed", "catalog-ready-written", "catalog-child-enter", "catalog-before-listen",
            "catalog-child-imported", "catalog-listening", "catalog-listen-error", "catalog-child-joined", "catalog-child-error",
            "fork-parent-enter",
            "fork-child-spawned",
            "fork-child-enter", "fork-child-sent", "fork-parent-message", "fork-ready-written",
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
        return "image=\(image); stdoutBytes=\(running.capture.text.utf8.count); stderrBytes=\(running.diagnostics.text.utf8.count); stdout[\(pipeState(running.output.fileHandleForReading))]; stderr[\(pipeState(running.errors.fileHandleForReading))]; stages=\(stages); setupMs=\(running.setupMilliseconds); spawnMs=\(running.spawnMilliseconds); stageTimingMs=\(running.diagnostics.timingSummary); childAdoptionAgeMs=\(catalog?.ageAtAdoptionMilliseconds.map(String.init) ?? "unknown"); childAgeMs=\(catalog?.ageMilliseconds().map(String.init) ?? "unknown"); nativeRefusal=\(running.diagnostics.text.contains("The managed runtime lease could not be established"))"
    }

    private func trackChild(_ running: Running, receipt: URL, socket: String, externalNode: URL? = nil) throws -> CatalogFixtureChild {
        do {
            let node = externalNode ?? runtime.appendingPathComponent("node")
            let child = try CatalogFixtureChild(
                parent: running.process, receipt: receipt,
                images: [runtime.appendingPathComponent("runtime-exec").path, node.path],
                node: node,
                joined: { running.diagnostics.text.contains("fixture-stage:catalog-child-joined") }
            )
            catalogChildren.append((child, socket))
            return child
        } catch {
            uncertainChildRegistration = true
            throw error
        }
    }

    private func waitReady(_ running: Running, catalog: CatalogFixtureChild? = nil) async throws {
        let started = ContinuousClock.now
        let deadline = Date().addingTimeInterval(5)
        while running.process.isRunning, Date() < deadline {
            try catalog?.tryAdopt()
            if running.capture.text.contains("ready"), catalog == nil || catalog?.identity != nil { break }
            try await Task.sleep(for: .milliseconds(10))
        }
        guard running.capture.text.contains("ready"), catalog == nil || catalog?.identity != nil else {
            let state = running.process.isRunning ? "running" :
                "exited status=\(running.process.terminationStatus) reason=\(running.process.terminationReason.rawValue)"
            let failure = "Ready marker absent; stage=\(running.readinessStage); controller \(state); elapsed=\(started.duration(to: .now)); \(readinessDiagnostics(running, catalog: catalog))"
            let target: DesktopReadinessFailureDiagnostic.Target? = if let catalog, let identity = catalog.identity {
                .init(identity: identity, node: catalog.node)
            } else { running.diagnosticTarget }
            let observation = await DesktopReadinessFailureDiagnostic
                .collect(target: target) { [capture = running.capture] in
                    capture.text.contains("ready")
                }
            // This branch remains failed even if the capture changes during post-failure observation.
            throw TestFailure
                .diagnostics(failure + "; " + observation + "; postSample[" + readinessDiagnostics(running, catalog: catalog) + "]")
        }
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

    private func socketCommand(_ path: String, catalogStages: Bool = false) -> String {
        let imports = catalogStages ?
            "function stage(name){process.stderr.write('fixture-stage:'+name+'\\nfixture-uptime:'+name+':'+Math.min(60000,Math.floor(process.uptime()*1000))+'\\n');}stage('catalog-child-enter');const {default:net}=await import('node:net');const {default:fs}=await import('node:fs');stage('catalog-child-imported');" :
            "import net from'node:net';import fs from'node:fs';"
        let phases = catalogStages ?
            "s.once('listening',()=>stage('catalog-listening'));s.once('error',()=>{stage('catalog-listen-error');process.exit(1)});stage('catalog-before-listen');" :
            ""
        return "\(imports)let s=net.createServer(c=>c.once('data',()=>s.close(()=>{try{fs.unlinkSync(\(literal(path)))}catch{};process.exit(0)})));\(phases)s.listen(\(literal(path)));"
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
