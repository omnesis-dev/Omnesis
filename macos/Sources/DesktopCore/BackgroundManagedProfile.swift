// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import CryptoKit
import Darwin
import Foundation

/// Reads only the application's bounded private control metadata. It creates no profile or key.
public struct DesktopBackgroundManagedProfile: Equatable, Sendable {
    public let configDir: String
    public let instance: String
    public let secretService: String
    public var scope: DesktopDataUsageLease.Scope {
        DesktopDataUsageLease.Scope(configDir: configDir, instance: instance, secretService: secretService)
    }

    public var binding: DesktopBackgroundLaunchProtocol.Binding {
        .init(configDirHash: Self.digest(Data(configDir.utf8)), instance: instance, secretService: secretService)
    }

    public static func current(home: URL = FileManager.default.homeDirectoryForCurrentUser) throws -> Self {
        let path = try DesktopCanonicalPath.resolve(
            home.appendingPathComponent("Library/Application Support/Omnesis Desktop").path,
            allowMissing: true
        )
        let parent = URL(fileURLWithPath: path + ".bootstrap", isDirectory: true)
        var info = stat()
        var generation: String?
        if lstat(parent.path, &info) == 0 {
            try directory(parent)
            if let value = try record(parent.appendingPathComponent("generation.json")) {
                guard value["version"] as? Int == 1, value["owner"] as? String == "omnesis-desktop",
                      value["configIdentity"] as? String == digest(Data(path.utf8)),
                      let identifier = value["generation"] as? String, UUID(uuidString: identifier) != nil,
                      identifier == identifier.lowercased() else { throw DesktopBackgroundLaunchProtocol.Failure.invalidFrame }
                generation = identifier
            }
        } else if errno != ENOENT { throw DesktopBackgroundLaunchProtocol.Failure.invalidFrame }
        var material = Data(path.utf8)
        if let generation { material.append(0)
            material.append(contentsOf: generation.utf8)
        }
        let identity = digest(material)
        return Self(configDir: path, instance: "desktop-" + String(identity.prefix(16)), secretService: "dev.omnesis.desktop." + identity)
    }

    public static func matching(_ requested: DesktopDataUsageLease.Scope) throws -> Self {
        let current = try Self.current()
        guard requested.format == 1, requested.restoreActivation == nil, current.scope == requested else {
            throw DesktopDataUsageLease.Failure.invalidScope
        }
        return current
    }

    public func validateIdentity() throws {
        guard try Self.current() == self else { throw DesktopDataUsageLease.Failure.invalidScope }
        try DesktopDataUsageLease.requireProcessAuthority(scope)
    }

    public func configured() throws -> Bool {
        guard let install = try Self.record(URL(fileURLWithPath: configDir + "/desktop-install.json")) else { return false }
        return bound(install) && install["phase"] as? String == "configured"
    }

    private func bound(_ object: [String: Any]) -> Bool {
        (object["version"] as? Int == 1 || object["format"] as? Int == 1) &&
            object["owner"] as? String == "omnesis-desktop" && object["instance"] as? String == instance &&
            object["secretService"] as? String == secretService
    }

    private static func directory(_ url: URL) throws {
        var info = stat()
        guard lstat(url.path, &info) == 0, info.st_mode & S_IFMT == S_IFDIR, info.st_uid == getuid(),
              info.st_mode & 0o077 == 0,
              try DesktopCanonicalPath.resolve(url.path) == url.path else { throw DesktopDataUsageLease.Failure.unsafeRecord }
    }

    private static func record(_ url: URL) throws -> [String: Any]? {
        // An absent fresh profile stays idle. Existing parents must be private and canonical.
        var parent = stat()
        guard lstat(url.deletingLastPathComponent().path, &parent) == 0 else {
            if errno == ENOENT { return nil }
            throw DesktopDataUsageLease.Failure.unsafeRecord
        }
        try directory(url.deletingLastPathComponent())
        let fd = Darwin.open(url.path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
        if fd < 0 { if errno == ENOENT { return nil }
            throw DesktopDataUsageLease.Failure.unsafeRecord
        }
        let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
        defer { try? handle.close() }
        var info = stat()
        guard fstat(fd, &info) == 0, info.st_mode & S_IFMT == S_IFREG, info.st_uid == getuid(),
              info.st_mode & 0o077 == 0, info.st_nlink == 1, info.st_size > 0, info.st_size <= 16384,
              let bytes = try handle.read(upToCount: 16385), bytes.count == info.st_size,
              let value = try JSONSerialization.jsonObject(with: bytes) as? [String: Any]
        else { throw DesktopDataUsageLease.Failure.unsafeRecord }
        return value
    }

    private static func digest(_ bytes: Data) -> String {
        SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
    }
}
