// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import CryptoKit
import Darwin
import Foundation

/// Payload directories are content addressed and retained conservatively while processes may use them.
/// Personal library data and downloaded models are deliberately outside this cache.
public enum DesktopRuntimeCache {
    public enum Failure: LocalizedError {
        case missingPayload, invalidPayload, unsafeCache, insufficientSpace, lockUnavailable
        public var errorDescription: String? {
            switch self {
            case .missingPayload: "This copy of Omnesis is missing its background service. Install the complete Omnesis app to continue."
            case .invalidPayload: "The background service failed its integrity check. Reinstall Omnesis."
            case .unsafeCache: "Omnesis could not safely open its private runtime cache."
            case .insufficientSpace: "Free disk space before preparing the Omnesis background service."
            case .lockUnavailable: "Omnesis could not reserve its runtime cache. Try reopening the app."
            }
        }
    }

    private struct Manifest: Decodable {
        let format: Int
        let architecture: String
        let nodeVersion: String
        let inventory: [Entry]
    }

    private struct Entry: Decodable {
        let path: String
        let bytes: UInt64?
        let executable: Bool?
        let sha256: String?
        let symlink: String?
    }

    public static var defaultRoot: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/Omnesis Desktop Runtime/runtime", isDirectory: true)
    }

    /// Call off the main thread. Source validation must authenticate the manifest's enclosing app seal.
    public static func prepare(
        source: URL,
        cacheRoot: URL = defaultRoot,
        validateSource: () throws -> Void
    ) throws
        -> URL {
        try Task.checkCancellation()
        try validateSource()
        guard try FileManager.default.attributesOfItem(atPath: source.path)[.type] as? FileAttributeType == .typeDirectory,
              source.resolvingSymlinksInPath().path == source.standardizedFileURL.path else {
            throw Failure.invalidPayload
        }
        let bytes = try manifestBytes(source)
        let manifest = try JSONDecoder().decode(Manifest.self, from: bytes)
        try validate(manifest)
        let identity = digest(bytes)
        let files = FileManager.default
        try privateDirectory(cacheRoot)
        let descriptor = Darwin.open(
            cacheRoot.appendingPathComponent(".publication-lock").path,
            O_RDWR | O_CREAT | O_NOFOLLOW,
            S_IRUSR | S_IWUSR
        )
        guard descriptor >= 0 else { throw Failure.lockUnavailable }
        defer { Darwin.close(descriptor) }
        var attributes = stat()
        guard fstat(descriptor, &attributes) == 0, attributes.st_uid == getuid(),
              attributes.st_mode & S_IFMT == S_IFREG, attributes.st_mode & 0o077 == 0,
              attributes.st_nlink == 1 else {
            throw Failure.lockUnavailable
        }
        try DesktopRuntimePublicationLock.acquire(descriptor)
        defer { flock(descriptor, LOCK_UN) }
        let target = cacheRoot.appendingPathComponent(identity, isDirectory: true)
        if files.fileExists(atPath: target.path) {
            try verify(target, manifest: manifest, manifestBytes: bytes)
            guard try manifestBytes(source) == bytes else { throw Failure.invalidPayload }
            try validateSource()
            return target
        }
        let required = try payloadBytes(manifest)
        let capacity = try cacheRoot.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey])
            .volumeAvailableCapacityForImportantUsage ?? 0
        guard capacity >= 0, UInt64(capacity) >= required + 256 * 1024 * 1024 else {
            throw Failure.insufficientSpace
        }
        let staging = cacheRoot.appendingPathComponent(".staging-" + UUID().uuidString, isDirectory: true)
        defer { try? files.removeItem(at: staging) }
        try DesktopCodeCopy.copyTree(source: source, destination: staging)
        try files.setAttributes([.posixPermissions: 0o700], ofItemAtPath: staging.path)
        try verify(staging, manifest: manifest, manifestBytes: bytes)
        // A Finder replacement during staging must not publish mixed revisions.
        guard try manifestBytes(source) == bytes else { throw Failure.invalidPayload }
        try validateSource()
        try Task.checkCancellation()
        try files.moveItem(at: staging, to: target)
        return target
    }

    private static func validate(_ manifest: Manifest) throws {
        #if arch(arm64)
        let architecture = "arm64"
        #else
        let architecture = "x64"
        #endif
        guard manifest.format == 1, manifest.architecture == architecture,
              manifest.nodeVersion.hasPrefix("24."), !manifest.inventory.isEmpty,
              manifest.inventory.count <= 200_000 else { throw Failure.invalidPayload }
        var seen = Set<String>()
        for entry in manifest.inventory {
            try Task.checkCancellation()
            guard validPath(entry.path), entry.path != "desktop-runtime.json",
                  seen.insert(entry.path).inserted else { throw Failure.invalidPayload }
            if let target = entry.symlink {
                guard !target.isEmpty, !target.hasPrefix("/"), !target.contains("\0"),
                      entry.sha256 == nil, entry.bytes == nil else { throw Failure.invalidPayload }
            } else {
                guard let hash = entry.sha256, hash.count == 64,
                      hash.allSatisfy({ $0.isHexDigit && !$0.isUppercase }),
                      entry.bytes != nil, entry.executable != nil else { throw Failure.invalidPayload }
            }
        }
        guard seen.contains("node"), seen.contains("packages/cli/dist/index.js") else {
            throw Failure.invalidPayload
        }
        _ = try payloadBytes(manifest)
    }

    private static func payloadBytes(_ manifest: Manifest) throws -> UInt64 {
        var total: UInt64 = 0
        for entry in manifest.inventory {
            try Task.checkCancellation()
            let sum = total.addingReportingOverflow(entry.bytes ?? 0)
            guard !sum.overflow, sum.partialValue <= 64 * 1024 * 1024 * 1024 else {
                throw Failure.invalidPayload
            }
            total = sum.partialValue
        }
        return total
    }

    private static func validPath(_ path: String) -> Bool {
        !path.isEmpty && !path.contains("\0") && !path.contains("\\") &&
            path.split(separator: "/", omittingEmptySubsequences: false)
            .allSatisfy { !$0.isEmpty && $0 != "." && $0 != ".." }
    }

    private static func manifestBytes(_ root: URL) throws -> Data {
        let path = root.appendingPathComponent("desktop-runtime.json")
        let descriptor = Darwin.open(path.path, O_RDONLY | O_NOFOLLOW)
        guard descriptor >= 0 else { throw Failure.invalidPayload }
        let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
        defer { try? handle.close() }
        var metadata = stat()
        guard fstat(descriptor, &metadata) == 0, metadata.st_mode & S_IFMT == S_IFREG,
              metadata.st_size > 0, metadata.st_size <= 32 * 1024 * 1024,
              let data = try handle.read(upToCount: 32 * 1024 * 1024 + 1),
              data.count <= 32 * 1024 * 1024 else { throw Failure.invalidPayload }
        return data
    }

    private static func verify(_ root: URL, manifest: Manifest, manifestBytes: Data) throws {
        let files = FileManager.default
        let canonical = root.resolvingSymlinksInPath().standardizedFileURL
        guard canonical.path == root.standardizedFileURL.path,
              try self.manifestBytes(root) == manifestBytes else { throw Failure.invalidPayload }
        var expected = Set(["desktop-runtime.json"])
        for entry in manifest.inventory {
            try Task.checkCancellation()
            expected.insert(entry.path)
            let path = root.appendingPathComponent(entry.path)
            let attributes = try files.attributesOfItem(atPath: path.path)
            if let target = entry.symlink {
                guard attributes[.type] as? FileAttributeType == .typeSymbolicLink,
                      try files.destinationOfSymbolicLink(atPath: path.path) == target else {
                    throw Failure.invalidPayload
                }
                let resolved = path.resolvingSymlinksInPath().standardizedFileURL.path
                guard resolved.hasPrefix(canonical.path + "/"), files.fileExists(atPath: resolved) else {
                    throw Failure.invalidPayload
                }
            } else {
                guard attributes[.type] as? FileAttributeType == .typeRegular,
                      path.deletingLastPathComponent().resolvingSymlinksInPath().path
                      == path.deletingLastPathComponent().standardizedFileURL.path,
                      (attributes[.size] as? NSNumber)?.uint64Value == entry.bytes,
                      (((attributes[.posixPermissions] as? NSNumber)?.intValue ?? 0) & 0o111 != 0)
                      == entry.executable,
                      try fileDigest(path) == entry.sha256 else { throw Failure.invalidPayload }
            }
        }
        guard let enumeration = files.enumerator(at: root, includingPropertiesForKeys: [.isDirectoryKey, .isSymbolicLinkKey]) else {
            throw Failure.invalidPayload
        }
        var found = Set<String>()
        let rootComponents = canonical.pathComponents
        for case let url as URL in enumeration {
            let components = url.standardizedFileURL.pathComponents
            guard components.count > rootComponents.count,
                  Array(components.prefix(rootComponents.count)) == rootComponents else {
                throw Failure.invalidPayload
            }
            let relative = components.dropFirst(rootComponents.count).joined(separator: "/")
            let values = try url.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
            if values.isSymbolicLink == true || values.isDirectory != true { found.insert(relative) }
        }
        guard found == expected, files.isExecutableFile(atPath: root.appendingPathComponent("node").path) else {
            throw Failure.invalidPayload
        }
    }

    private static func privateDirectory(_ root: URL) throws {
        let files = FileManager.default
        try files.createDirectory(
            at: root,
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700]
        )
        guard root.resolvingSymlinksInPath().path == root.standardizedFileURL.path else {
            throw Failure.unsafeCache
        }
        let metadata = try files.attributesOfItem(atPath: root.path)
        guard metadata[.type] as? FileAttributeType == .typeDirectory,
              (metadata[.ownerAccountID] as? NSNumber)?.uint32Value == getuid(),
              ((metadata[.posixPermissions] as? NSNumber)?.intValue ?? 0) & 0o077 == 0 else {
            throw Failure.unsafeCache
        }
    }

    private static func fileDigest(_ path: URL) throws -> String {
        let descriptor = Darwin.open(path.path, O_RDONLY | O_NOFOLLOW)
        guard descriptor >= 0 else { throw Failure.invalidPayload }
        let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
        defer { try? handle.close() }
        var hash = SHA256()
        while let data = try handle.read(upToCount: 1024 * 1024), !data.isEmpty {
            hash.update(data: data)
        }
        return hash.finalize().map { String(format: "%02x", $0) }.joined()
    }

    private static func digest(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }
}
