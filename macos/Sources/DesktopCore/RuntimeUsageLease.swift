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
    deinit { Darwin.close(descriptor) }

    public static func acquire(runtime: URL) throws -> DesktopRuntimeUsageLease {
        let epoch = runtime.lastPathComponent
        guard epoch.count == 64, epoch.allSatisfy({ $0.isHexDigit && !$0.isUppercase }),
              runtime.resolvingSymlinksInPath().path == runtime.standardizedFileURL.path else {
            throw Failure.invalidPayload
        }
        let cache = runtime.deletingLastPathComponent()
        let metadata = try FileManager.default.attributesOfItem(atPath: cache.path)
        guard metadata[.type] as? FileAttributeType == .typeDirectory,
              (metadata[.ownerAccountID] as? NSNumber)?.uint32Value == getuid(),
              ((metadata[.posixPermissions] as? NSNumber)?.intValue ?? 0) & 0o077 == 0,
              cache.resolvingSymlinksInPath().path == cache.standardizedFileURL.path else {
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
        let executables = Set(manifest.inventory.filter { $0.executable == true && $0.symlink == nil }.map(\.path))
        let descriptor = try openLock(cache.appendingPathComponent(".usage-" + epoch + ".lock"))
        do {
            guard flock(descriptor, LOCK_SH) == 0 else { throw Failure.unsafeLock }
            return DesktopRuntimeUsageLease(descriptor: descriptor, runtime: runtime, executables: executables)
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
              cache.resolvingSymlinksInPath().path == cache.standardizedFileURL.path else { return nil }
        let publication = try openLock(cache.appendingPathComponent(".publication-lock"))
        defer { Darwin.close(publication) }
        try DesktopRuntimePublicationLock.acquire(publication)
        let runtime = cache.appendingPathComponent(epoch, isDirectory: true)
        guard !hasPendingApplicationLaunch(cache: cache, epoch: epoch) else { return nil }
        guard case nil = try readCleanupReceipt(cache.appendingPathComponent(".cleanup-" + epoch + ".json")),
              (try? validatedManifest(runtime)) != nil else { return nil }
        let usage = try openLock(cache.appendingPathComponent(".usage-" + epoch + ".lock"))
        defer { Darwin.close(usage) }
        guard flock(usage, LOCK_EX | LOCK_NB) == 0 else { return nil }
        return try operation(runtime)
    }

    private struct CleanupReceipt: Codable {
        let format: Int
        let owner: String
        let epoch: String
        let device: UInt64
        let inode: UInt64
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
              cache.resolvingSymlinksInPath().path == cache.standardizedFileURL.path else { return false }
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
        guard !hasPendingApplicationLaunch(cache: cache, epoch: epoch) else { return false }
        let receiptPath = cache.appendingPathComponent(".cleanup-" + epoch + ".json")
        let receipt = try readCleanupReceipt(receiptPath)
        var info = stat()
        let exists = lstat(runtime.path, &info) == 0
        if !exists {
            guard errno == ENOENT, let receipt, receipt.epoch == epoch else { return false }
            try FileManager.default.removeItem(at: receiptPath)
            return true
        }
        guard info.st_mode & S_IFMT == S_IFDIR, info.st_uid == getuid(),
              runtime.resolvingSymlinksInPath().path == runtime.standardizedFileURL.path else { return false }
        if let receipt {
            guard receipt.epoch == epoch, receipt.device == UInt64(info.st_dev),
                  receipt.inode == UInt64(info.st_ino) else { throw Failure.invalidPayload }
        } else {
            guard (try? validatedManifest(runtime)) != nil else { return false }
            let value = CleanupReceipt(
                format: 1,
                owner: "omnesis-desktop-runtime-cleanup",
                epoch: epoch,
                device: UInt64(info.st_dev),
                inode: UInt64(info.st_ino)
            )
            let descriptor = Darwin.open(receiptPath.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
            guard descriptor >= 0 else { throw Failure.unsafeLock }
            let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
            defer { try? handle.close() }
            try handle.write(contentsOf: JSONEncoder().encode(value))
            try handle.synchronize()
            let directory = Darwin.open(cache.path, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW)
            guard directory >= 0 else { throw Failure.unsafeLock }
            defer { Darwin.close(directory) }
            guard fsync(directory) == 0 else { throw Failure.unsafeLock }
        }
        // A failed deletion deliberately retains the inode-bound receipt and excludes startup:
        // a missing/partial manifest cannot acquire a new usage lease.
        try remove(runtime)
        guard lstat(runtime.path, &info) != 0, errno == ENOENT else { throw Failure.invalidPayload }
        try FileManager.default.removeItem(at: receiptPath)
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
        guard receipt.format == 1, receipt.owner == "omnesis-desktop-runtime-cleanup" else { throw Failure.invalidPayload }
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
              directory.resolvingSymlinksInPath().path == directory.standardizedFileURL.path,
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
        guard runtime.resolvingSymlinksInPath().path == runtime.standardizedFileURL.path else { throw Failure.invalidPayload }
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
        guard manifest.format == 1, manifest.codeUsageProtocol == 1, manifest.runtimeLauncher == "runtime-exec" else {
            throw Failure.invalidPayload
        }
        let names = Set(manifest.inventory.filter { $0.executable == true && $0.symlink == nil }.map(\.path))
        guard names.contains("node"), names.contains("runtime-exec") else { throw Failure.invalidPayload }
        return manifest
    }

    private init(descriptor: Int32, runtime: URL, executables: Set<String>) {
        self.descriptor = descriptor
        self.runtime = runtime
        self.executables = executables
    }

    public func invocation(arguments: [String]) throws -> Invocation {
        guard let mode = arguments.first else { throw Failure.unsupportedInvocation }
        if mode == "--node" {
            let preload = runtime.appendingPathComponent("packages/core/dist/managed-runtime-bootstrap.js")
            guard FileManager.default.fileExists(atPath: preload.path) else { throw Failure.invalidPayload }
            return try Invocation(
                executable: checkedExecutable("node"),
                arguments: ["--import", preload.absoluteString] + Array(arguments.dropFirst())
            )
        }
        if mode == "--exec", arguments.count >= 2, arguments[1] != "node" {
            return try Invocation(executable: checkedExecutable(arguments[1]), arguments: Array(arguments.dropFirst(2)))
        }
        if mode == "--external", arguments.count >= 2 {
            let command = arguments[1]
            guard !command.isEmpty, !command.contains("\0") else { throw Failure.unsupportedInvocation }
            let candidates: [URL] = if command.contains("/") {
                [URL(
                    fileURLWithPath: command,
                    relativeTo: URL(fileURLWithPath: FileManager.default.currentDirectoryPath, isDirectory: true)
                )
                .standardizedFileURL]
            } else {
                (ProcessInfo.processInfo.environment["PATH"] ?? "").split(separator: ":", omittingEmptySubsequences: false).map {
                    URL(fileURLWithPath: $0.isEmpty ? FileManager.default.currentDirectoryPath : String($0)).appendingPathComponent(command)
                }
            }
            guard let selected = candidates.first(where: { FileManager.default.isExecutableFile(atPath: $0.path) }) else {
                throw Failure.cannotExecute
            }
            let executable = selected.resolvingSymlinksInPath().standardizedFileURL
            let parent = runtime.standardizedFileURL.pathComponents
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
        guard target.resolvingSymlinksInPath().path == target.standardizedFileURL.path,
              FileManager.default.isExecutableFile(atPath: target.path) else { throw Failure.invalidPayload }
        return target
    }

    private static func openLock(_ path: URL) throws -> Int32 {
        let descriptor = Darwin.open(path.path, O_RDWR | O_CREAT | O_NOFOLLOW | O_CLOEXEC, S_IRUSR | S_IWUSR)
        guard descriptor >= 0 else { throw Failure.unsafeLock }
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
