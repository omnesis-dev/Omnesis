// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import CryptoKit
import Darwin
import Foundation

/// A component's descendants retain data authority independently of the component's PID.
/// Controllers never acquire SH; destructive hosts retain EX across actual publication/purge.
public final class DesktopDataUsageLease {
    public enum Failure: Error { case invalidScope, unsafeRecord, inUse, blocked, missingAuthority, legacyUnverified }
    public struct Scope: Codable, Equatable {
        public let format: Int
        public let configDir: String
        public let instance: String
        public let secretService: String
        public var restoreActivation: Activation?
        public init(configDir: String, instance: String, secretService: String, restoreActivation: Activation? = nil) {
            format = 1
            self.configDir = configDir
            self.instance = instance
            self.secretService = secretService
            self.restoreActivation = restoreActivation
        }
    }

    public struct Activation: Codable, Equatable {
        public let operationId: String
        public let attemptId: String
        public let epoch: String?
    }

    public enum Purpose: String, Codable {
        case erase, restore, rollback
        case updateSnapshot = "update-snapshot"
        case updateRollback = "update-rollback"
    }

    private struct Identity: Codable { let device: String
        let inode: String
    }

    private struct Operation: Codable, Equatable { let purpose: Purpose
        let operationId: String
    }

    private struct Context: Codable {
        let format: Int
        let scope: Scope
        let lease: Identity
        let exclusive: Operation?
    }

    public static let inheritedDescriptor: Int32 = 7
    private let descriptor: Int32
    private let context: Context
    deinit { Darwin.close(descriptor) }

    /// Decode bounded metadata only; no credential or recovery key reaches the native adapter.
    public static func decodeScope(_ encoded: String) throws -> Scope {
        guard encoded.utf8.count <= 16384, let data = unbase64(encoded), data.count <= 8192 else {
            throw Failure.invalidScope
        }
        return try JSONDecoder().decode(Scope.self, from: data)
    }

    public static func acquire(
        scope: Scope,
        epoch: String,
        purpose: Purpose? = nil,
        operationId: String? = nil,
        inheriting: Bool = false,
        keychainSetup: Bool = false,
        keychainRead: Bool = false,
        environment: [String: String] = ProcessInfo.processInfo.environment
    ) throws
        -> DesktopDataUsageLease {
        try validateProfile(scope)
        let path = lockURL(scope)
        let operation: Operation?
        if let purpose, let operationId, validUUID(operationId) {
            operation = Operation(purpose: purpose, operationId: operationId)
        } else if purpose == nil, operationId == nil, !inheriting {
            operation = nil
        } else { throw Failure.invalidScope }
        let descriptor: Int32
        if inheriting {
            guard let operation,
                  let encoded = environment["OMNESIS_DESKTOP_DATA_CONTEXT"], encoded.utf8.count <= 16384,
                  let bytes = unbase64(encoded), let previous = try? JSONDecoder().decode(Context.self, from: bytes),
                  previous.format == 1, previous.scope == scope, previous.exclusive == operation else {
                throw Failure.missingAuthority
            }
            var held = stat(), published = stat()
            guard fstat(inheritedDescriptor, &held) == 0, lstat(path.path, &published) == 0,
                  validFile(held), held.st_dev == published.st_dev, held.st_ino == published.st_ino,
                  previous.lease.device == String(held.st_dev), previous.lease.inode == String(held.st_ino),
                  flock(inheritedDescriptor, LOCK_EX | LOCK_NB) == 0 else { throw Failure.missingAuthority }
            descriptor = dup(inheritedDescriptor)
            if descriptor >= 0 { _ = fcntl(descriptor, F_SETFD, FD_CLOEXEC) }
        } else {
            descriptor = Darwin.open(path.path, O_RDWR | O_CREAT | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK, 0o600)
            guard descriptor >= 0 else { throw Failure.unsafeRecord }
            var info = stat()
            guard fstat(descriptor, &info) == 0, validFile(info) else {
                Darwin.close(descriptor)
                throw Failure.unsafeRecord
            }
            guard flock(descriptor, (operation == nil ? LOCK_SH : LOCK_EX) | LOCK_NB) == 0 else {
                Darwin.close(descriptor)
                throw Failure.inUse
            }
        }
        guard descriptor >= 0 else { throw Failure.unsafeRecord }
        do {
            // EX may have won after the caller read its profile. Revalidate only after SH/EX
            // is held so a queued consumer never reopens erased/replaced state.
            try validateProfile(scope)
            if let operation { try validateOperation(scope, operation) }
            else { try validateConsumer(scope, epoch: epoch, keychainSetup: keychainSetup, keychainRead: keychainRead) }
            var info = stat()
            guard fstat(descriptor, &info) == 0, validFile(info) else { throw Failure.unsafeRecord }
            return DesktopDataUsageLease(descriptor: descriptor, context: Context(
                format: 1, scope: scope,
                lease: Identity(device: String(info.st_dev), inode: String(info.st_ino)),
                exclusive: operation
            ))
        } catch { Darwin.close(descriptor)
            throw error
        }
    }

