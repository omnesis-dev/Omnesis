// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import CoreFoundation
import Darwin
import Foundation

/// Application ownership is independent from the immutable runtime's code epoch.
public enum DesktopBackgroundApplicationOrigin {
    public enum State: String, Codable, Sendable { case verified, handoffRequired = "handoff-required", unavailable }
    public enum Presentation: String, Codable, Sendable { case installedOrigin = "installed-origin", retained, unknown }
    public enum Installation: String, Codable,
        Sendable { case current, recoveredVersionInstallNeeded = "recovered-version-install-needed", unknown }
    public struct Evidence: Codable, Equatable, Sendable {
        public let state: State
        public let codeEpoch: String
        public let originEpoch: String?
        public let presentation: Presentation
        public let installation: Installation
        public let installationId: String?
        public init(
            state: State,
            codeEpoch: String,
            originEpoch: String?,
            presentation: Presentation,
            installation: Installation,
            installationId: String? = nil
        ) {
            self.state = state
            self.codeEpoch = codeEpoch
            self.originEpoch = originEpoch
            self.presentation = presentation
            self.installation = installation
            self.installationId = installationId
        }
    }

    /// Same-boot object reference, issued by an authenticated helper or verified live installed Main.
    public struct Record: Codable, Equatable, Sendable {
        public let version: Int
        public let referenceURL: String
        public let device: String
        public let inode: String
        public let observedEpoch: String
        public let revision: String
    }

    public enum Failure: Error { case unavailable, changedObject, retainedApplication }

    public static func capture(_ application: URL) throws -> Record {
        try capture(application, archiveRoot: DesktopApplicationArchive.defaultRoot, validate: DesktopRuntimeBootstrap.validateApplication)
    }

    static func capture(_ application: URL, archiveRoot: URL, validate: (URL) throws -> Void) throws -> Record {
        let path = try DesktopCanonicalPath.resolve(application.path)
        guard path == application.path else { throw Failure.unavailable }
        guard !inside(path, root: archiveRoot.path) else { throw Failure.retainedApplication }
        let before = try identity(application)
        let epoch = try DesktopApplicationArchive.runtimeEpoch(application)
        try validate(application)
        // Keep the object reference in CoreFoundation: bridging it through Swift URL materializes a path.
        guard let created = CFURLCreateFileReferenceURL(kCFAllocatorDefault, application as CFURL, nil) else { throw Failure.unavailable }
        let reference = created.takeRetainedValue()
        guard CFURLIsFileReferenceURL(reference),
              try before == identity(application),
              try DesktopApplicationArchive.runtimeEpoch(application) == epoch else { throw Failure.changedObject }
        let value = Record(
            version: 1,
            referenceURL: CFURLGetString(reference) as String,
            device: before.device,
            inode: before.inode,
            observedEpoch: epoch,
            revision: UUID().uuidString.lowercased()
        )
        guard try JSONEncoder().encode(value).count <= 2048 else { throw Failure.unavailable }
        return value
    }

    public static func resolve(_ record: Record) throws -> URL {
        try resolve(record, archiveRoot: DesktopApplicationArchive.defaultRoot, validate: DesktopRuntimeBootstrap.validateApplication)
    }

    static func resolve(_ record: Record, archiveRoot: URL, validate: (URL) throws -> Void) throws -> URL {
        guard record.version == 1, decimal(record.device), decimal(record.inode), digest(record.observedEpoch),
              UUID(uuidString: record.revision) != nil, record.revision == record.revision.lowercased(),
              record.referenceURL.utf8.count <= 1536,
              let reference = CFURLCreateWithString(kCFAllocatorDefault, record.referenceURL as CFString, nil),
              CFURLIsFileReferenceURL(reference), CFURLCopyScheme(reference).map({ $0 as String }) == "file",
              CFURLCopyQueryString(reference, nil) == nil, CFURLCopyFragment(reference, nil) == nil,
              [nil, "", "localhost"].contains(CFURLCopyHostName(reference).map { $0 as String }),
              let resolved = CFURLCreateFilePathURL(kCFAllocatorDefault, reference, nil) else { throw Failure.unavailable }
        // Convert only the resolved path, never the serialized reference, into Swift URL.
        let path = resolved.takeRetainedValue() as URL
        let application = try URL(fileURLWithPath: DesktopCanonicalPath.resolve(path.path), isDirectory: true)
        guard !inside(application.path, root: archiveRoot.path) else { throw Failure.retainedApplication }
        let before = try identity(application)
        guard before.device == record.device, before.inode == record.inode else { throw Failure.changedObject }
        try validate(application)
        guard try DesktopApplicationArchive.runtimeEpoch(application) == record.observedEpoch,
              try before == identity(application) else { throw Failure.changedObject }
        return application
    }

