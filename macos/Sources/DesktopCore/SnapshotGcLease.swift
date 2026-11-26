// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Darwin
import Foundation

/// A purpose-specific durable reservation covers Node execve's descriptor-closing interval.
public final class DesktopSnapshotGcLease {
    private typealias Records = DesktopSnapshotGcRecords
    private typealias Failure = DesktopDataUsageLease.Failure
    private let publication: Int32
    private let usage: Int32?
    private let metadata: [String: Any]
    private let legacy: DesktopRuntimeUsageLease.LegacyDataReservation
    public let data: DesktopDataUsageLease

    deinit {
        Darwin.close(publication)
        if let usage { Darwin.close(usage) }
    }

    private init(
        publication: Int32,
        usage: Int32?,
        metadata: [String: Any],
        data: DesktopDataUsageLease,
        legacy: DesktopRuntimeUsageLease.LegacyDataReservation
    ) {
        self.publication = publication
        self.usage = usage
        self.metadata = metadata
        self.data = data
        self.legacy = legacy
    }

    static func directory(cache: URL) -> URL {
        cache.appendingPathComponent(".snapshot-reservations", isDirectory: true)
    }

    /// Called with publication EX by both code reclamation entry points. Uncertainty never expires.
    static func blocksReclamation(cache: URL, epoch: String) -> Bool {
        let folder = directory(cache: cache)
        var info = stat()
        guard lstat(folder.path, &info) == 0 else { return errno != ENOENT }
        do {
            try Records.directory(folder)
            let entries = try FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil)
            guard entries.count <= 256 else { return true }
            for entry in entries {
                guard entry.pathExtension == "json", Records.uuid(entry.deletingPathExtension().lastPathComponent) else { return true }
                let (_, value) = try Records.read(entry)
                guard value["format"] as? Int == 1, value["owner"] as? String == "omnesis-desktop-snapshot-reservation",
                      let reserved = value["epoch"] as? String, Records.epoch(reserved),
                      value["operationId"] as? String == entry.deletingPathExtension().lastPathComponent,
                      let scope = value["scope"] as? [String: Any], scope.count == 4, scope["format"] as? Int == 1,
                      let config = scope["configDir"] as? String, config.hasPrefix("/"),
                      URL(fileURLWithPath: config).path == config,
                      let instance = scope["instance"] as? String, instance.hasPrefix("desktop-"), instance.count == 24,
                      instance.dropFirst(8).allSatisfy({ "0123456789abcdef".contains($0) }),
                      let service = scope["secretService"] as? String, service.hasPrefix("dev.omnesis.desktop."), service.count == 84,
                      Records.epoch(String(service.suffix(64))),
                      let installId = value["installId"] as? String, Records.uuid(installId),
                      let birth = value["birth"] as? String, !birth.isEmpty,
                      let pid = value["pid"] as? NSNumber, pid.int64Value > 1,
                      let sha = value["ledgerSha256"] as? String, Records.epoch(sha), value.count == 9 else { return true }
                if reserved == epoch { return true }
            }
            return false
        } catch { return true }
    }

    /// Helper process runs before execve, while its parent still owns the install record and code SH.
    public static func reserve(scope: DesktopDataUsageLease.Scope, operationId: String, runtime: URL) throws {
        guard Records.uuid(operationId), scope.restoreActivation == nil else { throw Failure.invalidScope }
        let data = try DesktopDataUsageLease.acquire(scope: scope, epoch: runtime.lastPathComponent)
        let pid = getppid(), birth = try Records.birth(getppid())
        let installId = try Records.install(scope, pid: pid, birth: birth)
        let cache = runtime.deletingLastPathComponent()
        let path = directory(cache: cache).appendingPathComponent(operationId + ".json")
        let previous = try previousReservation(path, scope: scope, operationId: operationId, epoch: runtime.lastPathComponent)
        let publication = try Records.openPrivate(cache.appendingPathComponent(".publication-lock"), create: true)
        defer { Darwin.close(publication) }
        try DesktopRuntimePublicationLock.acquire(publication)
        _ = data
        guard try Records.install(scope, pid: pid, birth: birth) == installId else { throw Failure.missingAuthority }
        let (hash, _, _) = try Records.ledger(scope, operationId: operationId, epoch: runtime.lastPathComponent)
        let folder = directory(cache: cache)
        if mkdir(folder.path, 0o700) != 0, errno != EEXIST { throw Failure.unsafeRecord }
        try Records.directory(folder)
        guard try FileManager.default.contentsOfDirectory(atPath: folder.path).count < 256 else { throw Failure.unsafeRecord }
        let value: [String: Any] = [
            "format": 1, "owner": "omnesis-desktop-snapshot-reservation", "operationId": operationId,
            "epoch": runtime.lastPathComponent, "pid": pid, "birth": birth, "installId": installId,
            "scope": ["format": 1, "configDir": scope.configDir, "instance": scope.instance, "secretService": scope.secretService],
            "ledgerSha256": hash,
        ]
        if let previous {
            let (bytes, _) = try Records.read(path)
            guard Records.digest(bytes) == previous else { throw Failure.missingAuthority }
            guard unlink(path.path) == 0 else { throw Failure.unsafeRecord }
        }
        try Records.writeNew(value, path: path)
        try DesktopApplicationArchiveOwnership.syncDirectory(cache)
        withExtendedLifetime(data) {}
    }

    /// Existing reservations may be replaced only for the exact private operation, with a dead
    /// incarnation or the currently owning process. No wall-clock timeout implies abandonment.
    private static func previousReservation(
        _ path: URL,
        scope: DesktopDataUsageLease.Scope,
        operationId: String,
        epoch: String
    ) throws
        -> String? {
        var info = stat()
        guard lstat(path.path, &info) == 0 else {
            if errno == ENOENT { return nil }
            throw Failure.unsafeRecord
        }
        let (bytes, value) = try Records.read(path)
        guard value.count == 9, value["format"] as? Int == 1,
              value["owner"] as? String == "omnesis-desktop-snapshot-reservation",
              value["operationId"] as? String == operationId, value["epoch"] as? String == epoch,
              let oldPid = (value["pid"] as? NSNumber)?.int32Value, oldPid > 1,
              let oldBirth = value["birth"] as? String, !oldBirth.isEmpty,
              let saved = value["scope"] as? [String: Any], saved.count == 4, saved["format"] as? Int == 1,
              saved["configDir"] as? String == scope.configDir, saved["instance"] as? String == scope.instance,
              saved["secretService"] as? String == scope.secretService else { throw Failure.missingAuthority }
        if kill(oldPid, 0) == 0 {
            let currentBirth = try Records.birth(oldPid)
            if currentBirth == oldBirth {
                let currentInstall = try Records.install(scope, pid: oldPid, birth: oldBirth)
                guard oldPid == getppid(), value["installId"] as? String ==
                    currentInstall else { throw Failure.inUse }
            }
        } else if errno != ESRCH { throw Failure.missingAuthority }
        return Records.digest(bytes)
    }

    public static func cancel(scope: DesktopDataUsageLease.Scope, operationId: String, runtime: URL) throws {
        guard Records.uuid(operationId), scope.restoreActivation == nil else { throw Failure.invalidScope }
        let data = try DesktopDataUsageLease.acquire(scope: scope, epoch: runtime.lastPathComponent)
        let pid = getppid(), birth = try Records.birth(getppid())
        let installId = try Records.install(scope, pid: pid, birth: birth)
        let cache = runtime.deletingLastPathComponent(), path = directory(cache: cache).appendingPathComponent(operationId + ".json")
        let previous = try previousReservation(path, scope: scope, operationId: operationId, epoch: runtime.lastPathComponent)
        let publication = try Records.openPrivate(cache.appendingPathComponent(".publication-lock"), create: true)
        defer { Darwin.close(publication) }
        try DesktopRuntimePublicationLock.acquire(publication)
        guard try Records.install(scope, pid: pid, birth: birth) == installId else { throw Failure.missingAuthority }
        _ = try Records.ledger(scope, operationId: operationId, epoch: runtime.lastPathComponent)
        let (_, ledger) = try Records.read(URL(fileURLWithPath: scope.configDir + ".bootstrap/code-retention.json"))
        guard (ledger["pending"] as? [String: Any])?["phase"] as? String == "planned" else { throw Failure.blocked }
        if let previous {
            let (bytes, _) = try Records.read(path)
            guard Records.digest(bytes) == previous, unlink(path.path) == 0 else { throw Failure.missingAuthority }
            try DesktopApplicationArchiveOwnership.syncDirectory(path.deletingLastPathComponent())
        }
        withExtendedLifetime(data) {}
    }

    /// The caller already reacquired code SH. Install ownership is checked again under publication EX.
    public static func acquire(scope: DesktopDataUsageLease.Scope, operationId: String, runtime: URL) throws -> DesktopSnapshotGcLease {
        guard Records.uuid(operationId), scope.restoreActivation == nil else { throw Failure.invalidScope }
        let birth = try Records.birth(getpid()), installId = try Records.install(scope, pid: getpid(), birth: birth)
        let data = try DesktopDataUsageLease.acquire(scope: scope, epoch: runtime.lastPathComponent)
        let cache = runtime.deletingLastPathComponent()
        // Unknown earlier incarnations may have lost every descriptor. No free lock proves absence.
        let legacy = try DesktopRuntimeUsageLease.reserveLegacyDataConsumers(cache: cache)
        let opened = try Records.openPrivate(cache.appendingPathComponent(".publication-lock"), create: true)
        let publication = fcntl(opened, F_DUPFD_CLOEXEC, 30)
        Darwin.close(opened)
        guard publication >= 30 else { throw Failure.unsafeRecord }
        var usage: Int32?
        do {
            try DesktopRuntimePublicationLock.acquire(publication)
            guard try Records.install(scope, pid: getpid(), birth: birth) == installId else { throw Failure.missingAuthority }
            let (hash, mode, oldEpoch) = try Records.ledger(scope, operationId: operationId, epoch: runtime.lastPathComponent)
            let path = directory(cache: cache).appendingPathComponent(operationId + ".json")
            try Records.directory(path.deletingLastPathComponent())
            let (_, reservation) = try Records.read(path)
            guard reservation.count == 9, reservation["format"] as? Int == 1,
                  reservation["owner"] as? String == "omnesis-desktop-snapshot-reservation",
                  reservation["operationId"] as? String == operationId, reservation["epoch"] as? String == runtime.lastPathComponent,
                  (reservation["pid"] as? NSNumber)?.int32Value == getpid(), reservation["birth"] as? String == birth,
                  reservation["installId"] as? String == installId, reservation["ledgerSha256"] as? String == hash,
                  let savedScope = reservation["scope"] as? [String: Any], savedScope.count == 4,
                  savedScope["format"] as? Int == 1, savedScope["configDir"] as? String == scope.configDir,
                  savedScope["instance"] as? String == scope.instance, savedScope["secretService"] as? String == scope.secretService else {
                throw Failure.missingAuthority
            }
            if mode == "last-copy-old-epoch" {
                let fd = try Records.openPrivate(cache.appendingPathComponent(".usage-" + oldEpoch + ".lock"), create: true)
                let relocated = fcntl(fd, F_DUPFD_CLOEXEC, 30)
                Darwin.close(fd)
                guard relocated >= 30 else { throw Failure.unsafeRecord }
                usage = relocated
                guard flock(relocated, LOCK_EX | LOCK_NB) == 0 else { throw Failure.inUse }
            }
            var context: [String: Any] = try [
                "operationId": operationId, "currentEpoch": runtime.lastPathComponent, "oldEpoch": oldEpoch,
                "mode": mode, "installId": installId, "pid": getpid(), "birth": birth,
                "publication": identity(publication),
            ]
            if let usage { context["usage"] = try identity(usage) }
            // Removing only after code SH is held closes the no-descriptor handoff gap.
            guard unlink(path.path) == 0 else { throw Failure.unsafeRecord }
            try DesktopApplicationArchiveOwnership.syncDirectory(path.deletingLastPathComponent())
            return DesktopSnapshotGcLease(publication: publication, usage: usage, metadata: context, data: data, legacy: legacy)
        } catch {
            Darwin.close(publication)
            if let usage { Darwin.close(usage) }
            throw error
        }
    }

    private static func identity(_ descriptor: Int32) throws -> [String: String] {
        var info = stat()
        guard fstat(descriptor, &info) == 0 else { throw Failure.unsafeRecord }
        return ["device": String(info.st_dev), "inode": String(info.st_ino)]
    }

    public func prepareEnvironment(_ environment: [String: String]) throws -> [String: String] {
        var result = try data.prepareEnvironment(environment)
        guard let encoded = result["OMNESIS_DESKTOP_DATA_CONTEXT"], let bytes = Data(base64Encoded: encoded
            .replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/") +
            String(repeating: "=", count: (4 - encoded.count % 4) % 4)),
            var context = try JSONSerialization.jsonObject(with: bytes) as? [String: Any] else { throw Failure.missingAuthority }
        context["reclamation"] = metadata
        var descriptors: [(Int32, Int32)] = [(publication, 8)]
        if let usage { descriptors.append((usage, 9)) }
        for (source, destination) in descriptors {
            guard dup2(source, destination) == destination, fcntl(destination, F_SETFD, 0) == 0 else { throw Failure.unsafeRecord }
        }
        let value = try JSONSerialization.data(withJSONObject: context)
        result["OMNESIS_DESKTOP_DATA_CONTEXT"] = value.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
        try legacy.inheritAcrossExec()
        return result
    }
}