    /// Recovery uses only fixed native Keychain calls while preserving the ordinary consumer fence.
    public static func acquireKeyRecovery(_ recovery: DesktopKeyRecoveryAuthority.Context, epoch: String) throws -> DesktopDataUsageLease {
        try DesktopKeyRecoveryAuthority.validate(recovery, epoch: epoch)
        let path = lockURL(recovery.scope)
        let descriptor = Darwin.open(path.path, O_RDWR | O_CREAT | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK, 0o600)
        guard descriptor >= 0 else { throw Failure.unsafeRecord }
        do {
            var info = stat(), published = stat()
            guard fstat(descriptor, &info) == 0, validFile(info), lstat(path.path, &published) == 0,
                  info.st_dev == published.st_dev, info.st_ino == published.st_ino else { throw Failure.unsafeRecord }
            guard flock(descriptor, LOCK_SH | LOCK_NB) == 0 else { throw Failure.inUse }
            try DesktopKeyRecoveryAuthority.validate(recovery, epoch: epoch)
            return DesktopDataUsageLease(descriptor: descriptor, context: Context(
                format: 1, scope: recovery.scope, lease: Identity(device: String(info.st_dev), inode: String(info.st_ino)), exclusive: nil
            ))
        } catch { Darwin.close(descriptor)
            throw error
        }
    }

    /// Only the fixed native read/write delegates receive this exact SH description at FD7.
    func keyRecoveryDescriptor(scope: Scope) throws -> Int32 {
        guard context.exclusive == nil, context.scope == scope else { throw Failure.missingAuthority }
        let duplicate = fcntl(descriptor, F_DUPFD_CLOEXEC, 30)
        guard duplicate >= 30 else { throw Failure.unsafeRecord }
        return duplicate
    }

    /// A catalog writer retains its own EX lease even if its controller is killed.
    public final class CatalogDiscovery {
        private let descriptor: Int32
        fileprivate init(descriptor: Int32) {
            self.descriptor = descriptor
        }

        deinit { Darwin.close(descriptor) }
        public func inheritAcrossExec() throws {
            let flags = fcntl(descriptor, F_GETFD)
            guard flags >= 0, fcntl(descriptor, F_SETFD, flags & ~FD_CLOEXEC) == 0 else { throw Failure.unsafeRecord }
        }
    }

