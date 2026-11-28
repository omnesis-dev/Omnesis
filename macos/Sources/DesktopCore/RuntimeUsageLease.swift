// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import CryptoKit
import Darwin
import Foundation

/// The native adapter retains this kernel lease across exec, so the actual Node/native child owns it.
/// The publication lock serializes process-start reservations with immutable epoch garbage collection.
public final class DesktopRuntimeUsageLease: @unchecked Sendable {
    public enum Failure: Error { case invalidPayload, unsafeLock, unsupportedInvocation, cannotExecute }
    private struct Manifest: Decodable {
        let format: Int
        let codeUsageProtocol: Int?
        let runtimeLauncher: String?
        let dataUsageProtocol: Int?
        let processAuthorityProtocol: Int?
        let inventory: [Entry]
    }

    private struct Entry: Decodable {
        let path: String
        let executable: Bool?
        let symlink: String?
    }

    public struct Invocation {
        public let executable: URL
        public let arguments: [String]
    }

    private let descriptor: Int32
    private let runtime: URL
    public var runtimeURL: URL {
        runtime
    }

    private let executables: Set<String>
    public let requiresDataUsage: Bool
    deinit { Darwin.close(descriptor) }

    public final class LegacyDataReservation {
        private let descriptors: [Int32]
        fileprivate init(_ descriptors: [Int32]) {
            self.descriptors = descriptors
        }

        deinit { for descriptor in descriptors {
            Darwin.close(descriptor)
        } }
        public func inheritAcrossExec() throws {
            for descriptor in descriptors {
                let flags = fcntl(descriptor, F_GETFD)
                guard flags >= 0, fcntl(descriptor, F_SETFD, flags & ~FD_CLOEXEC) == 0 else { throw Failure.unsafeLock }
            }
        }
    }

    /// Only certified runtime revisions may prove descendant membership through kernel leases.
    /// Unknown older SDK launchers dropped descriptors, so apparent inactivity is never authority.
    public static func reserveLegacyDataConsumers(cache: URL) throws -> LegacyDataReservation {
        let publication = try openLock(cache.appendingPathComponent(".publication-lock"))
        defer { Darwin.close(publication) }
        try DesktopRuntimePublicationLock.acquire(publication, mode: .shared)
        var held: [Int32] = []
        do {
            for name in try FileManager.default.contentsOfDirectory(atPath: cache.path).sorted()
                where name.count == 64 && name.allSatisfy({ "0123456789abcdef".contains($0) }) {
                let runtime = cache.appendingPathComponent(name, isDirectory: true)
                let manifest = try validatedManifest(runtime)
                guard manifest.processAuthorityProtocol == 3 else { throw Failure.unsafeLock }
                if manifest.dataUsageProtocol == 1 { continue }
                let descriptor = try openLock(cache.appendingPathComponent(".usage-" + name + ".lock"))
                guard flock(descriptor, LOCK_EX | LOCK_NB) == 0 else {
                    Darwin.close(descriptor)
                    throw Failure.unsafeLock
                }
                held.append(descriptor)
            }
            return LegacyDataReservation(held)
        } catch {
            for descriptor in held {
                Darwin.close(descriptor)
            }
            throw error
        }
    }

