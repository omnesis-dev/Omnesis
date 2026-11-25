// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import AppKit
import CryptoKit
import Darwin
import DesktopCore
import Foundation

/// Platform trust and Finder handoff only. Lifecycle, backup and migration policy stay in the runtime.
actor DesktopUpdateInstaller {
    enum Origin: Sendable, Equatable { case installer, currentApplication }
    struct Receipt: Sendable {
        let id: String
        let artifact: URL
        let artifactHash: String
        let oldEpoch: String
        let candidateEpoch: String
        let version: String
        let metadata: BridgeValue
        let payloadBytes: Int64
        let applicationBytes: Int64
        let oldApplicationBytes: Int64
        var origin: Origin = .installer
        var previousMetadata: BridgeValue?
    }

    private struct Mount {
        let point: URL
        let device: String
        let artifact: URL
    }

    private struct MountIntent: Codable {
        let format: Int
        let owner: String
        let id: String
        let artifact: String
        let artifactHash: String
        let point: String
        let bootSession: String
    }

    enum Failure: LocalizedError {
        case untrusted, cleanupPending
        var errorDescription: String? {
            switch self {
            case .untrusted: "This installer could not be verified. Keep your current app and try again."
            case .cleanupPending: "Omnesis could not finish closing its installer volume. Close its Finder window and try again. If an installation was interrupted, restart your Mac and retry. The installer has been kept."
            }
        }
    }

    private let application: URL
    private let runtime: URL
    private let home: URL
    private var receipts: [String: Receipt] = [:]
    private var openedMounts: [Mount] = []
    init(application: URL, runtime: URL, home: URL = FileManager.default.homeDirectoryForCurrentUser) {
        self.application = application
        self.runtime = runtime
        self.home = home
    }

    func verify(
        artifactPath: String,
        artifactHash: String,
        oldEpoch: String,
        version: String,
        architecture: String
    ) async throws
        -> Receipt {
        try await cleanup()
        guard validDigest(artifactHash), validDigest(oldEpoch), runtime.lastPathComponent == oldEpoch,
              ["arm64", "x64"].contains(architecture) else { throw Failure.untrusted }
        let artifact = try artifactURL(artifactPath, hash: artifactHash)
        try verifyArtifact(artifact, hash: artifactHash)
        try assessContainer(artifact)
        let mount = try mount(artifact)
        do {
            let candidate = mount.point.appendingPathComponent("Omnesis.app", isDirectory: true)
            try assess(candidate)
            // Metadata is read only after the enclosing bundle's seal and notary assessment pass.
            let metadataData = try sealedFile(
                candidate.appendingPathComponent("Contents/Resources/runtime/desktop-update.json"),
                maximum: 65536
            )
            let metadata = try JSONDecoder().decode(BridgeValue.self, from: metadataData)
            guard case .object(let values) = metadata, values["productVersion"] == .string(version),
                  values["architecture"] == .string(architecture),
                  values["bundleIdentifier"] == .string("dev.omnesis.desktop") else { throw Failure.untrusted }
            let candidateRuntime = candidate.appendingPathComponent("Contents/Resources/runtime", isDirectory: true)
            let candidateEpoch = try digest(sealedFile(
                candidateRuntime.appendingPathComponent("desktop-runtime.json"),
                maximum: 32 * 1024 * 1024
            ))
            try verifyArtifact(artifact, hash: artifactHash)
            let receipt = try Receipt(
                id: UUID().uuidString,
                artifact: artifact,
                artifactHash: artifactHash,
                oldEpoch: oldEpoch,
                candidateEpoch: candidateEpoch,
                version: version,
                metadata: metadata,
                payloadBytes: byteCount(candidateRuntime),
                applicationBytes: byteCount(candidate),
                oldApplicationBytes: byteCount(application)
            )
            try detach(mount)
            receipts.removeAll()
            receipts[receipt.id] = receipt
            return receipt
        } catch {
            do { try detach(mount) } catch { openedMounts.append(mount)
                throw Failure.cleanupPending
            }
            throw error
        }
    }

    func stage(receiptID: String, artifactHash: String, oldEpoch: String, candidateEpoch: String) async throws {
        let receipt = try checkedReceipt(receiptID, artifactHash: artifactHash, oldEpoch: oldEpoch, candidateEpoch: candidateEpoch)
        try retainCurrentApplication(epoch: oldEpoch)
        let mount = try mount(receipt.artifact)
        do {
            let candidate = mount.point.appendingPathComponent("Omnesis.app", isDirectory: true)
            try assess(candidate)
            let candidateRuntime = candidate.appendingPathComponent("Contents/Resources/runtime", isDirectory: true)
            guard try digest(sealedFile(candidateRuntime.appendingPathComponent("desktop-runtime.json"), maximum: 32 * 1024 * 1024)) ==
                candidateEpoch else { throw Failure.untrusted }
            let staged = try DesktopRuntimeCache.prepare(
                source: candidateRuntime,
                validateSource: { try DesktopRuntimeBootstrap.validateApplication(candidate) }
            )
            guard staged.lastPathComponent == candidateEpoch else { throw Failure.untrusted }
            try verifyArtifact(receipt.artifact, hash: artifactHash)
            try detach(mount)
        } catch {
            do { try detach(mount) } catch { openedMounts.append(mount)
                throw Failure.cleanupPending
            }
            throw error
        }
    }

    func openInstaller(receiptID: String, artifactHash: String, oldEpoch: String, candidateEpoch: String) async throws {
        let receipt = try checkedReceipt(receiptID, artifactHash: artifactHash, oldEpoch: oldEpoch, candidateEpoch: candidateEpoch)
        let mount = try mount(receipt.artifact)
        do {
            try assess(mount.point.appendingPathComponent("Omnesis.app", isDirectory: true))
            try verifyArtifact(receipt.artifact, hash: artifactHash)
            try Task.checkCancellation()
            let opened = await MainActor.run { NSWorkspace.shared.open(mount.point) }
            guard opened else { throw Failure.untrusted }
            openedMounts.append(mount)
        } catch {
            do { try detach(mount) } catch { openedMounts.append(mount)
                throw Failure.cleanupPending
            }
            throw error
        }
    }

    func verifyPrevious(epoch: String, expectedVersion: String) async throws {
        _ = try previousApplication(epoch: epoch, expectedVersion: expectedVersion)
    }

    func verifyCurrent() async throws -> Receipt {
        try await cleanup()
        try verifyExecutingApplication()
        let active = try activeRuntime()
        let oldEpoch = active.epoch
        let candidateEpoch = runtime.lastPathComponent
        guard oldEpoch != candidateEpoch else { throw Failure.untrusted }
        let previous = try previousApplication(epoch: oldEpoch, expectedVersion: active.version)
        let metadata = try applicationMetadata(application)
        let previousMetadata = try applicationMetadata(previous)
        guard case .object(let values) = metadata, case .string(let version)? = values["productVersion"] else { throw Failure.untrusted }
        let receipt = try Receipt(
            id: UUID().uuidString,
            artifact: application,
            artifactHash: candidateEpoch,
            oldEpoch: oldEpoch,
            candidateEpoch: candidateEpoch,
            version: version,
            metadata: metadata,
            payloadBytes: byteCount(runtime),
            applicationBytes: byteCount(application),
            oldApplicationBytes: byteCount(previous),
            origin: .currentApplication,
            previousMetadata: previousMetadata
        )
        receipts.removeAll()
        receipts[receipt.id] = receipt
        return receipt
    }

    func stageCurrent(receiptID: String, oldEpoch: String, candidateEpoch: String) async throws {
        guard let receipt = receipts[receiptID], receipt.origin == .currentApplication,
              receipt.oldEpoch == oldEpoch, receipt.candidateEpoch == candidateEpoch,
              runtime.lastPathComponent == candidateEpoch else { throw Failure.untrusted }
        try verifyExecutingApplication()
        guard try activeRuntime().epoch == oldEpoch else { throw Failure.untrusted }
        let previous = try applicationMetadata(applicationsRoot.appendingPathComponent(oldEpoch).appendingPathComponent("Omnesis.app"))
        guard previous == receipt.previousMetadata else { throw Failure.untrusted }
        try assess(applicationsRoot.appendingPathComponent(oldEpoch).appendingPathComponent("Omnesis.app"))
        guard try applicationMetadata(application) == receipt.metadata else { throw Failure.untrusted }
    }

    func activateCurrent(receiptID: String, oldEpoch: String, candidateEpoch: String) async throws {
        try await stageCurrent(receiptID: receiptID, oldEpoch: oldEpoch, candidateEpoch: candidateEpoch)
    }

    private func verifyExecutingApplication() throws {
        guard application.standardizedFileURL == Bundle.main.bundleURL.standardizedFileURL,
              Bundle.main.bundleIdentifier == "dev.omnesis.desktop",
              try DesktopApplicationArchive.runtimeEpoch(application) == runtime.lastPathComponent else { throw Failure.untrusted }
        #if !DEBUG
        try assess(application)
        #endif
    }

    private func applicationMetadata(_ app: URL) throws -> BridgeValue {
        let result = try JSONDecoder().decode(
            BridgeValue.self,
            from: sealedFile(app.appendingPathComponent("Contents/Resources/runtime/desktop-update.json"), maximum: 65536)
        )
        guard case .object(let values) = result, values["bundleIdentifier"] == .string("dev.omnesis.desktop"),
              case .string(let version)? = values["productVersion"],
              Bundle(url: app)?.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String == version
        else { throw Failure.untrusted }
        return result
    }

    private func activeRuntime() throws -> (epoch: String, version: String) {
        let config = home.appendingPathComponent("Library/Application Support/Omnesis Desktop", isDirectory: true)
        let directory = URL(fileURLWithPath: config.path + ".bootstrap", isDirectory: true)
        try privateDirectory(directory, create: false)
        let path = directory.appendingPathComponent("active-runtime.json")
        var info = stat()
        guard lstat(path.path, &info) == 0, info.st_mode & S_IFMT == S_IFREG, info.st_nlink == 1,
              info.st_uid == getuid(), info.st_mode & 0o077 == 0 else { throw Failure.untrusted }
        let value = try JSONDecoder().decode(BridgeValue.self, from: sealedFile(path, maximum: 16384))
        let identity = digest(Data(config.path.utf8))
        guard case .object(let values) = value, values["format"] == .number(1), values["owner"] == .string("omnesis-desktop"),
              values["instance"] == .string("desktop-" + String(identity.prefix(16))),
              values["secretService"] == .string("dev.omnesis.desktop." + identity),
              case .string(let epoch)? = values["epoch"], validDigest(epoch),
              case .string(let version)? = values["productVersion"] else { throw Failure.untrusted }
        return (epoch, version)
    }

    private func previousApplication(epoch: String, expectedVersion: String) throws -> URL {
        guard validDigest(epoch) else { throw Failure.untrusted }
        let app = applicationsRoot.appendingPathComponent(epoch, isDirectory: true).appendingPathComponent("Omnesis.app", isDirectory: true)
        try assess(app)
        let manifest = app.appendingPathComponent("Contents/Resources/runtime/desktop-runtime.json")
        guard try digest(sealedFile(manifest, maximum: 32 * 1024 * 1024)) == epoch,
              let info = Bundle(url: app),
              info.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String == expectedVersion else { throw Failure.untrusted }
        return app
    }

    func openPrevious(epoch: String, expectedVersion: String) async throws {
        try await cleanup()
        let app = try previousApplication(epoch: epoch, expectedVersion: expectedVersion)
        let reservation = try DesktopApplicationLaunchReservation.reserve(application: app, epoch: epoch) {
            try DesktopRuntimeBootstrap.validateApplication($0)
        }
        // A failed/uncertain launch intentionally retains its reservation for conservative GC.
        try await Self.openRetainedApplication(app, epoch: epoch, reservation: reservation)
    }

    func cleanup() async throws {
        try recoverMountIntents()
        var pending: [Mount] = []
        for mount in openedMounts {
            do { try detach(mount) } catch { pending.append(mount) }
        }
        openedMounts = pending
        guard pending.isEmpty else { throw Failure.cleanupPending }
    }

    private var applicationsRoot: URL {
        home.appendingPathComponent(
            "Library/Application Support/Omnesis Desktop Runtime/applications",
            isDirectory: true
        )
    }

    private var updatesRoot: URL {
        home.appendingPathComponent(
            "Library/Application Support/Omnesis Desktop.bootstrap/updates",
            isDirectory: true
        )
    }

    private func checkedReceipt(_ id: String, artifactHash: String, oldEpoch: String, candidateEpoch: String) throws -> Receipt {
        guard let receipt = receipts[id], receipt.origin == .installer, receipt.artifactHash == artifactHash, receipt.oldEpoch == oldEpoch,
              receipt.candidateEpoch == candidateEpoch, runtime.lastPathComponent == oldEpoch else { throw Failure.untrusted }
        guard openedMounts.isEmpty else { throw Failure.cleanupPending }
        try verifyArtifact(receipt.artifact, hash: artifactHash)
        try assessContainer(receipt.artifact)
        return receipt
    }

    private func artifactURL(_ path: String, hash: String) throws -> URL {
        let expected = updatesRoot.appendingPathComponent(hash + ".dmg")
        guard URL(fileURLWithPath: path).standardizedFileURL == expected,
              expected.resolvingSymlinksInPath() == expected else { throw Failure.untrusted }
        try privateDirectory(updatesRoot.deletingLastPathComponent(), create: false)
        try privateDirectory(updatesRoot, create: false)
        return expected
    }

    private func verifyArtifact(_ artifact: URL, hash: String) throws {
        _ = try artifactURL(artifact.path, hash: hash)
        let descriptor = Darwin.open(artifact.path, O_RDONLY | O_NOFOLLOW)
        guard descriptor >= 0 else { throw Failure.untrusted }
        let file = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
        defer { try? file.close() }
        var before = stat()
        guard fstat(descriptor, &before) == 0, before.st_mode & S_IFMT == S_IFREG, before.st_nlink == 1,
              before.st_uid == getuid(), before.st_mode & 0o077 == 0, before.st_size > 0,
              before.st_size <= 16 * 1024 * 1024 * 1024 else { throw Failure.untrusted }
        var hasher = SHA256()
        while let data = try file.read(upToCount: 1024 * 1024), !data.isEmpty {
            try Task.checkCancellation()
            hasher.update(data: data)
        }
        var after = stat()
        guard fstat(descriptor, &after) == 0, before.st_size == after.st_size, before.st_mtimespec.tv_sec == after.st_mtimespec.tv_sec,
              before.st_mtimespec.tv_nsec == after.st_mtimespec.tv_nsec,
              hasher.finalize().map({ String(format: "%02x", $0) }).joined() == hash else { throw Failure.untrusted }
    }

    private func retainCurrentApplication(epoch: String) throws {
        _ = try DesktopApplicationArchive.retain(
            application: application,
            epoch: epoch,
            root: applicationsRoot,
            publicationRoot: runtime.deletingLastPathComponent()
        ) {
            try assess($0)
        }
    }

    private func assessContainer(_ artifact: URL) throws {
        try run(
            "/usr/bin/xattr",
            [
                "-w",
                "com.apple.quarantine",
                "0083;\(String(Int(Date().timeIntervalSince1970), radix: 16));Omnesis Desktop;\(UUID().uuidString)",
                artifact.path,
            ]
        )
        try DesktopRuntimeBootstrap.validateInstallerContainer(artifact)
        try run("/usr/sbin/spctl", ["--assess", "--type", "open", "--context", "context:primary-signature", "--verbose=2", artifact.path])
    }

    private func assess(_ app: URL) throws {
        guard app.resolvingSymlinksInPath() == app.standardizedFileURL else { throw Failure.untrusted }
        try DesktopRuntimeBootstrap.validateApplication(app)
        try run("/usr/sbin/spctl", ["--assess", "--type", "execute", "--verbose=2", app.path])
    }

    private func mount(_ artifact: URL) throws -> Mount {
        let root = updatesRoot.appendingPathComponent("mounts", isDirectory: true)
        try privateDirectory(root, create: true)
        let point = root.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try privateDirectory(point, create: true)
        try writeMountIntent(point: point, artifact: artifact)
        let data = try run(
            "/usr/bin/hdiutil",
            [
                "attach",
                "-readonly",
                "-nobrowse",
                "-noautoopen",
                "-mountOptions",
                "noexec,nodev,nosuid",
                "-mountpoint",
                point.path,
                "-plist",
                artifact.path,
            ]
        )
        guard let plist = try PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any],
              let entities = plist["system-entities"] as? [[String: Any]],
              let entity = entities.first(where: { $0["mount-point"] as? String == point.path }),
              let device = entity["dev-entry"] as? String,
              device.range(of: #"^/dev/disk[0-9]+(s[0-9]+)*$"#, options: .regularExpression) != nil else { throw Failure.cleanupPending }
        return Mount(point: point, device: device, artifact: artifact)
    }

    private func detach(_ mount: Mount) throws {
        let data = try run("/usr/bin/hdiutil", ["info", "-plist"])
        guard let plist = try PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any],
              let images = plist["images"] as? [[String: Any]],
              images.contains(where: { image in
                  guard image["image-path"] as? String == mount.artifact.path,
                        let entities = image["system-entities"] as? [[String: Any]] else { return false }
                  return entities
                      .contains { $0["dev-entry"] as? String == mount.device && $0["mount-point"] as? String == mount.point.path }
              }) else { throw Failure.cleanupPending }
        try run("/usr/bin/hdiutil", ["detach", mount.device])
        try removeMountIntent(point: mount.point)
    }

    private var mountIntentRoot: URL {
        updatesRoot.appendingPathComponent("mount-intents", isDirectory: true)
    }

    private func writeMountIntent(point: URL, artifact: URL) throws {
        try privateDirectory(mountIntentRoot, create: true)
        let hash = artifact.deletingPathExtension().lastPathComponent
        guard validDigest(hash), UUID(uuidString: point.lastPathComponent) != nil else { throw Failure.untrusted }
        let intent = try MountIntent(
            format: 1,
            owner: "omnesis-desktop-installer-mount",
            id: point.lastPathComponent,
            artifact: artifact.path,
            artifactHash: hash,
            point: point.path,
            bootSession: bootSession()
        )
        let file = try PrivateSaveFile(url: mountIntentRoot.appendingPathComponent(intent.id + ".json"))
        try file.append(JSONEncoder().encode(intent))
        try file.finish()
        let descriptor = Darwin.open(mountIntentRoot.path, O_RDONLY | O_NOFOLLOW)
        guard descriptor >= 0 else { throw Failure.cleanupPending }
        defer { Darwin.close(descriptor) }
        guard fsync(descriptor) == 0 else { throw Failure.cleanupPending }
    }

    /// A restart recovers only our durable intents and exact hdiutil image/mount pairs.
    private func recoverMountIntents() throws {
        guard FileManager.default.fileExists(atPath: mountIntentRoot.path) else { return }
        try privateDirectory(mountIntentRoot, create: false)
        let paths = try FileManager.default.contentsOfDirectory(at: mountIntentRoot, includingPropertiesForKeys: nil)
        guard paths.count <= 64 else { throw Failure.cleanupPending }
        guard !paths.isEmpty else { return }
        let data = try run("/usr/bin/hdiutil", ["info", "-plist"])
        guard let plist = try PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any],
              let images = plist["images"] as? [[String: Any]] else { throw Failure.cleanupPending }
        for path in paths {
            var fileInfo = stat()
            guard lstat(path.path, &fileInfo) == 0, fileInfo.st_uid == getuid(), fileInfo.st_nlink == 1,
                  fileInfo.st_mode & S_IFMT == S_IFREG, fileInfo.st_mode & 0o077 == 0 else { throw Failure.cleanupPending }
            let intent = try JSONDecoder().decode(MountIntent.self, from: sealedFile(path, maximum: 16384))
            let point = updatesRoot.appendingPathComponent("mounts").appendingPathComponent(intent.id)
            guard intent.format == 1, intent.owner == "omnesis-desktop-installer-mount",
                  UUID(uuidString: intent.id)?.uuidString == intent.id,
                  path.lastPathComponent == intent.id + ".json", intent.point == point.path,
                  validDigest(intent.artifactHash),
                  intent.artifact == updatesRoot.appendingPathComponent(intent.artifactHash + ".dmg").path
            else { throw Failure.cleanupPending }
            try verifyArtifact(URL(fileURLWithPath: intent.artifact), hash: intent.artifactHash)
            let matches = images.filter { $0["image-path"] as? String == intent.artifact }
            if matches.isEmpty {
                // A killed attach may still be completing in disk arbitration. Only a new
                // boot establishes that no late attachment from that operation can appear.
                guard try intent.bootSession != bootSession() else { throw Failure.cleanupPending }
                try removeMountIntent(point: point)
                continue
            }
            guard matches.count == 1,
                  let entities = matches[0]["system-entities"] as? [[String: Any]],
                  let entity = entities.first(where: { $0["mount-point"] as? String == point.path }),
                  let device = entity["dev-entry"] as? String,
                  device.range(of: #"^/dev/disk[0-9]+(s[0-9]+)*$"#, options: .regularExpression) != nil
            else { throw Failure.cleanupPending }
            if !openedMounts.contains(where: { $0.point == point }) {
                openedMounts.append(Mount(point: point, device: device, artifact: URL(fileURLWithPath: intent.artifact)))
            }
        }
    }

    private func removeMountIntent(point: URL) throws {
        if FileManager.default.fileExists(atPath: point.path) {
            try privateDirectory(point, create: false)
            guard try FileManager.default.contentsOfDirectory(atPath: point.path).isEmpty else { throw Failure.cleanupPending }
            try FileManager.default.removeItem(at: point)
        }
        let path = mountIntentRoot.appendingPathComponent(point.lastPathComponent + ".json")
        try FileManager.default.removeItem(at: path)
    }

    private func sealedFile(_ url: URL, maximum: Int) throws -> Data {
        let descriptor = Darwin.open(url.path, O_RDONLY | O_NOFOLLOW)
        guard descriptor >= 0 else { throw Failure.untrusted }
        let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
        defer { try? handle.close() }
        var info = stat()
        guard fstat(descriptor, &info) == 0, info.st_mode & S_IFMT == S_IFREG, info.st_size > 0,
              info.st_size <= maximum, let data = try handle.read(upToCount: maximum + 1),
              data.count <= maximum else { throw Failure.untrusted }
        return data
    }

    private func byteCount(_ root: URL) throws -> Int64 {
        guard let enumerator = FileManager.default.enumerator(
            at: root,
            includingPropertiesForKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey]
        ) else { throw Failure.untrusted }
        var total: Int64 = 0
        for case let url as URL in enumerator {
            try Task.checkCancellation()
            let values = try url.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey])
            if values.isSymbolicLink == true { enumerator.skipDescendants()
                continue
            }
            if values.isRegularFile == true { total += Int64(values.fileSize ?? 0) }
        }
        return total
    }

    private func privateDirectory(_ url: URL, create: Bool) throws {
        if create { try FileManager.default.createDirectory(
            at: url,
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700]
        ) }
        var info = stat()
        guard lstat(url.path, &info) == 0, info.st_mode & S_IFMT == S_IFDIR, info.st_mode & 0o077 == 0,
              info.st_uid == getuid(), url.resolvingSymlinksInPath() == url.standardizedFileURL else { throw Failure.untrusted }
    }

    private func validDigest(_ value: String) -> Bool {
        value.count == 64 && value.allSatisfy { "0123456789abcdef".contains($0) }
    }

    private func bootSession() throws -> String {
        var bytes = [CChar](repeating: 0, count: 128)
        var size = bytes.count
        guard sysctlbyname("kern.bootsessionuuid", &bytes, &size, nil, 0) == 0,
              size > 1, size <= bytes.count,
              let value = String(validatingCString: bytes), UUID(uuidString: value) != nil else { throw Failure.cleanupPending }
        return value
    }

    private func digest(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    @discardableResult private func run(_ executable: String, _ arguments: [String]) throws -> Data {
        try DesktopUpdatePlatformCommand.run(executable, arguments, home: home)
    }

    @MainActor private static func openRetainedApplication(_ app: URL, epoch: String, reservation: String) async throws {
        try Task.checkCancellation()
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.createsNewApplicationInstance = true
        let previousRuntime = DesktopRuntimeCache.defaultRoot.appendingPathComponent(epoch)
        var environment = DesktopRuntimeEnvironment.child(parent: ProcessInfo.processInfo.environment, runtime: previousRuntime)
        environment["HOME"] = FileManager.default.homeDirectoryForCurrentUser.path
        environment[DesktopApplicationLaunchReservation.environmentKey] = reservation
        configuration.environment = environment
        _ = try await NSWorkspace.shared.openApplication(at: app, configuration: configuration)
    }
}
