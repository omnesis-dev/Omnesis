// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import CryptoKit
import Darwin
@testable import DesktopCore
import Foundation
import XCTest

final class KeyRecoveryAuthorityTests: XCTestCase {
    private let epoch = String(repeating: "a", count: 64)
    private let key = "omn_root_v1_" + Data(repeating: 7, count: 32).base64EncodedString()
        .replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")

    func testPendingUpdateAndRestoreAdmitOnlyExactRootScopeAndRuntimeMetadata() throws {
        let fixture = try RecoveryFixture(epoch: epoch)
        defer { fixture.remove() }
        try fixture.write("update.json", value: fixture.update(phase: "stopping"))
        try fixture.write("restore.json", value: fixture.restore(phase: "recovery-required"))
        let context = try fixture.context()
        try DesktopKeyRecoveryAuthority.validate(context, epoch: epoch)
        let held = try DesktopDataUsageLease.acquireKeyRecovery(context, epoch: epoch)
        withExtendedLifetime(held) {}
        XCTAssertThrowsError(
            try DesktopDataUsageLease.acquire(scope: context.scope, epoch: epoch),
            "Recovery admission must not unlock normal corpus consumers"
        )
        XCTAssertThrowsError(try DesktopKeyRecoveryAuthority.validate(context, epoch: String(repeating: "c", count: 64)))
        try fixture.write("restore.json", value: fixture.restore(phase: "committed"))
        XCTAssertThrowsError(try DesktopKeyRecoveryAuthority.validate(context, epoch: epoch), "Phase changed since portable admission")
        try fixture.write("restore.json", value: fixture.restore(phase: "recovery-required"))
        var changed = fixture.update(phase: "stopping")
        changed["root"] = ["device": fixture.root.device, "inode": "0"]
        try fixture.write("update.json", value: changed)
        XCTAssertThrowsError(try DesktopKeyRecoveryAuthority.validate(context, epoch: epoch))
    }

    func testInitialConfiguredRecoveryRequiresNoPendingJournalWhenActiveIsAbsent() throws {
        let fixture = try RecoveryFixture(epoch: epoch)
        defer { fixture.remove() }
        try FileManager.default.removeItem(at: fixture.external.appendingPathComponent("active-runtime.json"))
        try DesktopKeyRecoveryAuthority.validate(fixture.context(), epoch: epoch)
        try fixture.write("restore.json", value: fixture.restore(phase: "complete"))
        XCTAssertThrowsError(try DesktopKeyRecoveryAuthority.validate(fixture.context(), epoch: epoch))
    }

    func testLegacyAuthorityRetirementAndExclusiveDataOwnerRefuseRecovery() throws {
        let fixture = try RecoveryFixture(epoch: epoch)
        defer { fixture.remove() }
        let context = try fixture.context()
        var legacy = fixture.bound
        legacy["version"] = 2
        try fixture.write("process-authority.json", value: legacy)
        XCTAssertThrowsError(try DesktopKeyRecoveryAuthority.validate(context, epoch: epoch))
        var current = fixture.bound
        current["version"] = 3
        try fixture.write("process-authority.json", value: current)
        try fixture.write(
            "retirement.json",
            value: fixture.bound.merging(["version": 1, "mode": "keep-data", "phase": "complete"]) { _, new in new }
        )
        XCTAssertThrowsError(try DesktopKeyRecoveryAuthority.validate(context, epoch: epoch))
        try FileManager.default.removeItem(at: fixture.external.appendingPathComponent("retirement.json"))
        let path = fixture.external.appendingPathComponent(".data-use-" + String(context.scope.secretService.suffix(64)) + ".lock")
        let fd = Darwin.open(path.path, O_RDWR | O_CREAT | O_NOFOLLOW, 0o600)
        XCTAssertGreaterThanOrEqual(fd, 0)
        defer { Darwin.close(fd) }
        XCTAssertEqual(flock(fd, LOCK_EX | LOCK_NB), 0)
        XCTAssertThrowsError(try DesktopDataUsageLease.acquireKeyRecovery(context, epoch: epoch))
    }

    func testContextRefusesExtraAuthorityAndMissingNullableJournalBindings() throws {
        let fixture = try RecoveryFixture(epoch: epoch)
        defer { fixture.remove() }
        var value = try fixture.object()
        value["executable"] = "/example/not-authority"
        XCTAssertThrowsError(try fixture.decode(value))
        value = try fixture.object()
        value.removeValue(forKey: "restore")
        XCTAssertThrowsError(try fixture.decode(value))
        value = try fixture.object()
        value["root"] = ["device": "0", "inode": "00"]
        XCTAssertThrowsError(try fixture.decode(value))
        let generation = UUID().uuidString.lowercased()
        try fixture.write(
            "generation.json",
            value: ["version": 1, "owner": "omnesis-desktop", "configIdentity": fixture.identity, "generation": generation]
        )
        XCTAssertThrowsError(try DesktopKeyRecoveryAuthority.validate(fixture.context(), epoch: epoch))
    }

