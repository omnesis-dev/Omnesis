// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Darwin
import Foundation

/// Verified product metadata is deliberately separate from TCC responsibility.
public enum DesktopPermissionApplication {
    public enum ReaderAttribution: String, Sendable {
        /// No signed distribution / controlled permission matrix has proved the
        /// detached helper -> cached runtime -> collector attribution yet.
        case unverified
    }

    public struct VerifiedApplication: Equatable, Sendable {
        public let displayName: String
        public let applicationURL: URL
        public let bundleIdentifier: String
        public let readerAttribution: ReaderAttribution
    }

    /// Does not read protected stores, query TCC, or request any permission.
    /// Ad-hoc builds cannot supply a stable Apple-issued signing identity.
    public static func current() -> VerifiedApplication? {
        resolve(bundleURL: Bundle.main.bundleURL, identifier: Bundle.main.bundleIdentifier) { application in
            try DesktopRuntimeBootstrap.validateApplication(application)
        }
    }

    enum Refusal: String { case bundlePath, helperLocation, productMetadata, executable, signing }

    static func resolve(
        bundleURL: URL,
        identifier: String?,
        onRefusal: ((Refusal) -> Void)? = nil,
        validate: (URL) throws -> Void
    )
        -> VerifiedApplication? {
        func refuse(_ stage: Refusal) -> VerifiedApplication? {
            onRefusal?(stage)
            return nil
        }
        guard bundleURL.isFileURL else { return refuse(.bundlePath) }
        let ownPath = bundleURL.path
        var own = stat()
        guard (try? DesktopCanonicalPath.resolve(ownPath)) == ownPath,
              lstat(ownPath, &own) == 0, own.st_mode & S_IFMT == S_IFDIR else { return refuse(.bundlePath) }
        let applicationPath: String
        switch identifier {
        case "dev.omnesis.desktop": applicationPath = ownPath
        case "dev.omnesis.desktop.background":
            let suffix = "/Contents/Library/LoginItems/OmnesisBackground.app"
            guard ownPath.hasSuffix(suffix) else { return refuse(.helperLocation) }
            applicationPath = String(ownPath.dropLast(suffix.count))
        default: return refuse(.helperLocation)
        }
        let application = URL(fileURLWithPath: applicationPath, isDirectory: true)
        guard application.pathExtension == "app",
              (try? DesktopCanonicalPath.resolve(applicationPath)) == applicationPath,
              let bundle = Bundle(url: application), bundle.bundleIdentifier == "dev.omnesis.desktop",
              bundle.object(forInfoDictionaryKey: "CFBundlePackageType") as? String == "APPL",
              bundle.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String == "Omnesis",
              let name = bundle.object(forInfoDictionaryKey: "CFBundleExecutable") as? String,
              !name.isEmpty, name.utf8.count <= 128, !name.contains("/"), !name.contains("\\"),
              name != ".", name != ".." else { return refuse(.productMetadata) }
        // Bundle.executableURL and NSURL standardization can spell Darwin's
        // canonical /private/var as /var. Validate the signed metadata's fixed
        // executable location using the same POSIX path rules as runtime guards.
        let executable = applicationPath + "/Contents/MacOS/" + name
        var binary = stat()
        guard (try? DesktopCanonicalPath.resolve(executable)) == executable,
              lstat(executable, &binary) == 0, binary.st_mode & S_IFMT == S_IFREG,
              FileManager.default.isExecutableFile(atPath: executable) else { return refuse(.executable) }
        do { try validate(application) } catch { return refuse(.signing) }
        return VerifiedApplication(
            displayName: "Omnesis", applicationURL: application,
            bundleIdentifier: "dev.omnesis.desktop", readerAttribution: .unverified
        )
    }
}