    public static func isRetained(_ application: URL) throws -> Bool {
        try inside(DesktopCanonicalPath.resolve(application.path), root: DesktopApplicationArchive.defaultRoot.path)
    }

    /// A real native controller -> immutable Node -> live signed Main ancestry establishes a new origin.
    public static func currentInstalledMain(runtime: URL) throws -> Record? {
        let controller = try DesktopBackgroundProcessIdentity.read(getppid())
        var executable = [CChar](repeating: 0, count: 4096)
        guard proc_pidpath(controller.pid, &executable, UInt32(executable.count)) > 0,
              try DesktopCanonicalPath.resolve(String(cString: executable)) == runtime.appendingPathComponent("node").path
        else { throw Failure.unavailable }
        let main = try DesktopBackgroundProcessIdentity.read(controller.parent)
        let peer = try DesktopBackgroundPeerTrust.observer(pid: main.pid)
        let application = peer.executable.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        if try isRetained(application) { return nil }
        let record = try capture(application)
        guard record.observedEpoch == runtime.lastPathComponent,
              try DesktopBackgroundProcessIdentity.read(controller.pid) == controller,
              try DesktopBackgroundProcessIdentity.read(main.pid) == main else { throw Failure.changedObject }
        return record
    }

    public static func evidence(
        record: Record?,
        codeEpoch: String,
        presentationApplication: URL?,
        awaitingHandoff: Bool
    ) throws
        -> Evidence {
        try evidence(
            record: record,
            codeEpoch: codeEpoch,
            presentationApplication: presentationApplication,
            awaitingHandoff: awaitingHandoff,
            archiveRoot: DesktopApplicationArchive.defaultRoot,
            validate: DesktopRuntimeBootstrap.validateApplication
        )
    }

    static func evidence(
        record: Record?,
        codeEpoch: String,
        presentationApplication: URL?,
        awaitingHandoff: Bool,
        archiveRoot: URL,
        validate: (URL) throws -> Void
    ) throws
        -> Evidence {
        guard let record else {
            let retained = try presentationApplication
                .map { try inside(DesktopCanonicalPath.resolve($0.path), root: archiveRoot.path) } ?? false
            return .init(
                state: awaitingHandoff ? .handoffRequired : .unavailable,
                codeEpoch: codeEpoch,
                originEpoch: nil,
                presentation: retained ? .retained : .unknown,
                installation: retained ? .recoveredVersionInstallNeeded : .unknown
            )
        }
        let application = try resolve(record, archiveRoot: archiveRoot, validate: validate)
        var presentation: Presentation = .unknown
        if let candidate = presentationApplication {
            if try inside(DesktopCanonicalPath.resolve(candidate.path), root: archiveRoot.path) { presentation = .retained }
            else if try identity(candidate) == identity(application) { presentation = .installedOrigin }
        }
        let current = presentation == .installedOrigin && codeEpoch == record.observedEpoch
        return .init(
            state: .verified,
            codeEpoch: codeEpoch,
            originEpoch: record.observedEpoch,
            presentation: presentation,
            installation: current ? .current : .recoveredVersionInstallNeeded
        )
    }

    public static func matchesObservedLocation(_ record: Record, location: URL) throws -> Bool {
        try resolve(record).path == DesktopCanonicalPath.resolve(location.path)
    }

    public static func canonicalTrashContains(_ application: URL, trash: URL) throws -> Bool {
        let selected = try DesktopCanonicalPath.resolve(application.path)
        let actualTrash = try DesktopCanonicalPath.resolve(trash.path)
        return inside(selected, root: actualTrash)
    }

    private struct Identity: Equatable { let device: String
        let inode: String
    }

    private static func identity(_ url: URL) throws -> Identity {
        var value = stat()
        guard url.isFileURL, url.pathExtension == "app", lstat(url.path, &value) == 0,
              value.st_mode & S_IFMT == S_IFDIR else { throw Failure.unavailable }
        return .init(device: String(UInt64(bitPattern: Int64(value.st_dev))), inode: String(value.st_ino))
    }

    private static func inside(_ path: String, root: String) -> Bool {
        path.hasPrefix(root + "/")
    }

    private static func decimal(_ value: String) -> Bool {
        UInt64(value).map { String($0) == value } == true
    }

    private static func digest(_ value: String) -> Bool {
        value.count == 64 && value.utf8
            .allSatisfy { (48 ... 57).contains($0) || (97 ... 102).contains($0) }
    }
}