    func testPendingMetadataSymlinksHardlinksAndPublicModesAreRefused() throws {
        let fixture = try RecoveryFixture(epoch: epoch)
        defer { fixture.remove() }
        try fixture.write("update.json", value: fixture.update(phase: "stopping"))
        let context = try fixture.context()
        let path = fixture.external.appendingPathComponent("update.json")
        XCTAssertEqual(chmod(path.path, 0o644), 0)
        XCTAssertThrowsError(try DesktopKeyRecoveryAuthority.validate(context, epoch: epoch))
        XCTAssertEqual(chmod(path.path, 0o600), 0)
        let alias = fixture.external.appendingPathComponent("held-update.json")
        XCTAssertEqual(link(path.path, alias.path), 0)
        XCTAssertThrowsError(try DesktopKeyRecoveryAuthority.validate(context, epoch: epoch))
        try FileManager.default.removeItem(at: path)
        try FileManager.default.createSymbolicLink(at: path, withDestinationURL: alias)
        XCTAssertThrowsError(try DesktopKeyRecoveryAuthority.validate(context, epoch: epoch))
    }

    func testRootInsertionIsAbsentOnlyAndMarkerRepairNeverOverwritesDifferentOrLockedItems() throws {
        let fixture = try RecoveryFixture(epoch: epoch)
        defer { fixture.remove() }
        let context = try fixture.context()
        let root = "install-root-key-v1"
        let marker = fixture.marker
        var values: [String: Data] = [:]
        var locked = false
        var writes = 0
        let store = DesktopKeyRecoveryKeychain.Store(find: { account, secret in
            if locked { return .refused }
            return values[account].map { .found(secret ? $0 : nil) } ?? .missing
        }, add: { account, bytes in
            writes += 1
            guard !locked, values[account] == nil else { return false }
            values[account] = bytes
            return true
        })
        func perform(_ operation: String, account: String, value: String? = nil) throws -> DesktopKeyRecoveryKeychain.Reply {
            var object: [String: Any] = ["version": 1, "operation": operation, "account": account]
            if let value { object["value"] = value }
            let request = try DesktopKeyRecoveryKeychain.decode(JSONSerialization.data(withJSONObject: object), context: context)
            return try DesktopKeyRecoveryKeychain.perform(request, context: context, epoch: epoch, store: store, validate: {})
        }
        XCTAssertEqual(try perform("insert-root", account: root, value: key).code, 0)
        XCTAssertEqual(try perform("insert-root", account: root, value: key).code, 1)
        XCTAssertEqual(writes, 1)
        XCTAssertEqual(try perform("repair-marker", account: marker, value: "required").code, 0)
        XCTAssertEqual(try perform("repair-marker", account: marker, value: "required").code, 0)
        XCTAssertEqual(writes, 2)
        values[marker] = Data("different".utf8)
        XCTAssertEqual(try perform("repair-marker", account: marker, value: "required").code, 1)
        XCTAssertEqual(values[marker], Data("different".utf8))
        locked = true
        let result = try perform("read", account: root)
        XCTAssertEqual(result.code, 1)
        XCTAssertEqual(result.stdout, "")
        XCTAssertEqual(writes, 2)
        XCTAssertThrowsError(try perform("repair-marker", account: root, value: "required"))
        XCTAssertThrowsError(try perform("read", account: "foreign-account"))
        XCTAssertThrowsError(try perform("delete", account: root))
        XCTAssertThrowsError(try perform("insert-root", account: root, value: String(repeating: "a", count: 64)))
    }

