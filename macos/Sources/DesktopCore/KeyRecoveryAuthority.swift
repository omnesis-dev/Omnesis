// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import CryptoKit
import Darwin
import Foundation

/// Short, scoped Keychain recovery admission. It confers no corpus or subprocess authority.
public enum DesktopKeyRecoveryAuthority {
    public struct Root: Codable, Equatable, Sendable { public let device: String
        public let inode: String
    }

    public struct Update: Codable, Equatable, Sendable { public let operationId: String
        public let phase: String
    }

    public struct Restore: Codable, Equatable, Sendable {
        public let operationId: String
        public let phase: String
        public let targetKeyDigest: String
    }

    public struct Context: Codable {
        public let version: Int
        public let scope: DesktopDataUsageLease.Scope
        public let root: Root
        public let update: Update?
        public let restore: Restore?
    }

    public enum Failure: Error { case invalidRequest, changedInstallation, keychainRefused }

    public static func decode(_ encoded: String) throws -> Context {
        guard encoded.utf8.count <= 8192, !encoded.contains("="),
              let bytes = Data(base64Encoded: encoded.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/") +
                  String(repeating: "=", count: (4 - encoded.count % 4) % 4)), bytes.count <= 4096,
              base64(bytes) == encoded,
              let object = try JSONSerialization.jsonObject(with: bytes) as? [String: Any],
              Set(object.keys) == ["version", "scope", "root", "update", "restore"],
              let scope = object["scope"] as? [String: Any], Set(scope.keys) == ["format", "configDir", "instance", "secretService"],
              let root = object["root"] as? [String: Any], Set(root.keys) == ["device", "inode"] else { throw Failure.invalidRequest }
        if !(object["update"] is NSNull) {
            guard let value = object["update"] as? [String: Any], Set(value.keys) == ["operationId", "phase"] else {
                throw Failure.invalidRequest
            }
        }
        if !(object["restore"] is NSNull) {
            guard let value = object["restore"] as? [String: Any], Set(value.keys) == ["operationId", "phase", "targetKeyDigest"] else {
                throw Failure.invalidRequest
            }
        }
        let context = try JSONDecoder().decode(Context.self, from: bytes)
        guard context.version == 1, context.scope.format == 1, context.scope.restoreActivation == nil,
              decimal(context.root.device), decimal(context.root.inode),
              context.update.map({ uuid($0.operationId) && updatePhases.contains($0.phase) }) ?? true,
              context.restore.map({ uuid($0.operationId) && restorePhases.contains($0.phase) && digest($0.targetKeyDigest) }) ?? true
        else { throw Failure.invalidRequest }
        return context
    }

    static let updatePhases: Set<String> = [
        "verified",
        "stopping",
        "backed-up",
        "installer-opened",
        "candidate-started",
        "complete",
        "recovery-required",
        "resumed",
    ]
    static let restorePhases: Set<String> = [
        "stopping",
        "backed-up",
        "staged",
        "publishing",
        "published",
        "verifying",
        "committed",
        "starting",
        "complete",
        "rolling-back",
        "rolled-back",
        "recovery-required",
    ]

