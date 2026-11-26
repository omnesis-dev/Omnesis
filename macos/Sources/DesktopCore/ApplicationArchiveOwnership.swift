// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Darwin
import Foundation

/// Created only after the complete app seal and runtime epoch have been verified under publication EX.
public enum DesktopApplicationArchiveOwnership {
    public struct Identity: Codable, Equatable {
        let device: UInt64
        let inode: UInt64
        let appDevice: UInt64
        let appInode: UInt64
    }

    private struct Receipt: Codable {
        let format: Int
        let owner: String
        let epoch: String
        let identity: Identity
    }

    static let filename = ".desktop-archive.json"

    static func publish(directory: URL, epoch: String) throws {
        let identity = try currentIdentity(directory)
        let receipt = Receipt(format: 1, owner: "omnesis-desktop-application-archive", epoch: epoch, identity: identity)
        let path = directory.appendingPathComponent(filename)
        if FileManager.default.fileExists(atPath: path.path) {
            guard try verified(directory: directory, epoch: epoch) == identity else {
                throw DesktopRuntimeUsageLease.Failure.invalidPayload
            }
            return
        }
        let temporary = directory.appendingPathComponent(".pending-archive-" + UUID().uuidString)
        let descriptor = Darwin.open(temporary.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard descriptor >= 0 else { throw DesktopRuntimeUsageLease.Failure.unsafeLock }
        let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
        defer {
            try? handle.close()
            _ = unlink(temporary.path)
        }
        try handle.write(contentsOf: JSONEncoder().encode(receipt))
        try handle.synchronize()
        // The shared publication EX lock excludes every cooperating publisher/collector.
        // Atomic same-directory publication leaves no half-written ownership record after a crash.
        try FileManager.default.moveItem(at: temporary, to: path)
        try syncDirectory(directory)
    }

    static func verified(directory: URL, epoch: String) throws -> Identity {
        let actual = try currentIdentity(directory)
        let descriptor = Darwin.open(directory.appendingPathComponent(filename).path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK)
        guard descriptor >= 0 else { throw DesktopRuntimeUsageLease.Failure.invalidPayload }
        let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
        defer { try? handle.close() }
        var info = stat()
        guard fstat(descriptor, &info) == 0, info.st_mode & S_IFMT == S_IFREG,
              info.st_uid == getuid(), info.st_mode & 0o077 == 0, info.st_nlink == 1,
              info.st_size > 0, info.st_size <= 4096,
              let data = try handle.read(upToCount: 4097), data.count <= 4096 else {
            throw DesktopRuntimeUsageLease.Failure.unsafeLock
        }
        let receipt = try JSONDecoder().decode(Receipt.self, from: data)
        guard receipt.format == 1, receipt.owner == "omnesis-desktop-application-archive",
              receipt.epoch == epoch, receipt.identity == actual else {
            throw DesktopRuntimeUsageLease.Failure.invalidPayload
        }
        return actual
    }

    static func currentIdentity(_ directory: URL) throws -> Identity {
        var root = stat(), app = stat()
        let application = directory.appendingPathComponent("Omnesis.app", isDirectory: true)
        guard (try? DesktopCanonicalPath.resolve(directory.path)) == directory.path,
              lstat(directory.path, &root) == 0, root.st_mode & S_IFMT == S_IFDIR,
              root.st_uid == getuid(), root.st_mode & 0o077 == 0,
              lstat(application.path, &app) == 0, app.st_mode & S_IFMT == S_IFDIR,
              app.st_uid == getuid() else { throw DesktopRuntimeUsageLease.Failure.invalidPayload }
        return Identity(
            device: UInt64(root.st_dev),
            inode: UInt64(root.st_ino),
            appDevice: UInt64(app.st_dev),
            appInode: UInt64(app.st_ino)
        )
    }

    static func syncDirectory(_ directory: URL) throws {
        let descriptor = Darwin.open(directory.path, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW)
        guard descriptor >= 0 else { throw DesktopRuntimeUsageLease.Failure.unsafeLock }
        defer { Darwin.close(descriptor) }
        guard fsync(descriptor) == 0 else { throw DesktopRuntimeUsageLease.Failure.unsafeLock }
    }
}