    public static func acquire(runtime: URL) throws -> DesktopRuntimeUsageLease {
        let epoch = runtime.lastPathComponent
        guard epoch.count == 64, epoch.allSatisfy({ $0.isHexDigit && !$0.isUppercase }),
              (try? DesktopCanonicalPath.resolve(runtime.path)) == runtime.path else {
            throw Failure.invalidPayload
        }
        let cache = runtime.deletingLastPathComponent()
        let metadata = try FileManager.default.attributesOfItem(atPath: cache.path)
        guard metadata[.type] as? FileAttributeType == .typeDirectory,
              (metadata[.ownerAccountID] as? NSNumber)?.uint32Value == getuid(),
              ((metadata[.posixPermissions] as? NSNumber)?.intValue ?? 0) & 0o077 == 0,
              (try? DesktopCanonicalPath.resolve(cache.path)) == cache.path else {
            throw Failure.unsafeLock
        }
        let publication = try openLock(cache.appendingPathComponent(".publication-lock"))
        defer { Darwin.close(publication) }
        try DesktopRuntimePublicationLock.acquire(publication, mode: .shared)
        // A static launcher may survive deletion of its executable inode, but must never load Node
        // or any payload file until this reservation is held and the epoch still exists.
        guard case nil = try readCleanupReceipt(cache.appendingPathComponent(".cleanup-" + epoch + ".json")) else {
            throw Failure.invalidPayload
        }
        let manifest = try validatedManifest(runtime)
        guard manifest.processAuthorityProtocol == 3 else { throw Failure.invalidPayload }
        let executables = Set(manifest.inventory.filter { $0.executable == true && $0.symlink == nil }.map(\.path))
        let descriptor = try openLock(cache.appendingPathComponent(".usage-" + epoch + ".lock"))
        do {
            guard flock(descriptor, LOCK_SH) == 0 else { throw Failure.unsafeLock }
            return DesktopRuntimeUsageLease(
                descriptor: descriptor,
                runtime: runtime,
                executables: executables,
                requiresDataUsage: manifest.dataUsageProtocol == 1
            )
        } catch { Darwin.close(descriptor)
            throw error
        }
    }

    /// The closure runs while publication and target usage are both exclusively reserved.
    /// Returning nil means legacy/uncertain or in-use, never permission to delete later.
    public static func withReclaimableEpoch<T>(
        cache: URL,
        epoch: String,
        currentEpoch: String,
        operation: (URL) throws -> T
    ) throws
        -> T? {
        guard epoch != currentEpoch, epoch.count == 64,
              epoch.allSatisfy({ $0.isHexDigit && !$0.isUppercase }),
              (try? DesktopCanonicalPath.resolve(cache.path)) == cache.path else { return nil }
        let publication = try openLock(cache.appendingPathComponent(".publication-lock"))
        defer { Darwin.close(publication) }
        try DesktopRuntimePublicationLock.acquire(publication)
        let runtime = cache.appendingPathComponent(epoch, isDirectory: true)
        guard !hasPendingApplicationLaunch(cache: cache, epoch: epoch),
              !DesktopSnapshotGcLease.blocksReclamation(cache: cache, epoch: epoch) else { return nil }
        guard case nil = try readCleanupReceipt(cache.appendingPathComponent(".cleanup-" + epoch + ".json")),
              (try? validatedManifest(runtime))?.processAuthorityProtocol == 3 else { return nil }
        let usage = try openLock(cache.appendingPathComponent(".usage-" + epoch + ".lock"))
        defer { Darwin.close(usage) }
        guard flock(usage, LOCK_EX | LOCK_NB) == 0 else { return nil }
        return try operation(runtime)
    }

    private struct CleanupReceipt: Codable {
        let format: Int
        let processAuthorityProtocol: Int
        let owner: String
        let epoch: String
        let device: UInt64
        let inode: UInt64
        let archive: DesktopApplicationArchiveOwnership.Identity?
    }

    /// Deletes code only. Callers must first exclude active/current/recovery epochs from their plan.
    /// The durable receipt permits retry after a partial recursive deletion removed the manifest.
    /// Both locks remain held throughout deletion, including retries; a probe is never authority.
    public static func removeReclaimableRuntime(
        cache: URL,
        epoch: String,
        currentEpoch: String
    ) throws
        -> Bool {
        try removeReclaimableRuntime(cache: cache, epoch: epoch, currentEpoch: currentEpoch) {
            try FileManager.default.removeItem(at: $0)
        }
    }

