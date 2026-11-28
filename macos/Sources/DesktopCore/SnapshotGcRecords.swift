// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import CryptoKit
import Darwin
import Foundation

/// Bounded metadata only. Payload verification belongs to phase one, before publication EX.
enum DesktopSnapshotGcRecords {
    typealias Failure = DesktopDataUsageLease.Failure
    static func digest(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    static func directory(_ path: URL) throws {
        var info = stat()
        guard lstat(path.path, &info) == 0, info.st_mode & S_IFMT == S_IFDIR,
              info.st_uid == getuid(), info.st_mode & 0o077 == 0,
              (try? DesktopCanonicalPath.resolve(path.path)) == path.path else { throw Failure.unsafeRecord }
    }

    static func openPrivate(_ path: URL, create: Bool = false) throws -> Int32 {
        let fd = Darwin.open(path.path, O_RDWR | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC | (create ? O_CREAT : 0), 0o600)
        guard fd >= 0 else { throw Failure.unsafeRecord }
        var held = stat(), published = stat()
        guard fstat(fd, &held) == 0, lstat(path.path, &published) == 0,
              held.st_mode & S_IFMT == S_IFREG, held.st_uid == getuid(), held.st_mode & 0o077 == 0,
              held.st_nlink == 1, held.st_dev == published.st_dev, held.st_ino == published.st_ino else {
            Darwin.close(fd)
            throw Failure.unsafeRecord
        }
        return fd
    }

    static func read(_ path: URL) throws -> (Data, [String: Any]) {
        let fd = try openPrivate(path)
        let file = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
        defer { try? file.close() }
        var before = stat(), after = stat(), published = stat()
        guard fstat(fd, &before) == 0, before.st_size > 0, before.st_size <= 16384,
              let data = try file.read(upToCount: 16385), data.count == Int(before.st_size),
              fstat(fd, &after) == 0, lstat(path.path, &published) == 0,
              before.st_dev == published.st_dev, before.st_ino == published.st_ino,
              before.st_size == after.st_size, before.st_mtimespec.tv_sec == after.st_mtimespec.tv_sec,
              before.st_mtimespec.tv_nsec == after.st_mtimespec.tv_nsec,
              before.st_ctimespec.tv_sec == after.st_ctimespec.tv_sec,
              before.st_ctimespec.tv_nsec == after.st_ctimespec.tv_nsec,
              let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw Failure.unsafeRecord }
        return (data, object)
    }

    static func writeNew(_ object: [String: Any], path: URL) throws {
        let data = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
        guard data.count <= 16384 else { throw Failure.unsafeRecord }
        let temporary = path.deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent(".snapshot-reservation-" + UUID().uuidString + ".tmp")
        let fd = Darwin.open(temporary.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard fd >= 0 else { throw Failure.unsafeRecord }
        let file = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
        defer { try? file.close()
            _ = unlink(temporary.path)
        }
        // Publish only a complete, synced receipt. Until publication, both original processes
        // still retain code SH and the parent cannot begin execve.
        try file.write(contentsOf: data)
        try file.synchronize()
        guard link(temporary.path, path.path) == 0 else { throw Failure.unsafeRecord }
        guard unlink(temporary.path) == 0 else { throw Failure.unsafeRecord }
        try DesktopApplicationArchiveOwnership.syncDirectory(path.deletingLastPathComponent())
    }

    static func epoch(_ value: String) -> Bool {
        value.count == 64 && value.allSatisfy { "0123456789abcdef".contains($0) }
    }

    static func uuid(_ value: String) -> Bool {
        value.lowercased() == value && UUID(uuidString: value) != nil
    }

    /// This runs before publication EX. No process is launched inside the deleting critical section.
    static func birth(_ pid: Int32) throws -> String {
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/bin/ps")
        task.arguments = ["-o", "lstart=", "-p", String(pid)]
        task.environment = ["LC_ALL": "C", "PATH": "/usr/bin:/bin"]
        let pipe = Pipe()
        task.standardOutput = pipe
        task.standardError = FileHandle.nullDevice
        try task.run()
        let output = try pipe.fileHandleForReading.read(upToCount: 256) ?? Data()
        task.waitUntilExit()
        guard task.terminationStatus == 0, output.count < 256,
              let value = String(data: output, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines),
              !value.isEmpty else { throw Failure.missingAuthority }
        return value
    }

    static func install(_ scope: DesktopDataUsageLease.Scope, pid: Int32, birth: String) throws -> String {
        let parent = URL(fileURLWithPath: scope.configDir + ".bootstrap", isDirectory: true)
        try directory(parent)
        let (_, object) = try read(parent.appendingPathComponent("gateway.lock"))
        guard object["locking"] as? String == "darwin-process-v1", (object["pid"] as? NSNumber)?.int32Value == pid,
              object["processStart"] as? String == birth,
              let id = object["leaseId"] as? String, uuid(id) else { throw Failure.missingAuthority }
        return id
    }

    static func ledger(_ scope: DesktopDataUsageLease.Scope, operationId: String, epoch: String) throws -> (String, String, String) {
        let (_, authority) = try read(URL(fileURLWithPath: scope.configDir + ".bootstrap/process-authority.json"))
        guard authority["version"] as? Int == 3, authority["owner"] as? String == "omnesis-desktop",
              authority["instance"] as? String == scope.instance,
              authority["secretService"] as? String == scope.secretService else { throw Failure.legacyUnverified }
        let (bytes, object) = try read(URL(fileURLWithPath: scope.configDir + ".bootstrap/code-retention.json"))
        var root = stat()
        guard object["format"] as? Int == 1, object["owner"] as? String == "omnesis-desktop",
              object["instance"] as? String == scope.instance, object["secretService"] as? String == scope.secretService,
              let identity = object["root"] as? [String: String], lstat(scope.configDir, &root) == 0,
              root.st_mode & S_IFMT == S_IFDIR, root.st_uid == getuid(), root.st_mode & 0o077 == 0,
              identity["device"] == String(root.st_dev), identity["inode"] == String(root.st_ino),
              let pending = object["pending"] as? [String: Any], pending["operationId"] as? String == operationId,
              pending["currentEpoch"] as? String == epoch, let old = pending["oldEpoch"] as? String, Self.epoch(old),
              let mode = pending["mode"] as? String, ["redundant-snapshot", "last-copy-old-epoch", "incomplete-owned"].contains(mode),
              let phase = pending["phase"] as? String, ["planned", "deleting"].contains(phase),
              mode != "last-copy-old-epoch" || old != epoch else { throw Failure.missingAuthority }
        return (digest(bytes), mode, old)
    }
}
