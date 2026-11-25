// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Darwin
import Foundation

/// Uncertain launches never expire: GC must retain their application and runtime.
public enum DesktopApplicationLaunchReservation {
    public static let environmentKey = "OMNESIS_DESKTOP_APPLICATION_LAUNCH_ID"
    private struct Record: Codable {
        let format: Int
        let owner: String
        let epoch: String
        let application: String
    }

    private static let owner = "omnesis-desktop-application-launch"

    public static func reserve(
        application: URL,
        epoch: String,
        archiveRoot: URL = DesktopApplicationArchive.defaultRoot,
        publicationRoot: URL = DesktopRuntimeCache.defaultRoot,
        validate: (URL) throws -> Void
    ) throws
        -> String {
        try withLock(publicationRoot) {
            try privateDirectory(archiveRoot, create: false)
            let expected = archiveRoot.appendingPathComponent(epoch).appendingPathComponent("Omnesis.app")
            guard validEpoch(epoch), application.standardizedFileURL == expected,
                  application.resolvingSymlinksInPath() == expected,
                  try DesktopApplicationArchive.runtimeEpoch(application) == epoch else { throw DesktopRuntimeCache.Failure.invalidPayload }
            try validate(application)
            let directory = archiveRoot.appendingPathComponent(".launch-reservations", isDirectory: true)
            try privateDirectory(directory, create: true)
            let id = UUID().uuidString
            let path = directory.appendingPathComponent(id + ".json")
            let data = try JSONEncoder().encode(Record(format: 1, owner: owner, epoch: epoch, application: expected.path))
            let descriptor = Darwin.open(path.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_NONBLOCK, 0o600)
            guard descriptor >= 0 else { throw DesktopRuntimeCache.Failure.unsafeCache }
            let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
            defer { try? handle.close() }
            try handle.write(contentsOf: data)
            try handle.synchronize()
            let directoryFD = Darwin.open(directory.path, O_RDONLY | O_NOFOLLOW)
            guard directoryFD >= 0 else { throw DesktopRuntimeCache.Failure.unsafeCache }
            defer { Darwin.close(directoryFD) }
            guard fsync(directoryFD) == 0 else { throw DesktopRuntimeCache.Failure.unsafeCache }
            return id
        }
    }

    /// Called only by the actual UI after obtaining its strong runtime usage lease.
    public static func acknowledge(
        id: String,
        application: URL,
        runtime: URL,
        lease: DesktopRuntimeUsageLease,
        archiveRoot: URL = DesktopApplicationArchive.defaultRoot,
        publicationRoot: URL = DesktopRuntimeCache.defaultRoot
    ) throws {
        _ = lease
        guard lease.runtimeURL.standardizedFileURL == runtime.standardizedFileURL else { throw DesktopRuntimeCache.Failure.unsafeCache }
        guard UUID(uuidString: id)?.uuidString == id else { throw DesktopRuntimeCache.Failure.unsafeCache }
        try withLock(publicationRoot) {
            let directory = archiveRoot.appendingPathComponent(".launch-reservations", isDirectory: true)
            try privateDirectory(directory, create: false)
            let path = directory.appendingPathComponent(id + ".json")
            let descriptor = Darwin.open(path.path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
            guard descriptor >= 0 else { throw DesktopRuntimeCache.Failure.unsafeCache }
            let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
            defer { try? handle.close() }
            var info = stat()
            guard fstat(descriptor, &info) == 0, info.st_uid == getuid(), info.st_nlink == 1,
                  info.st_mode & S_IFMT == S_IFREG, info.st_mode & 0o077 == 0, info.st_size > 0, info.st_size <= 8192,
                  let data = try handle.read(upToCount: 8193), data.count <= 8192 else { throw DesktopRuntimeCache.Failure.unsafeCache }
            let record = try JSONDecoder().decode(Record.self, from: data)
            let expected = archiveRoot.appendingPathComponent(record.epoch).appendingPathComponent("Omnesis.app")
            guard record.format == 1, record.owner == owner, validEpoch(record.epoch), record.application == expected.path,
                  application.standardizedFileURL == expected, application.resolvingSymlinksInPath() == expected,
                  runtime.standardizedFileURL == publicationRoot.appendingPathComponent(record.epoch),
                  try DesktopApplicationArchive.runtimeEpoch(application) == record.epoch
            else { throw DesktopRuntimeCache.Failure.unsafeCache }
            var current = stat()
            guard lstat(path.path, &current) == 0, current.st_dev == info.st_dev, current.st_ino == info.st_ino else {
                throw DesktopRuntimeCache.Failure.unsafeCache
            }
            try FileManager.default.removeItem(at: path)
        }
    }

    private static func withLock<T>(_ root: URL, operation: () throws -> T) throws -> T {
        try privateDirectory(root, create: false)
        let descriptor = Darwin.open(
            root.appendingPathComponent(".publication-lock").path,
            O_RDWR | O_CREAT | O_NOFOLLOW | O_NONBLOCK,
            0o600
        )
        guard descriptor >= 0 else { throw DesktopRuntimeCache.Failure.lockUnavailable }
        defer { Darwin.close(descriptor) }
        var info = stat()
        guard fstat(descriptor, &info) == 0, info.st_uid == getuid(), info.st_nlink == 1,
              info.st_mode & S_IFMT == S_IFREG, info.st_mode & 0o077 == 0 else { throw DesktopRuntimeCache.Failure.lockUnavailable }
        try DesktopRuntimePublicationLock.acquire(descriptor)
        defer { flock(descriptor, LOCK_UN) }
        return try operation()
    }

    private static func privateDirectory(_ url: URL, create: Bool) throws {
        if create, !FileManager.default.fileExists(atPath: url.path) {
            try FileManager.default.createDirectory(
                at: url,
                withIntermediateDirectories: false,
                attributes: [.posixPermissions: 0o700]
            )
        }
        var info = stat()
        guard lstat(url.path, &info) == 0, info.st_uid == getuid(), info.st_mode & S_IFMT == S_IFDIR,
              info.st_mode & 0o077 == 0, url.standardizedFileURL == url.resolvingSymlinksInPath() else {
            throw DesktopRuntimeCache.Failure.unsafeCache
        }
    }

    private static func validEpoch(_ value: String) -> Bool {
        value.count == 64 && value.allSatisfy { "0123456789abcdef".contains($0) }
    }
}