    func testRacingRootInsertNeverSucceedsAndRacingMirrorMustMatchExactly() throws {
        let fixture = try RecoveryFixture(epoch: epoch)
        defer { fixture.remove() }
        let context = try fixture.context()
        func request(_ operation: String, _ account: String, _ value: String) throws -> DesktopKeyRecoveryKeychain.Request {
            try DesktopKeyRecoveryKeychain.decode(JSONSerialization.data(withJSONObject: [
                "version": 1, "operation": operation, "account": account, "value": value,
            ]), context: context)
        }
        let rootRequest = try request("insert-root", "install-root-key-v1", key)
        var rootRead = 0
        let rootStore = DesktopKeyRecoveryKeychain.Store(
            find: { _, _ in rootRead += 1
                return .missing
            },
            add: { _, _ in false }
        )
        let rootResult = try DesktopKeyRecoveryKeychain.perform(
            rootRequest,
            context: context,
            epoch: epoch,
            store: rootStore,
            validate: {}
        )
        XCTAssertEqual(rootResult.code, 1)
        XCTAssertEqual(rootRead, 1, "Duplicate root insertion is refused, never translated to an overwrite")
        let markerRequest = try request("repair-marker", fixture.marker, "required")
        var uncertainReads = 0
        let uncertainStore = DesktopKeyRecoveryKeychain.Store(
            find: { _, _ in
                uncertainReads += 1
                return uncertainReads == 1 ? .missing : .found(Data("required".utf8))
            },
            add: { _, _ in throw DesktopKeyRecoveryAuthority.Failure.keychainRefused }
        )
        XCTAssertThrowsError(try DesktopKeyRecoveryKeychain.perform(
            markerRequest, context: context, epoch: epoch, store: uncertainStore, validate: {}
        ))
        XCTAssertEqual(uncertainReads, 1, "An unjoined writer must not enter the identical-marker race fallback")
        for racing in ["required", "different"] {
            var current: Data?
            let store = DesktopKeyRecoveryKeychain.Store(
                find: { _, _ in current.map { .found($0) } ?? .missing },
                add: { _, _ in current = Data(racing.utf8)
                    return false
                }
            )
            let result = try DesktopKeyRecoveryKeychain.perform(
                markerRequest,
                context: context,
                epoch: epoch,
                store: store,
                validate: {}
            )
            XCTAssertEqual(result.code, racing == "required" ? 0 : 1)
            XCTAssertEqual(current, Data(racing.utf8))
        }
    }

    func testDigestAndImmediateMutationRevalidationRejectBeforeAdd() throws {
        let fixture = try RecoveryFixture(epoch: epoch)
        defer { fixture.remove() }
        try fixture.write("restore.json", value: fixture.restore(phase: "committed"))
        let context = try fixture.context()
        let raw: [String: Any] = ["version": 1, "operation": "insert-root", "account": "install-root-key-v1", "value": key]
        let request = try DesktopKeyRecoveryKeychain.decode(JSONSerialization.data(withJSONObject: raw), context: context)
        var validations = 0, writes = 0
        XCTAssertThrowsError(try DesktopKeyRecoveryKeychain.perform(request, context: context, epoch: epoch, store: .init(
            find: { _, _ in .missing }, add: { _, _ in writes += 1
                return true
            }
        ), validate: {
            validations += 1
            if validations == 2 { throw DesktopKeyRecoveryAuthority.Failure.changedInstallation }
        }))
        XCTAssertEqual(writes, 0)
        var wrong = raw
        wrong["value"] = "omn_root_v1_" + Data(repeating: 8, count: 32).base64EncodedString().replacingOccurrences(of: "=", with: "")
        XCTAssertThrowsError(try DesktopKeyRecoveryKeychain.decode(JSONSerialization.data(withJSONObject: wrong), context: context))
    }

    func testReadOnlyDelegateCannotSelectAnotherAccountOrTransmitASecretInArguments() throws {
        let fixture = try RecoveryFixture(epoch: epoch)
        defer { fixture.remove() }
        for account in ["install-root-key-v1", fixture.marker] {
            let arguments = try DesktopKeyRecoveryReadOnly.arguments(account: account, scope: fixture.scope, secret: true)
            XCTAssertEqual(arguments, ["find-generic-password", "-a", account, "-s", fixture.scope.secretService, "-w"])
            XCTAssertFalse(arguments.contains(key))
            XCTAssertFalse(arguments.contains("add-generic-password"))
            XCTAssertFalse(arguments.contains("-U"))
            XCTAssertEqual(
                try DesktopKeyRecoveryReadOnly.arguments(account: account, scope: fixture.scope, secret: false),
                ["find-generic-password", "-a", account, "-s", fixture.scope.secretService]
            )
        }
        XCTAssertThrowsError(try DesktopKeyRecoveryReadOnly.arguments(account: "foreign-account", scope: fixture.scope, secret: true))
        XCTAssertThrowsError(try DesktopKeyRecoveryReadOnly.arguments(account: key, scope: fixture.scope, secret: true))
    }