    public func acquireCatalogDiscovery(nonce: String, epoch: String) throws -> CatalogDiscovery {
        guard context.exclusive == nil, Self.validUUID(nonce) else { throw Failure.missingAuthority }
        try Self.requireProcessAuthority(context.scope)
        try Self.validateProfile(context.scope)
        try Self.validateConsumer(context.scope, epoch: epoch, keychainSetup: false, keychainRead: false)
        let path = URL(fileURLWithPath: context.scope.configDir + ".bootstrap", isDirectory: true)
            .appendingPathComponent(".catalog-" + String(context.scope.secretService.suffix(64)) + ".lock")
        let opened = Darwin.open(path.path, O_RDWR | O_CREAT | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard opened >= 0 else { throw Failure.unsafeRecord }
        let descriptor = fcntl(opened, F_DUPFD_CLOEXEC, 8)
        Darwin.close(opened)
        guard descriptor >= 8 else { throw Failure.unsafeRecord }
        do {
            var info = stat(), published = stat()
            guard fstat(descriptor, &info) == 0, Self.validFile(info), lstat(path.path, &published) == 0,
                  info.st_dev == published.st_dev, info.st_ino == published.st_ino else { throw Failure.unsafeRecord }
            guard flock(descriptor, LOCK_EX | LOCK_NB) == 0 else { throw Failure.inUse }
            guard fstat(descriptor, &info) == 0, Self.validFile(info), lstat(path.path, &published) == 0,
                  info.st_dev == published.st_dev, info.st_ino == published.st_ino else { throw Failure.unsafeRecord }
            try Self.validateProfile(context.scope)
            try Self.validateConsumer(context.scope, epoch: epoch, keychainSetup: false, keychainRead: false)
            let cache = URL(fileURLWithPath: context.scope.configDir, isDirectory: true)
                .appendingPathComponent("codex-home", isDirectory: true)
                .appendingPathComponent(context.scope.instance, isDirectory: true)
                .appendingPathComponent("models_cache.json")
            let previous = try Self.catalogWitness(cache)
            let receipt = try JSONSerialization.data(withJSONObject: [
                "version": 1, "nonce": nonce, "previousSha256": previous.map { $0 as Any } ?? NSNull(),
            ])
            guard ftruncate(descriptor, 0) == 0, lseek(descriptor, 0, SEEK_SET) == 0 else { throw Failure.unsafeRecord }
            try receipt.withUnsafeBytes { buffer in
                var offset = 0
                while offset < buffer.count {
                    let count = Darwin.write(descriptor, buffer.baseAddress!.advanced(by: offset), buffer.count - offset)
                    if count < 0, errno == EINTR { continue }
                    guard count > 0 else { throw Failure.unsafeRecord }
                    offset += count
                }
            }
            guard fsync(descriptor) == 0 else { throw Failure.unsafeRecord }
            return CatalogDiscovery(descriptor: descriptor)
        } catch { Darwin.close(descriptor)
            throw error
        }
    }

    private static func catalogWitness(_ path: URL) throws -> String? {
        try privateDirectory(path.deletingLastPathComponent())
        let fd = Darwin.open(path.path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
        if fd < 0 {
            if errno == ENOENT { return nil }
            throw Failure.unsafeRecord
        }
        let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
        defer { try? handle.close() }
        var before = stat(), after = stat(), published = stat()
        guard fstat(fd, &before) == 0, validFile(before), before.st_size >= 0,
              before.st_size <= 16 * 1024 * 1024 else { throw Failure.unsafeRecord }
        let bytes = try handle.read(upToCount: Int(before.st_size) + 1) ?? Data()
        guard bytes.count == Int(before.st_size), fstat(fd, &after) == 0, lstat(path.path, &published) == 0,
              after.st_dev == before.st_dev, after.st_ino == before.st_ino, after.st_size == before.st_size,
              after.st_mtimespec.tv_sec == before.st_mtimespec.tv_sec, after.st_mtimespec.tv_nsec == before.st_mtimespec.tv_nsec,
              after.st_ctimespec.tv_sec == before.st_ctimespec.tv_sec, after.st_ctimespec.tv_nsec == before.st_ctimespec.tv_nsec,
              published.st_dev == before.st_dev, published.st_ino == before.st_ino, validFile(published) else { throw Failure.unsafeRecord }
        return digest(bytes)
    }

    /// FD7 is reserved in every operation worker's stdio mapping; other consumers reacquire SH.
    public func prepareEnvironment(_ environment: [String: String]) throws -> [String: String] {
        if descriptor != Self.inheritedDescriptor {
            guard dup2(descriptor, Self.inheritedDescriptor) == Self.inheritedDescriptor else { throw Failure.unsafeRecord }
        }
        let flags = fcntl(Self.inheritedDescriptor, F_GETFD)
        guard flags >= 0, fcntl(Self.inheritedDescriptor, F_SETFD, flags & ~FD_CLOEXEC) == 0 else {
            throw Failure.unsafeRecord
        }
        var result = environment
        result["OMNESIS_DESKTOP_DATA_CONTEXT"] = try Self.base64(JSONEncoder().encode(context))
        return result
    }

    public static func consumerScope(environment: [String: String], arguments: [String]) throws -> Scope? {
        if let context = environment["OMNESIS_DESKTOP_DATA_CONTEXT"] {
            guard context.utf8.count <= 16384, let bytes = unbase64(context),
                  let parsed = try? JSONDecoder().decode(Context.self, from: bytes), parsed.exclusive == nil else {
                throw Failure.missingAuthority
            }
            return parsed.scope
        }
        guard environment["OMNESIS_DESKTOP_MANAGED"] == "1",
              let configDir = environment["OMNESIS_CONFIG_DIR"],
              let instance = environment["OMNESIS_SERVICE_INSTANCE"],
              let service = environment["OMNESIS_SECRET_SERVICE"] else { return nil }
        var activation: Activation?
        if let flag = arguments.firstIndex(of: "--restore-start") {
            guard flag + 1 < arguments.count, arguments[flag + 1].utf8.count <= 4096 else { throw Failure.invalidScope }
            activation = try JSONDecoder().decode(Activation.self, from: Data(arguments[flag + 1].utf8))
        }
        return Scope(configDir: configDir, instance: instance, secretService: service, restoreActivation: activation)
    }

    private init(descriptor: Int32, context: Context) {
        self.descriptor = descriptor
        self.context = context
    }

    private static func lockURL(_ scope: Scope) -> URL {
        URL(fileURLWithPath: scope.configDir + ".bootstrap", isDirectory: true)
            .appendingPathComponent(".data-use-" + String(scope.secretService.suffix(64)) + ".lock")
    }

    private static func validateProfile(_ scope: Scope) throws {
        guard scope.format == 1 else { throw Failure.invalidScope }
        let root = URL(fileURLWithPath: scope.configDir, isDirectory: true)
        guard root.path.hasPrefix("/"), root.path == scope.configDir,
              try (DesktopCanonicalPath.resolve(scope.configDir, allowMissing: true)) == scope.configDir else { throw Failure.invalidScope }
        let parent = URL(fileURLWithPath: scope.configDir + ".bootstrap", isDirectory: true)
        try privateDirectory(parent)
        let generation = try record(parent.appendingPathComponent("generation.json"))
        var material = Data(scope.configDir.utf8)
        if let generation {
            guard generation["version"] as? Int == 1, generation["owner"] as? String == "omnesis-desktop",
                  generation["configIdentity"] as? String == digest(Data(scope.configDir.utf8)),
                  let value = generation["generation"] as? String, validUUID(value) else { throw Failure.invalidScope }
            material.append(0)
            material.append(contentsOf: value.utf8)
        }
        let identity = digest(material)
        guard scope.instance == "desktop-" + String(identity.prefix(16)),
              scope.secretService == "dev.omnesis.desktop." + identity else { throw Failure.invalidScope }
    }

    /// Metadata-only absence checks expose no root key and do not open retired corpus files.
    public static func validateKeychainMetadata(
        _ current: Scope,
        account: String,
        service: String,
        proposedGeneration: String? = nil
    ) throws {
        try validateProfile(current)
        var scope = current
        if let proposedGeneration {
            guard validUUID(proposedGeneration),
                  let retired = try record(URL(fileURLWithPath: current.configDir + ".bootstrap/retirement.json")),
                  bound(retired, current), retired["mode"] as? String == "erase-data",
                  retired["phase"] as? String == "complete" else { throw Failure.blocked }
            var info = stat()
            guard lstat(current.configDir, &info) != 0, errno == ENOENT else { throw Failure.blocked }
            var material = Data(current.configDir.utf8)
            material.append(0)
            material.append(contentsOf: proposedGeneration.utf8)
            let identity = digest(material)
            scope = Scope(
                configDir: current.configDir,
                instance: "desktop-" + String(identity.prefix(16)),
                secretService: "dev.omnesis.desktop." + identity
            )
        }
        if service == scope.secretService {
            guard isKeychainRead(scope, account: account) else { throw Failure.invalidScope }
            return
        }
        guard service == "Codex Auth" else { throw Failure.invalidScope }
        let base = URL(fileURLWithPath: scope.configDir, isDirectory: true).appendingPathComponent("codex-home", isDirectory: true)
        let homes = [base, base.appendingPathComponent(scope.instance, isDirectory: true)]
        guard homes.contains(where: { path in
            (try? DesktopCanonicalPath.resolve(path.path, allowMissing: true)) == path.path &&
                account == "cli|" + String(digest(Data(path.path.utf8)).prefix(16))
        }) else { throw Failure.invalidScope }
    }

    public static func isKeychainRead(_ scope: Scope, account: String) -> Bool {
        let suffix = Data(SHA256.hash(data: Data(scope.configDir.utf8))).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
        return account == "install-root-key-v1" ||
            ["storage-encryption-state-v1:", "secret-files-state-v1:"].contains { account == $0 + String(suffix.prefix(12)) }
    }

    private static func validateConsumer(_ scope: Scope, epoch: String, keychainSetup: Bool, keychainRead: Bool) throws {
        let root = URL(fileURLWithPath: scope.configDir, isDirectory: true)
        if keychainRead {
            // Fixed root/mirror reads are short SH consumers during recovery. They
            // confer neither corpus-write nor vendor-process startup authority.
            var info = stat()
            if lstat(root.path, &info) == 0 { try privateDirectory(root) }
            else if errno != ENOENT { throw Failure.unsafeRecord }
            return
        }
        try privateDirectory(root)
        guard let install = try record(root.appendingPathComponent("desktop-install.json")),
              bound(install, scope), let phase = install["phase"] as? String,
              phase == "configured" || (keychainSetup && ["claimed", "protected"].contains(phase)) else { throw Failure.blocked }
        let parent = URL(fileURLWithPath: scope.configDir + ".bootstrap", isDirectory: true)
        if let retired = try record(parent.appendingPathComponent("retirement.json")) {
            guard !bound(retired, scope), retired["phase"] as? String == "complete",
                  retired["mode"] as? String == "erase-data",
                  let generation = try record(parent.appendingPathComponent("generation.json")),
                  let previous = generation["previous"] as? [String: String],
                  previous["instance"] == retired["instance"] as? String,
                  previous["secretService"] == retired["secretService"] as? String,
                  previous["retirementId"] == retired["operationId"] as? String else { throw Failure.blocked }
        }
        if let update = try record(parent.appendingPathComponent("update.json")) {
            guard bound(update, scope), let phase = update["phase"] as? String else { throw Failure.blocked }
            let expected: String? = switch phase {
            case "verified", "resumed": update["oldEpoch"] as? String
            case "candidate-started", "complete": update["candidateEpoch"] as? String
            default: nil
            }
            guard expected == epoch else { throw Failure.blocked }
        }
        if let restore = try record(parent.appendingPathComponent("restore.json")) {
            guard bound(restore, scope), let phase = restore["phase"] as? String else { throw Failure.blocked }
            if !["complete", "rolled-back"].contains(phase) {
                guard phase == "starting", let requested = scope.restoreActivation,
                      restore["operationId"] as? String == requested.operationId,
                      let active = restore["activation"] as? [String: Any],
                      active["attemptId"] as? String == requested.attemptId,
                      active["epoch"] as? String == epoch, requested.epoch == epoch,
                      active["claimed"] as? Bool == true else { throw Failure.blocked }
            }
        }
    }

    public static func requireProcessAuthority(_ scope: Scope) throws {
        try validateProfile(scope)
        let path = URL(fileURLWithPath: scope.configDir + ".bootstrap/process-authority.json")
        guard let authority = try record(path), authority.count == 4, authority["version"] as? Int == 3,
              authority["owner"] as? String == "omnesis-desktop", authority["instance"] as? String == scope.instance,
              authority["secretService"] as? String == scope.secretService else { throw Failure.legacyUnverified }
        if let journal = try record(URL(fileURLWithPath: scope.configDir).appendingPathComponent("desktop-install.json")) {
            guard bound(journal, scope), journal["processAuthorityVersion"] as? Int == 3 else { throw Failure.legacyUnverified }
        }
    }

    private static func validateOperation(_ scope: Scope, _ operation: Operation) throws {
        try requireProcessAuthority(scope)
        let update = operation.purpose == .updateSnapshot || operation.purpose == .updateRollback
        let name = operation.purpose == .erase ? "retirement.json" : (update ? "update.json" : "restore.json")
        let path = URL(fileURLWithPath: scope.configDir + ".bootstrap", isDirectory: true).appendingPathComponent(name)
        guard let intent = try record(path), bound(intent, scope),
              intent["operationId"] as? String == operation.operationId,
              let phase = intent["phase"] as? String else { throw Failure.blocked }
        if operation.purpose == .erase {
            guard intent["mode"] as? String == "erase-data",
                  ["requested", "stopped", "dataRemoved", "keyCleanupPending"].contains(phase) else { throw Failure.blocked }
        } else if operation.purpose == .updateSnapshot {
            guard phase == "stopping" else { throw Failure.blocked }
        } else if operation.purpose == .updateRollback {
            guard phase == "recovery-required" else { throw Failure.blocked }
        } else if operation.purpose == .restore {
            guard phase == "stopping" else { throw Failure.blocked }
        } else {
            guard phase == "starting" || [
                "stopping",
                "backed-up",
                "staged",
                "publishing",
                "published",
                "verifying",
                "committed",
                "rolling-back",
                "recovery-required",
            ].contains(phase) else {
                throw Failure.blocked
            }
        }
        guard let expected = intent["root"] as? [String: String], let device = expected["device"], let inode = expected["inode"] else {
            throw Failure.invalidScope
        }
        var info = stat()
        if lstat(scope.configDir, &info) == 0 {
            try privateDirectory(URL(fileURLWithPath: scope.configDir, isDirectory: true))
            guard String(info.st_dev) == device, String(info.st_ino) == inode else { throw Failure.blocked }
        } else if errno != ENOENT || operation.purpose != .erase || !["dataRemoved", "keyCleanupPending"].contains(phase) {
            throw Failure.blocked
        }
    }

    private static func bound(_ value: [String: Any], _ scope: Scope) -> Bool {
        ((value["version"] as? Int == 1) || (value["format"] as? Int == 1)) && value["owner"] as? String == "omnesis-desktop" &&
            value["instance"] as? String == scope.instance && value["secretService"] as? String == scope.secretService
    }

    private static func privateDirectory(_ path: URL) throws {
        var info = stat()
        guard lstat(path.path, &info) == 0, info.st_mode & S_IFMT == S_IFDIR, info.st_uid == getuid(),
              info.st_mode & 0o077 == 0, try (DesktopCanonicalPath.resolve(path.path)) == path.path else {
            throw Failure.unsafeRecord
        }
    }

    private static func validFile(_ info: stat) -> Bool {
        info.st_mode & S_IFMT == S_IFREG && info.st_uid == getuid() && info.st_mode & 0o077 == 0 && info.st_nlink == 1
    }

    private static func record(_ path: URL) throws -> [String: Any]? {
        let fd = Darwin.open(path.path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK)
        if fd < 0 { if errno == ENOENT { return nil }
            throw Failure.unsafeRecord
        }
        let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
        defer { try? handle.close() }
        var info = stat()
        guard fstat(fd, &info) == 0, validFile(info), info.st_size > 0, info.st_size <= 16384,
              let data = try handle.read(upToCount: 16385), data.count == Int(info.st_size),
              let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw Failure.unsafeRecord }
        return object
    }

    private static func digest(_ value: Data) -> String {
        SHA256.hash(data: value).map { String(format: "%02x", $0) }.joined()
    }

    private static func validUUID(_ value: String) -> Bool {
        UUID(uuidString: value) != nil && value.lowercased() == value
    }

    private static func unbase64(_ value: String) -> Data? {
        let string = value.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        return Data(base64Encoded: string + String(repeating: "=", count: (4 - string.count % 4) % 4))
    }

    private static func base64(_ value: Data) -> String {
        value.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(
            of: "=",
            with: ""
        )
    }
}