    static func removeReclaimableRuntime(
        cache: URL,
        epoch: String,
        currentEpoch: String,
        remove: (URL) throws -> Void
    ) throws
        -> Bool {
        guard epoch != currentEpoch, epoch.count == 64,
              epoch.allSatisfy({ "0123456789abcdef".contains($0) }),
              (try? DesktopCanonicalPath.resolve(cache.path)) == cache.path else { return false }
        let attributes = try FileManager.default.attributesOfItem(atPath: cache.path)
        guard attributes[.type] as? FileAttributeType == .typeDirectory,
              (attributes[.ownerAccountID] as? NSNumber)?.uint32Value == getuid(),
              ((attributes[.posixPermissions] as? NSNumber)?.intValue ?? 0) & 0o077 == 0 else {
            throw Failure.unsafeLock
        }
        let publication = try openLock(cache.appendingPathComponent(".publication-lock"))
        defer { Darwin.close(publication) }
        try DesktopRuntimePublicationLock.acquire(publication)
        let usage = try openLock(cache.appendingPathComponent(".usage-" + epoch + ".lock"))
        defer { Darwin.close(usage) }
        guard flock(usage, LOCK_EX | LOCK_NB) == 0 else { return false }
        let runtime = cache.appendingPathComponent(epoch, isDirectory: true)
        guard !hasPendingApplicationLaunch(cache: cache, epoch: epoch),
              !DesktopSnapshotGcLease.blocksReclamation(cache: cache, epoch: epoch) else { return false }
        let receiptPath = cache.appendingPathComponent(".cleanup-" + epoch + ".json")
        let receipt = try readCleanupReceipt(receiptPath)
        let applications = cache.deletingLastPathComponent().appendingPathComponent("applications", isDirectory: true)
        let archive = applications.appendingPathComponent(epoch, isDirectory: true)
        var runtimeInfo = stat(), archiveInfo = stat(), parentInfo = stat()
        let runtimeExists = lstat(runtime.path, &runtimeInfo) == 0
        if !runtimeExists, errno != ENOENT { throw Failure.unsafeLock }
        let archiveExists = lstat(archive.path, &archiveInfo) == 0
        if !archiveExists, errno != ENOENT { throw Failure.unsafeLock }
        if archiveExists {
            guard (try? DesktopCanonicalPath.resolve(applications.path)) == applications.path,
                  lstat(applications.path, &parentInfo) == 0, parentInfo.st_mode & S_IFMT == S_IFDIR,
                  parentInfo.st_uid == getuid(), parentInfo.st_mode & 0o077 == 0,
                  archiveInfo.st_mode & S_IFMT == S_IFDIR, archiveInfo.st_uid == getuid(),
                  archiveInfo.st_mode & 0o077 == 0 else { return false }
        }
        if runtimeExists {
            guard runtimeInfo.st_mode & S_IFMT == S_IFDIR, runtimeInfo.st_uid == getuid(),
                  (try? DesktopCanonicalPath.resolve(runtime.path)) == runtime.path else { return false }
        }
        if let receipt {
            guard receipt.epoch == epoch else { throw Failure.invalidPayload }
            if runtimeExists {
                guard receipt.device == UInt64(runtimeInfo.st_dev), receipt.inode == UInt64(runtimeInfo.st_ino) else {
                    throw Failure.invalidPayload
                }
            }
            if archiveExists {
                guard let identity = receipt.archive,
                      identity.device == UInt64(archiveInfo.st_dev), identity.inode == UInt64(archiveInfo.st_ino) else {
                    throw Failure.invalidPayload
                }
            }
        } else {
            guard runtimeExists, (try? validatedManifest(runtime))?.processAuthorityProtocol == 3 else { return false }
            let identity: DesktopApplicationArchiveOwnership.Identity?
            if archiveExists {
                guard let verified = try? DesktopApplicationArchiveOwnership.verified(directory: archive, epoch: epoch)
                else { return false }
                identity = verified
            } else { identity = nil }
            let value = CleanupReceipt(
                format: 3,
                processAuthorityProtocol: 3,
                owner: "omnesis-desktop-runtime-cleanup",
                epoch: epoch,
                device: UInt64(runtimeInfo.st_dev),
                inode: UInt64(runtimeInfo.st_ino),
                archive: identity
            )
            let temporary = cache.appendingPathComponent(".pending-cleanup-" + UUID().uuidString)
            let descriptor = Darwin.open(temporary.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
            guard descriptor >= 0 else { throw Failure.unsafeLock }
            let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
            defer {
                try? handle.close()
                _ = unlink(temporary.path)
            }
            try handle.write(contentsOf: JSONEncoder().encode(value))
            try handle.synchronize()
            try FileManager.default.moveItem(at: temporary, to: receiptPath)
            try DesktopApplicationArchiveOwnership.syncDirectory(cache)
        }
        // Both directory identities are committed before deleting either. Partial deletion retains
        // the receipt, which blocks startup and authorizes only those same original directory inodes.
        if archiveExists {
            try remove(archive)
            guard lstat(archive.path, &archiveInfo) != 0, errno == ENOENT else { throw Failure.invalidPayload }
            try DesktopApplicationArchiveOwnership.syncDirectory(applications)
        }
        if runtimeExists {
            try remove(runtime)
            guard lstat(runtime.path, &runtimeInfo) != 0, errno == ENOENT else { throw Failure.invalidPayload }
            try DesktopApplicationArchiveOwnership.syncDirectory(cache)
        }
        try FileManager.default.removeItem(at: receiptPath)
        try DesktopApplicationArchiveOwnership.syncDirectory(cache)
        return true
    }

    private static func readCleanupReceipt(_ path: URL) throws -> CleanupReceipt? {
        let descriptor = Darwin.open(path.path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK)
        if descriptor < 0 {
            if errno == ENOENT { return nil }
            throw Failure.unsafeLock
        }
        let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
        defer { try? handle.close() }
        var info = stat()
        guard fstat(descriptor, &info) == 0, info.st_mode & S_IFMT == S_IFREG,
              info.st_uid == getuid(), info.st_mode & 0o077 == 0, info.st_nlink == 1,
              info.st_size > 0, info.st_size <= 4096,
              let data = try handle.read(upToCount: 4097), data.count <= 4096 else { throw Failure.unsafeLock }
        let receipt = try JSONDecoder().decode(CleanupReceipt.self, from: data)
        guard receipt.format == 3, receipt.processAuthorityProtocol == 3,
              receipt.owner == "omnesis-desktop-runtime-cleanup" else { throw Failure.invalidPayload }
        return receipt
    }

    /// Reservation creation shares publication EX, closing retained-app launch versus GC races.
    /// A malformed/uncertain private reservation refuses cleanup rather than inferring absence.
    private static func hasPendingApplicationLaunch(cache: URL, epoch: String) -> Bool {
        let applications = cache.deletingLastPathComponent().appendingPathComponent("applications", isDirectory: true)
        let directory = applications.appendingPathComponent(".launch-reservations", isDirectory: true)
        var info = stat()
        guard lstat(directory.path, &info) == 0 else { return errno != ENOENT }
        guard info.st_mode & S_IFMT == S_IFDIR, info.st_uid == getuid(), info.st_mode & 0o077 == 0,
              (try? DesktopCanonicalPath.resolve(directory.path)) == directory.path,
              let entries = try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil),
              entries.count <= 256 else { return true }
        for entry in entries {
            guard entry.pathExtension == "json",
                  UUID(uuidString: entry.deletingPathExtension().lastPathComponent) != nil else { return true }
            let descriptor = Darwin.open(entry.path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK)
            guard descriptor >= 0 else { return true }
            let file = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
            defer { try? file.close() }
            guard fstat(descriptor, &info) == 0, info.st_mode & S_IFMT == S_IFREG,
                  info.st_uid == getuid(), info.st_mode & 0o077 == 0, info.st_nlink == 1,
                  info.st_size > 0, info.st_size <= 16 * 1024,
                  let data = try? file.read(upToCount: 16 * 1024 + 1), data.count <= 16 * 1024,
                  let value = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any], value.count == 4,
                  value["format"] as? Int == 1, value["owner"] as? String == "omnesis-desktop-application-launch",
                  let reserved = value["epoch"] as? String, reserved.count == 64,
                  reserved.allSatisfy({ "0123456789abcdef".contains($0) }),
                  let application = value["application"] as? String,
                  application == applications.appendingPathComponent(reserved).appendingPathComponent("Omnesis.app").path
            else { return true }
            if reserved == epoch { return true }
        }
        return false
    }

    private static func validatedManifest(_ runtime: URL) throws -> Manifest {
        let epoch = runtime.lastPathComponent
        guard (try? DesktopCanonicalPath.resolve(runtime.path)) == runtime.path else { throw Failure.invalidPayload }
        let inventoryDescriptor = Darwin.open(
            runtime.appendingPathComponent("desktop-runtime.json").path,
            O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK
        )
        guard inventoryDescriptor >= 0 else { throw Failure.invalidPayload }
        var metadata = stat()
        guard fstat(inventoryDescriptor, &metadata) == 0, metadata.st_mode & S_IFMT == S_IFREG,
              metadata.st_size > 0, metadata.st_size <= 32 * 1024 * 1024 else {
            Darwin.close(inventoryDescriptor)
            throw Failure.invalidPayload
        }
        let file = FileHandle(fileDescriptor: inventoryDescriptor, closeOnDealloc: true)
        let bytes: Data
        defer { try? file.close() }
        guard let data = try file.read(upToCount: 32 * 1024 * 1024 + 1), data.count <= 32 * 1024 * 1024 else {
            throw Failure.invalidPayload
        }
        bytes = data
        guard SHA256.hash(data: bytes).map({ String(format: "%02x", $0) }).joined() == epoch else {
            throw Failure.invalidPayload
        }
        let manifest = try JSONDecoder().decode(Manifest.self, from: bytes)
        guard manifest.format == 1, manifest.codeUsageProtocol == 1, manifest.runtimeLauncher == "runtime-exec",
              manifest.dataUsageProtocol == nil || manifest.dataUsageProtocol == 1 else {
            throw Failure.invalidPayload
        }
        let names = Set(manifest.inventory.filter { $0.executable == true && $0.symlink == nil }.map(\.path))
        guard names.contains("node"), names.contains("runtime-exec") else { throw Failure.invalidPayload }
        return manifest
    }

    private init(descriptor: Int32, runtime: URL, executables: Set<String>, requiresDataUsage: Bool) {
        self.descriptor = descriptor
        self.runtime = runtime
        self.executables = executables
        self.requiresDataUsage = requiresDataUsage
    }

    public func invocation(arguments: [String]) throws -> Invocation {
        guard let mode = arguments.first else { throw Failure.unsupportedInvocation }
        if mode == "--node" {
            let preload = runtime.appendingPathComponent("packages/core/dist/managed-runtime-bootstrap.js")
            guard FileManager.default.fileExists(atPath: preload.path) else { throw Failure.invalidPayload }
            return try Invocation(
                executable: checkedExecutable("node"),
                arguments: ["--use-system-ca", "--import", preload.absoluteString] + Array(arguments.dropFirst())
            )
        }
        if mode == "--exec", arguments.count >= 2, arguments[1] != "node" {
            return try Invocation(executable: checkedExecutable(arguments[1]), arguments: Array(arguments.dropFirst(2)))
        }
        if mode == "--external", arguments.count >= 2 {
            let command = arguments[1]
            guard !command.isEmpty, !command.contains("\0") else { throw Failure.unsupportedInvocation }
            let candidates: [URL] = if command.contains("/") {
                [
                    URL(
                        fileURLWithPath: command,
                        relativeTo: URL(fileURLWithPath: FileManager.default.currentDirectoryPath, isDirectory: true)
                    ),
                ]
            } else {
                (ProcessInfo.processInfo.environment["PATH"] ?? "").split(separator: ":", omittingEmptySubsequences: false).map {
                    URL(fileURLWithPath: $0.isEmpty ? FileManager.default.currentDirectoryPath : String($0)).appendingPathComponent(command)
                }
            }
            guard let selected = candidates.first(where: { FileManager.default.isExecutableFile(atPath: $0.path) }) else {
                throw Failure.cannotExecute
            }
            let executable = try URL(fileURLWithPath: DesktopCanonicalPath.resolve(selected.path))
            let parent = runtime.pathComponents
            let components = executable.pathComponents
            let args = Array(arguments.dropFirst(2))
            if components.count > parent.count, Array(components.prefix(parent.count)) == parent {
                let relative = components.dropFirst(parent.count).joined(separator: "/")
                if relative == "node" { return try invocation(arguments: ["--node"] + args) }
                return try Invocation(executable: checkedExecutable(relative), arguments: args)
            }
            var info = stat()
            guard lstat(executable.path, &info) == 0, info.st_mode & S_IFMT == S_IFREG else { throw Failure.cannotExecute }
            return Invocation(executable: executable, arguments: args)
        }
        throw Failure.unsupportedInvocation
    }

    /// FD_CLOEXEC must be removed only after validation and immediately before exec.
    public func inheritAcrossExec() throws {
        let flags = fcntl(descriptor, F_GETFD)
        guard flags >= 0, fcntl(descriptor, F_SETFD, flags & ~FD_CLOEXEC) == 0 else { throw Failure.unsafeLock }
    }

    private func checkedExecutable(_ path: String) throws -> URL {
        guard !path.isEmpty, !path.contains("\0"), !path.contains("\\"),
              path.split(separator: "/", omittingEmptySubsequences: false).allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." }),
              path != "runtime-exec", executables.contains(path) else { throw Failure.unsupportedInvocation }
        let target = runtime.appendingPathComponent(path)
        guard (try? DesktopCanonicalPath.resolve(target.path)) == target.path,
              FileManager.default.isExecutableFile(atPath: target.path) else { throw Failure.invalidPayload }
        return target
    }

    private static func openLock(_ path: URL) throws -> Int32 {
        var descriptor = Darwin.open(path.path, O_RDWR | O_CREAT | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK, S_IRUSR | S_IWUSR)
        guard descriptor >= 0 else { throw Failure.unsafeLock }
        // FD7 belongs to per-profile data authority and must never replace this code lease.
        if descriptor == DesktopDataUsageLease.inheritedDescriptor {
            let replacement = fcntl(descriptor, F_DUPFD_CLOEXEC, 8)
            Darwin.close(descriptor)
            guard replacement >= 0 else { throw Failure.unsafeLock }
            descriptor = replacement
        }
        var metadata = stat()
        guard fstat(descriptor, &metadata) == 0, metadata.st_mode & S_IFMT == S_IFREG,
              metadata.st_uid == getuid(), metadata.st_mode & 0o077 == 0, metadata.st_nlink == 1 else {
            Darwin.close(descriptor)
            throw Failure.unsafeLock
        }
        return descriptor
    }

    public func execute(_ invocation: Invocation, environment: [String: String]) throws -> Never {
        try inheritAcrossExec()
        let strings = ([invocation.executable.path] + invocation.arguments).map { strdup($0) }
        let variables = environment.sorted(by: { $0.key < $1.key }).map { strdup($0.key + "=" + $0.value) }
        defer { for pointer in strings + variables {
            free(pointer)
        } }
        guard strings.allSatisfy({ $0 != nil }), variables.allSatisfy({ $0 != nil }) else { throw Failure.cannotExecute }
        var argv = strings + [nil], envp = variables + [nil]
        return try withExtendedLifetime(self) {
            argv.withUnsafeMutableBufferPointer { args in
                envp.withUnsafeMutableBufferPointer { env in
                    invocation.executable.path.withCString { path in _ = execve(path, args.baseAddress!, env.baseAddress!) }
                }
            }
            throw Failure.cannotExecute
        }
    }
}