    func testNodeSpawnedPrivateSocketpairFrameWithFakeStore() throws {
        if ProcessInfo.processInfo.environment["OMNESIS_TEST_KEY_RECOVERY_STDIN_CHILD"] == "1" {
            var stage = "fixture"
            do {
                let fixture = try RecoveryFixture(epoch: epoch)
                defer { fixture.remove() }
                let context = try fixture.context()
                stage = "stdout"
                try DesktopKeyRecoveryKeychain.validatePrivateChannel(STDOUT_FILENO)
                stage = "parent"
                let parentRuntime = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
                    .deletingLastPathComponent().appendingPathComponent(".node-fixture", isDirectory: true)
                let proof = try DesktopKeyRecoveryKeychain.validateParent(runtime: parentRuntime)
                stage = "stdin"
                let bytes = try DesktopKeyRecoveryKeychain.readInput(parent: proof)
                stage = "decode"
                let request = try DesktopKeyRecoveryKeychain.decode(bytes, context: context)
                stage = "fake-store"
                let reply = try DesktopKeyRecoveryKeychain.perform(request, context: context, epoch: epoch, store: .init(
                    find: { _, _ in .found(Data("invented Keychain fixture".utf8)) },
                    add: { _, _ in XCTFail("Reader fixture must not mutate Keychain")
                        return false
                    }
                ), validate: {})
                XCTAssertEqual(reply.code, 0)
                XCTAssertTrue(reply.stdout == "invented Keychain fixture\n")
                stage = "stdout-after"
                try DesktopKeyRecoveryKeychain.validatePrivateChannel(STDOUT_FILENO)
                try FileHandle.standardOutput.write(contentsOf: Data("owned-socketpair:passed\n".utf8))
            } catch {
                let diagnostic: [String: Any] = [
                    "stage": stage,
                    "failure": inputFailureDiagnostic(error),
                    "stdin": channelDiagnostic(STDIN_FILENO),
                    "stdout": channelDiagnostic(STDOUT_FILENO),
                ]
                let bytes = try JSONSerialization.data(withJSONObject: diagnostic, options: .sortedKeys)
                guard bytes.count <= 4096 else { throw CocoaError(.fileReadCorruptFile) }
                var line = Data("KEY_RECOVERY_CHANNEL_DIAGNOSTIC ".utf8)
                line.append(bytes)
                line.append(10)
                try FileHandle.standardError.write(contentsOf: line)
                throw error
            }
            return
        }
        let fixtureRoot = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().appendingPathComponent(".node-fixture", isDirectory: true)
        let metadataBytes = try Data(contentsOf: fixtureRoot.appendingPathComponent("node-fixture.json"))
        XCTAssertLessThanOrEqual(metadataBytes.count, 4096)
        let metadata = try XCTUnwrap(JSONSerialization.jsonObject(with: metadataBytes) as? [String: Any])
        guard metadata["owner"] as? String == "omnesis-desktop-node-test-fixture", metadata["format"] as? Int == 1,
              (metadata["nodeVersion"] as? String)?.hasPrefix("24.") == true else { throw CocoaError(.fileReadCorruptFile) }
        let node = fixtureRoot.appendingPathComponent("node")
        let hash = try SHA256.hash(data: Data(contentsOf: node)).map { String(format: "%02x", $0) }.joined()
        guard hash == metadata["executableSha256"] as? String else { throw CocoaError(.fileReadCorruptFile) }
        let locate = Process(), location = Pipe()
        locate.executableURL = URL(fileURLWithPath: "/usr/bin/xcrun")
        locate.arguments = ["--find", "xctest"]
        locate.standardOutput = location
        locate.standardError = FileHandle.nullDevice
        try locate.run()
        locate.waitUntilExit()
        let executable = String(decoding: location.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard locate.terminationStatus == 0, executable.hasPrefix("/"), FileManager.default.isExecutableFile(atPath: executable) else {
            throw CocoaError(.fileReadNoSuchFile)
        }
        func literal(_ value: String) throws -> String {
            try String(decoding: JSONSerialization.data(withJSONObject: value, options: .fragmentsAllowed), as: UTF8.self)
        }
        let bundle = Bundle(for: KeyRecoveryAuthorityTests.self).bundleURL
        let script = try """
        const {spawn}=require('node:child_process');
        const child=spawn(\(
            literal(executable)
        ),['-XCTest','DesktopCoreTests.KeyRecoveryAuthorityTests/testNodeSpawnedPrivateSocketpairFrameWithFakeStore',\(literal(bundle
                .path))],{
          env:{...process.env,OMNESIS_TEST_KEY_RECOVERY_STDIN_CHILD:'1'},stdio:['pipe','pipe','pipe']});
        let output='',errors='',failed=false,spawnError='none';
        const timeout=setTimeout(()=>{failed=true;child.kill('SIGTERM')},20000);
        const forced=setTimeout(()=>{failed=true;child.kill('SIGKILL')},25000);
        child.stdout.on('data',bytes=>{if(output.length<65536)output+=bytes.toString().slice(0,65536-output.length);else{failed=true;child.kill('SIGTERM')}});
        child.stderr.on('data',bytes=>{if(errors.length<16384)errors+=bytes.toString().slice(0,16384-errors.length)});child.stdin.on('error',()=>{});
        child.on('error',error=>{failed=true;spawnError=['ENOENT','EACCES'].includes(error.code)?error.code:'other'});
        child.on('close',(code,signal)=>{clearTimeout(timeout);clearTimeout(forced);
          if(failed||code!==0||!output.includes('owned-socketpair:passed')){
            const line=errors.split('\\n').find(line=>line.startsWith('KEY_RECOVERY_CHANNEL_DIAGNOSTIC '));let channel=null;
            try{if(line&&line.length<=4096)channel=JSON.parse(line.slice('KEY_RECOVERY_CHANNEL_DIAGNOSTIC '.length))}catch{}
            process.stderr.write('KEY_RECOVERY_NODE_DIAGNOSTIC '+JSON.stringify({exit:code,signal:['SIGTERM','SIGKILL','SIGABRT'].includes(signal)?signal:null,
              failed,spawnError,hasMethod:output.includes('testNodeSpawnedPrivateSocketpairFrameWithFakeStore'),zeroTests:/Executed 0 tests/.test(output),
              invalidRequest:output.includes('invalidRequest'),bundleLoadFailure:/could not be loaded|failed to load/i.test(errors),channel})+'\\n');
            process.exitCode=1;return}

          process.stdout.write('node-socketpair:passed\\n')});
        child.stdin.end(JSON.stringify({version:1,operation:'read',account:'install-root-key-v1'}));
        """
        let process = Process(), output = Pipe(), errors = Pipe()
        process.executableURL = node
        process.arguments = ["-e", script]
        process.standardInput = FileHandle.nullDevice
        process.standardOutput = output
        process.standardError = errors
        process.environment = ["PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "HOME": FileManager.default.homeDirectoryForCurrentUser.path]
        try process.run()
        process.waitUntilExit()
        let diagnosticBytes = errors.fileHandleForReading.readDataToEndOfFile()
        let diagnostic = String(decoding: diagnosticBytes.prefix(8192), as: UTF8.self).split(separator: "\n")
            .first { $0.hasPrefix("KEY_RECOVERY_NODE_DIAGNOSTIC ") }.map(String.init) ?? "KEY_RECOVERY_NODE_DIAGNOSTIC unavailable"
        XCTAssertEqual(process.terminationStatus, 0, diagnostic)
        XCTAssertEqual(String(decoding: output.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self), "node-socketpair:passed\n")
    }

    private func inputFailureDiagnostic(_ error: Error) -> [String: Any] {
        guard let failure = error as? DesktopKeyRecoveryKeychain.InputFailure else { return ["kind": "other"] }
        switch failure {
        case .channelValidation: return ["kind": "channelValidation"]
        case .emptyEOF: return ["kind": "emptyEOF", "count": 0]
        case .oversize: return ["kind": "oversize"]
        case .deadline(let count): return ["kind": "deadline", "count": min(count, 4096)]
        case .read(let count, let code): return ["kind": "read", "count": min(count, 4096), "errno": code]
        case .poll(let count, let code): return ["kind": "poll", "count": min(count, 4096), "errno": code]
        }
    }

    /// Bounded owned-descriptor facts only: no paths, IDs, addresses, or input/output bytes.
    private func channelDiagnostic(_ fd: Int32) -> [String: Any] {
        var metadata = stat()
        let statStatus = fstat(fd, &metadata)
        let kind = metadata.st_mode & S_IFMT
        var result: [String: Any] = [
            "stat": statStatus,
            "kind": kind == S_IFSOCK ? "socket" : kind == S_IFIFO ? "pipe" : "other",
            "anonymous": metadata.st_nlink == 0,
            "sameOwner": metadata.st_uid == getuid(),
        ]
        guard statStatus == 0, kind == S_IFSOCK else { return result }
        var type: Int32 = 0, size = socklen_t(MemoryLayout<Int32>.size)
        let typeStatus = getsockopt(fd, SOL_SOCKET, SO_TYPE, &type, &size)
        result["typeStatus"] = typeStatus
        result["stream"] = type == SOCK_STREAM
        for peer in [false, true] {
            var address = sockaddr_un(), count = socklen_t(MemoryLayout<sockaddr_un>.size)
            var addressError: Int32 = 0
            let status = withUnsafeMutablePointer(to: &address) { pointer in
                pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                    let status = peer ? getpeername(fd, $0, &count) : getsockname(fd, $0, &count)
                    addressError = status == 0 ? 0 : errno
                    return status
                }
            }
            result[peer ? "peerStatus" : "localStatus"] = status
            result[peer ? "peerErrno" : "localErrno"] = addressError
            result[peer ? "peerUnix" : "localUnix"] = address.sun_family == sa_family_t(AF_UNIX)
            result[peer ? "peerUnnamed" : "localUnnamed"] = withUnsafeBytes(of: address.sun_path) { $0.allSatisfy { $0 == 0 } }
        }
        var uid: uid_t = 0, gid: gid_t = 0
        let credentialStatus = getpeereid(fd, &uid, &gid)
        result["credentialStatus"] = credentialStatus
        result["credentialErrno"] = credentialStatus == 0 ? 0 : errno
        result["sameUID"] = credentialStatus == 0 && uid == getuid()
        var pid: pid_t = 0
        size = socklen_t(MemoryLayout<pid_t>.size)
        let pidStatus = getsockopt(fd, SOL_LOCAL, LOCAL_PEERPID, &pid, &size)
        result["pidStatus"] = pidStatus
        result["pidErrno"] = pidStatus == 0 ? 0 : errno
        result["pidZero"] = pid == 0
        result["pidMatchesParent"] = pid == getppid()
        result["pidMatchesSelf"] = pid == getpid()
        return result
    }

    func testInputRejectsDatagramTCPAndForeignPeerIdentity() throws {
        var pair = [Int32](repeating: -1, count: 2)
        XCTAssertEqual(socketpair(AF_UNIX, SOCK_DGRAM, 0, &pair), 0)
        defer { pair.forEach { Darwin.close($0) } }
        XCTAssertThrowsError(try DesktopKeyRecoveryKeychain.readInput(descriptor: pair[0]))
        XCTAssertThrowsError(try DesktopKeyRecoveryKeychain.validatePrivateChannel(pair[0]))
        let tcp = socket(AF_INET, SOCK_STREAM, 0)
        XCTAssertGreaterThanOrEqual(tcp, 0)
        defer { Darwin.close(tcp) }
        XCTAssertThrowsError(try DesktopKeyRecoveryKeychain.readInput(descriptor: tcp))
        XCTAssertThrowsError(try DesktopKeyRecoveryKeychain.validatePrivateChannel(tcp))
        let temporary = URL(fileURLWithPath: "/tmp", isDirectory: true).appendingPathComponent("kr-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: temporary, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        defer { try? FileManager.default.removeItem(at: temporary) }
        let path = temporary.appendingPathComponent("named.sock")
        let listener = socket(AF_UNIX, SOCK_STREAM, 0), client = socket(AF_UNIX, SOCK_STREAM, 0)
        XCTAssertGreaterThanOrEqual(listener, 0)
        XCTAssertGreaterThanOrEqual(client, 0)
        defer { Darwin.close(listener)
            Darwin.close(client)
        }
        XCTAssertEqual(try DesktopBackgroundSocket.address(path) { Darwin.bind(listener, $0, $1) }, 0)
        XCTAssertEqual(listen(listener, 1), 0)
        XCTAssertEqual(try DesktopBackgroundSocket.address(path) { Darwin.connect(client, $0, $1) }, 0)
        XCTAssertThrowsError(
            try DesktopKeyRecoveryKeychain.readInput(descriptor: client),
            "A named Unix endpoint is not a private socketpair"
        )
        XCTAssertThrowsError(try DesktopKeyRecoveryKeychain.validatePrivateChannel(client))
        let fifo = temporary.appendingPathComponent("named.fifo")
        XCTAssertEqual(mkfifo(fifo.path, 0o600), 0)
        let named = Darwin.open(fifo.path, O_RDONLY | O_NONBLOCK)
        defer { Darwin.close(named) }
        XCTAssertThrowsError(
            try DesktopKeyRecoveryKeychain.readInput(descriptor: named),
            "A named FIFO is not the owned private input pipe"
        )
        XCTAssertThrowsError(try DesktopKeyRecoveryKeychain.validatePrivateChannel(named))
        XCTAssertThrowsError(try DesktopKeyRecoveryKeychain.validatePeer(uid: getuid() == 0 ? 1 : 0, pid: getppid(), parent: getppid()))
        XCTAssertThrowsError(try DesktopKeyRecoveryKeychain.validatePeer(uid: getuid(), pid: getpid(), parent: getppid()))
        XCTAssertThrowsError(try DesktopKeyRecoveryKeychain.validateParent(runtime: URL(fileURLWithPath: "/example/not-selected-runtime")))
    }

    func testNeverConnectedOrDisconnectedOutputCannotUseInputParentException() throws {
        let neverConnected = socket(AF_UNIX, SOCK_STREAM, 0)
        XCTAssertGreaterThanOrEqual(neverConnected, 0)
        defer { Darwin.close(neverConnected) }
        XCTAssertThrowsError(try DesktopKeyRecoveryKeychain.readInput(descriptor: neverConnected))
        var pair = [Int32](repeating: -1, count: 2)
        guard socketpair(AF_UNIX, SOCK_STREAM, 0, &pair) == 0 else { throw CocoaError(.fileReadUnknown) }
        defer { Darwin.close(pair[0]) }
        Darwin.close(pair[1])
        XCTAssertThrowsError(
            try DesktopKeyRecoveryKeychain.validatePrivateChannel(pair[0]),
            "Output must stay connected; retained credentials cannot authorize raw-root output"
        )
        XCTAssertThrowsError(
            try DesktopKeyRecoveryKeychain.readInput(descriptor: pair[0]),
            "A closed input without a verified live selected Node parent remains refused"
        )
    }

    func testFullyShutdownSocketRetainsCredentialsButCannotAuthorizeInputOrOutputAlone() throws {
        var pair = [Int32](repeating: -1, count: 2)
        guard socketpair(AF_UNIX, SOCK_STREAM, 0, &pair) == 0 else { throw CocoaError(.fileReadUnknown) }
        defer { Darwin.close(pair[0]) }
        XCTAssertEqual(shutdown(pair[0], SHUT_RDWR), 0)
        Darwin.close(pair[1])
        var address = sockaddr_un(), addressBytes = socklen_t(MemoryLayout<sockaddr_un>.size)
        var addressError: Int32 = 0
        let addressStatus = withUnsafeMutablePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                let status = getpeername(pair[0], $0, &addressBytes)
                addressError = status == 0 ? 0 : errno
                return status
            }
        }
        XCTAssertEqual(addressStatus, -1)
        XCTAssertEqual(addressError, EINVAL)
        var uid: uid_t = 0, gid: gid_t = 0
        XCTAssertEqual(getpeereid(pair[0], &uid, &gid), 0)
        XCTAssertEqual(uid, getuid())
        var pid: pid_t = 0, pidBytes = socklen_t(MemoryLayout<pid_t>.size)
        let pidStatus = getsockopt(pair[0], SOL_LOCAL, LOCAL_PEERPID, &pid, &pidBytes)
        let pidError = pidStatus == 0 ? 0 : errno
        XCTAssertEqual(pidStatus, -1)
        XCTAssertEqual(pidError, ENOTCONN)
        XCTAssertThrowsError(try DesktopKeyRecoveryKeychain.readInput(descriptor: pair[0]))
        XCTAssertThrowsError(try DesktopKeyRecoveryKeychain.validatePrivateChannel(pair[0]))
    }

