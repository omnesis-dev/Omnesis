// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import CryptoKit
import Darwin
import Foundation

/// Retains code only, outside the erasable library, before another app can replace it.
public enum DesktopApplicationArchive {
    public static var defaultRoot: URL {
        DesktopRuntimeCache.defaultRoot.deletingLastPathComponent().appendingPathComponent("applications", isDirectory: true)
    }

    public static func retain(
        application: URL,
        epoch: String,
        root: URL = defaultRoot,
        publicationRoot: URL = DesktopRuntimeCache.defaultRoot,
        validate: (URL) throws -> Void
    ) throws
        -> URL {
        try Task.checkCancellation()
        guard validEpoch(epoch), application.pathExtension == "app",
              application.resolvingSymlinksInPath() == application.standardizedFileURL
        else { throw DesktopRuntimeCache.Failure.invalidPayload }
        try privateDirectory(root, create: true)
        try privateDirectory(publicationRoot, create: true)
        // Archive publication and runtime GC use the same critical section.
        let descriptor = Darwin.open(
            publicationRoot.appendingPathComponent(".publication-lock").path,
            O_RDWR | O_CREAT | O_NOFOLLOW | O_NONBLOCK,
            0o600
        )
        guard descriptor >= 0 else { throw DesktopRuntimeCache.Failure.lockUnavailable }
        defer { Darwin.close(descriptor) }
        var lockInfo = stat()
        guard fstat(descriptor, &lockInfo) == 0, lockInfo.st_mode & S_IFMT == S_IFREG,
              lockInfo.st_nlink == 1, lockInfo.st_uid == getuid(),
              lockInfo.st_mode & 0o077 == 0 else { throw DesktopRuntimeCache.Failure.lockUnavailable }
        try DesktopRuntimePublicationLock.acquire(descriptor)
        defer { flock(descriptor, LOCK_UN) }
        try validate(application)
        guard try runtimeEpoch(application) == epoch else { throw DesktopRuntimeCache.Failure.invalidPayload }
        let destination = root.appendingPathComponent(epoch, isDirectory: true)
        let app = destination.appendingPathComponent("Omnesis.app", isDirectory: true)
        if FileManager.default.fileExists(atPath: destination.path) {
            try privateDirectory(destination, create: false)
            try validate(app)
            guard try runtimeEpoch(app) == epoch else { throw DesktopRuntimeCache.Failure.invalidPayload }
            return app
        }
        let bytes = try applicationBytes(application)
        let available = try root.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey])
            .volumeAvailableCapacityForImportantUsage
        guard let available, available >= bytes + 512 * 1024 * 1024 else { throw DesktopRuntimeCache.Failure.insufficientSpace }
        let stage = root.appendingPathComponent(".staging-" + UUID().uuidString, isDirectory: true)
        try privateDirectory(stage, create: true)
        do {
            let copy = stage.appendingPathComponent("Omnesis.app", isDirectory: true)
            try DesktopCodeCopy.copyTree(source: application, destination: copy)
            try validate(copy)
            guard try runtimeEpoch(copy) == epoch,
                  try runtimeEpoch(application) == epoch else { throw DesktopRuntimeCache.Failure.invalidPayload }
            try Task.checkCancellation()
            try FileManager.default.moveItem(at: stage, to: destination)
            return app
        } catch { try? FileManager.default.removeItem(at: stage)
            throw error
        }
    }

    public static func runtimeEpoch(_ application: URL) throws -> String {
        let file = application.appendingPathComponent("Contents/Resources/runtime/desktop-runtime.json")
        let descriptor = Darwin.open(file.path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
        guard descriptor >= 0 else { throw DesktopRuntimeCache.Failure.invalidPayload }
        let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
        defer { try? handle.close() }
        var info = stat()
        guard fstat(descriptor, &info) == 0, info.st_mode & S_IFMT == S_IFREG,
              info.st_size > 0, info.st_size <= 32 * 1024 * 1024,
              let data = try handle.read(upToCount: 32 * 1024 * 1024 + 1),
              data.count <= 32 * 1024 * 1024 else { throw DesktopRuntimeCache.Failure.invalidPayload }
        return SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    public static func applicationBytes(_ application: URL) throws -> Int64 {
        guard let entries = FileManager.default.enumerator(
            at: application,
            includingPropertiesForKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey]
        ) else { throw DesktopRuntimeCache.Failure.invalidPayload }
        var bytes: Int64 = 0
        for case let entry as URL in entries {
            try Task.checkCancellation()
            let info = try entry.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey])
            if info.isSymbolicLink == true { entries.skipDescendants()
                continue
            }
            if info.isRegularFile == true { bytes += Int64(info.fileSize ?? 0) }
        }
        return bytes
    }

    private static func validEpoch(_ value: String) -> Bool {
        value.count == 64 && value.allSatisfy { "0123456789abcdef".contains($0) }
    }

    private static func privateDirectory(_ directory: URL, create: Bool) throws {
        if create { try FileManager.default.createDirectory(
            at: directory,
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700]
        ) }
        var info = stat()
        guard lstat(directory.path, &info) == 0, info.st_mode & S_IFMT == S_IFDIR, info.st_uid == getuid(), info.st_mode & 0o077 == 0,
              directory.resolvingSymlinksInPath() == directory.standardizedFileURL else { throw DesktopRuntimeCache.Failure.unsafeCache }
    }
}