    /// Called before and after DATA SH acquisition and immediately before each Keychain operation.
    public static func validate(_ context: Context, epoch: String) throws {
        guard context.version == 1, digest(epoch), context.scope.restoreActivation == nil else { throw Failure.invalidRequest }
        try DesktopDataUsageLease.requireProcessAuthority(context.scope)
        let config = URL(fileURLWithPath: context.scope.configDir, isDirectory: true)
        try directory(config)
        var root = stat()
        guard lstat(config.path, &root) == 0, String(root.st_dev) == context.root.device,
              String(root.st_ino) == context.root.inode else { throw Failure.changedInstallation }
        let external = URL(fileURLWithPath: context.scope.configDir + ".bootstrap", isDirectory: true)
        try directory(external)
        guard let install = try record(config.appendingPathComponent("desktop-install.json")), bound(install, context.scope),
              install["phase"] as? String == "configured", install["mode"] as? String == "home",
              install["processAuthorityVersion"] as? Int == 3 else { throw Failure.changedInstallation }
        if let retirement = try record(external.appendingPathComponent("retirement.json")) {
            // A previous erased incarnation is retained only as the generation's exact receipt.
            guard !bound(retirement, context.scope), retirement["phase"] as? String == "complete",
                  retirement["mode"] as? String == "erase-data",
                  let generation = try record(external.appendingPathComponent("generation.json")),
                  let previous = generation["previous"] as? [String: String],
                  previous["instance"] == retirement["instance"] as? String,
                  previous["secretService"] == retirement["secretService"] as? String,
                  previous["retirementId"] == retirement["operationId"] as? String else { throw Failure.changedInstallation }
        }
        let update = try record(external.appendingPathComponent("update.json"))
        guard (update == nil) == (context.update == nil) else { throw Failure.changedInstallation }
        var epochs = Set([epoch])
        if let expected = context.update, let update {
            guard bound(update, context.scope), matchesRoot(update, context.root),
                  update["operationId"] as? String == expected.operationId, update["phase"] as? String == expected.phase,
                  uuid(expected.operationId), updatePhases.contains(expected.phase),
                  let old = update["oldEpoch"] as? String, digest(old),
                  let candidate = update["candidateEpoch"] as? String, digest(candidate), [old, candidate].contains(epoch)
            else { throw Failure.changedInstallation }
            epochs = Set([old, candidate])
        }
        let restore = try record(external.appendingPathComponent("restore.json"))
        guard (restore == nil) == (context.restore == nil) else { throw Failure.changedInstallation }
        if let expected = context.restore, let restore {
            guard bound(restore, context.scope), matchesRoot(restore, context.root),
                  restore["operationId"] as? String == expected.operationId, restore["phase"] as? String == expected.phase,
                  restore["targetKeyDigest"] as? String == expected.targetKeyDigest, uuid(expected.operationId),
                  restorePhases.contains(expected.phase), digest(expected.targetKeyDigest) else { throw Failure.changedInstallation }
        }
        if let active = try record(external.appendingPathComponent("active-runtime.json")) {
            guard bound(active, context.scope), let activeEpoch = active["epoch"] as? String,
                  epochs.contains(activeEpoch) else { throw Failure.changedInstallation }
        } else {
            // Configured initial setup may not yet have claimed its first runtime.
            // An interrupted operation must never infer that same absence is safe.
            guard update == nil, restore == nil else { throw Failure.changedInstallation }
        }
    }

    private static func matchesRoot(_ value: [String: Any], _ root: Root) -> Bool {
        guard let actual = value["root"] as? [String: String] else { return false }
        return actual == ["device": root.device, "inode": root.inode]
    }

    private static func bound(_ value: [String: Any], _ scope: DesktopDataUsageLease.Scope) -> Bool {
        (value["version"] as? Int == 1 || value["format"] as? Int == 1) && value["owner"] as? String == "omnesis-desktop" &&
            value["instance"] as? String == scope.instance && value["secretService"] as? String == scope.secretService
    }

    private static func directory(_ path: URL) throws {
        var info = stat()
        guard lstat(path.path, &info) == 0, info.st_mode & S_IFMT == S_IFDIR, info.st_uid == getuid(), info.st_mode & 0o077 == 0,
              try DesktopCanonicalPath.resolve(path.path) == path.path else { throw Failure.changedInstallation }
    }

    private static func record(_ path: URL) throws -> [String: Any]? {
        let fd = Darwin.open(path.path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
        if fd < 0 { if errno == ENOENT { return nil }
            throw Failure.changedInstallation
        }
        let file = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
        defer { try? file.close() }
        var before = stat(), after = stat(), published = stat()
        guard fstat(fd, &before) == 0, before.st_mode & S_IFMT == S_IFREG, before.st_uid == getuid(), before.st_mode & 0o077 == 0,
              before.st_nlink == 1, before.st_size > 0, before.st_size <= 16384,
              let bytes = try file.read(upToCount: 16385), bytes.count == before.st_size,
              fstat(fd, &after) == 0, lstat(path.path, &published) == 0,
              before.st_dev == after.st_dev, before.st_ino == after.st_ino, before.st_size == after.st_size,
              before.st_mtimespec.tv_sec == after.st_mtimespec.tv_sec, before.st_mtimespec.tv_nsec == after.st_mtimespec.tv_nsec,
              before.st_ctimespec.tv_sec == after.st_ctimespec.tv_sec, before.st_ctimespec.tv_nsec == after.st_ctimespec.tv_nsec,
              published.st_dev == before.st_dev, published.st_ino == before.st_ino,
              let value = try JSONSerialization.jsonObject(with: bytes) as? [String: Any] else { throw Failure.changedInstallation }
        return value
    }

    static func digest(_ value: String) -> Bool {
        value.count == 64 && value.utf8
            .allSatisfy { (48 ... 57).contains($0) || (97 ... 102).contains($0) }
    }

    static func uuid(_ value: String) -> Bool {
        value == value.lowercased() && UUID(uuidString: value) != nil
    }

    private static func decimal(_ value: String) -> Bool {
        UInt64(value).map { String($0) == value } == true
    }

    private static func base64(_ bytes: Data) -> String {
        bytes.base64EncodedString().replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(
                of: "/",
                with: "_"
            ).replacingOccurrences(of: "=", with: "")
    }
}