    func testPrivateOutputAcceptsAnonymousWriterAndRefusesFileAndNullSink() throws {
        let fixture = try RecoveryFixture(epoch: epoch)
        defer { fixture.remove() }
        let pipe = Pipe()
        defer { try? pipe.fileHandleForReading.close()
            try? pipe.fileHandleForWriting.close()
        }
        try DesktopKeyRecoveryKeychain.validatePrivateChannel(pipe.fileHandleForWriting.fileDescriptor)
        let path = fixture.home.appendingPathComponent("not-a-private-reply.log")
        let file = Darwin.open(path.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
        XCTAssertGreaterThanOrEqual(file, 0)
        defer { Darwin.close(file) }
        XCTAssertThrowsError(
            try DesktopKeyRecoveryKeychain.validatePrivateChannel(file),
            "Even an owned private log must never receive a raw root reply"
        )
        var info = stat()
        XCTAssertEqual(fstat(file, &info), 0)
        XCTAssertEqual(info.st_size, 0)
        let null = Darwin.open("/dev/null", O_WRONLY)
        defer { Darwin.close(null) }
        XCTAssertThrowsError(try DesktopKeyRecoveryKeychain.validatePrivateChannel(null))
    }

    func testInputAcceptsOnlyBoundedOwnedPipeAndRejectsOversizeWithoutKeychainAccess() throws {
        for size in [2, 4097] {
            let pipe = Pipe()
            try pipe.fileHandleForWriting.write(contentsOf: Data(repeating: 32, count: size))
            try pipe.fileHandleForWriting.close()
            defer { try? pipe.fileHandleForReading.close() }
            if size == 2 { XCTAssertEqual(
                try DesktopKeyRecoveryKeychain.readInput(descriptor: pipe.fileHandleForReading.fileDescriptor).count,
                2
            ) } else { XCTAssertThrowsError(try DesktopKeyRecoveryKeychain.readInput(descriptor: pipe.fileHandleForReading.fileDescriptor))
            }
        }
        let fd = Darwin.open("/dev/null", O_RDONLY)
        defer { Darwin.close(fd) }
        XCTAssertThrowsError(try DesktopKeyRecoveryKeychain.readInput(descriptor: fd))
    }
}

private final class RecoveryFixture {
    let home: URL
    let config: URL
    let external: URL
    let root: DesktopKeyRecoveryAuthority.Root
    let scope: DesktopDataUsageLease.Scope
    let identity: String
    let epoch: String
    let operation = UUID().uuidString.lowercased()
    var bound: [String: Any] {
        ["owner": "omnesis-desktop", "instance": scope.instance, "secretService": scope.secretService]
    }

    var marker: String {
        let suffix = Data(SHA256.hash(data: Data(config.path.utf8))).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
        return "storage-encryption-state-v1:" + String(suffix.prefix(12))
    }

    init(epoch: String) throws {
        let temporary = FileManager.default.temporaryDirectory.appendingPathComponent("recovery-admission-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: temporary, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        home = try URL(fileURLWithPath: DesktopCanonicalPath.resolve(temporary.path), isDirectory: true)
        config = home.appendingPathComponent("library", isDirectory: true)
        external = URL(fileURLWithPath: config.path + ".bootstrap", isDirectory: true)
        try FileManager.default.createDirectory(at: config, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        try FileManager.default.createDirectory(at: external, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        var info = stat()
        guard lstat(config.path, &info) == 0 else { throw CocoaError(.fileReadUnknown) }
        root = .init(device: String(info.st_dev), inode: String(info.st_ino))
        identity = SHA256.hash(data: Data(config.path.utf8)).map { String(format: "%02x", $0) }.joined()
        scope = .init(configDir: config.path, instance: "desktop-" + identity.prefix(16), secretService: "dev.omnesis.desktop." + identity)
        self.epoch = epoch
        try write("process-authority.json", value: bound.merging(["version": 3]) { _, new in new })
        try write(
            "desktop-install.json",
            value: bound.merging(["version": 1, "mode": "home", "phase": "configured", "processAuthorityVersion": 3]) { _, new in new },
            config: true
        )
        try write("active-runtime.json", value: bound.merging(["format": 1, "epoch": epoch]) { _, new in new })
    }

    func update(phase: String) -> [String: Any] {
        bound.merging([
            "format": 1,
            "operationId": operation,
            "phase": phase,
            "root": ["device": root.device, "inode": root.inode],
            "oldEpoch": epoch,
            "candidateEpoch": String(repeating: "b", count: 64),
        ]) { _, new in new }
    }

    func restore(phase: String) -> [String: Any] {
        let digest = SHA256.hash(data: Data(repeating: 7, count: 32)).map { String(format: "%02x", $0) }.joined()
        return bound.merging([
            "version": 1,
            "operationId": operation,
            "phase": phase,
            "root": ["device": root.device, "inode": root.inode],
            "targetKeyDigest": digest,
        ]) { _, new in new }
    }

    func write(_ name: String, value: [String: Any], config useConfig: Bool = false) throws {
        let path = (useConfig ? config : external).appendingPathComponent(name)
        try JSONSerialization.data(withJSONObject: value).write(to: path)
        guard chmod(path.path, 0o600) == 0 else { throw CocoaError(.fileWriteUnknown) }
    }

    func object() throws -> [String: Any] {
        func existing(_ name: String, keys: [String]) throws -> Any {
            let path = external.appendingPathComponent(name)
            guard FileManager.default.fileExists(atPath: path.path) else { return NSNull() }
            let object = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: path)) as? [String: Any])
            return object.filter { keys.contains($0.key) }
        }
        return try [
            "version": 1,
            "scope": ["format": 1, "configDir": scope.configDir, "instance": scope.instance, "secretService": scope.secretService],
            "root": ["device": root.device, "inode": root.inode],
            "update": existing("update.json", keys: ["operationId", "phase"]),
            "restore": existing("restore.json", keys: ["operationId", "phase", "targetKeyDigest"]),
        ]
    }

    func decode(_ object: [String: Any]) throws -> DesktopKeyRecoveryAuthority.Context {
        let bytes = try JSONSerialization.data(withJSONObject: object)
        let encoded = bytes.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(
                of: "=",
                with: ""
            )
        return try DesktopKeyRecoveryAuthority.decode(encoded)
    }

    func context() throws -> DesktopKeyRecoveryAuthority.Context {
        try decode(object())
    }

    func remove() {
        try? FileManager.default.removeItem(at: home)
    }
}
