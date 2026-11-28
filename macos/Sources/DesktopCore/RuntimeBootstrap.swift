// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
import Security

public enum DesktopRuntimeBootstrap {
    /// The executing native shell supplies the signing identity; a downloaded manifest is never a trust root.
    public static func prepare(appBundle: URL, environment: [String: String] = ProcessInfo.processInfo.environment) throws -> URL {
        #if DEBUG
        if let override = environment["OMNESIS_DESKTOP_RUNTIME_DIR"], !override.isEmpty {
            return try DesktopRuntimeCache.prepare(source: URL(fileURLWithPath: override, isDirectory: true), validateSource: {})
        }
        #endif
        let bundledRuntime = appBundle.appendingPathComponent("Contents/Resources/runtime", isDirectory: true)
        guard FileManager.default.fileExists(atPath: bundledRuntime.path) else {
            throw DesktopRuntimeCache.Failure.missingPayload
        }
        let runtime = try DesktopRuntimeCache.prepare(
            source: bundledRuntime,
            validateSource: {
                #if !DEBUG
                try validateApplication(appBundle)
                #endif
            }
        )
        _ = try DesktopApplicationArchive.retain(application: appBundle, epoch: runtime.lastPathComponent) { app in
            #if DEBUG
            guard isExecutingApplication(appBundle) else { throw DesktopRuntimeCache.Failure.invalidPayload }
            #else
            try validateApplication(app)
            #endif
        }
        return runtime
    }

    #if DEBUG
    private static func isExecutingApplication(_ app: URL) -> Bool {
        let executing = Bundle.main.bundleURL.standardizedFileURL
        if executing == app.standardizedFileURL { return true }
        guard Bundle.main.bundleIdentifier == "dev.omnesis.desktop.background" else { return false }
        let outer = executing.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent()
        return outer == app.standardizedFileURL
    }
    #endif

    /// Trust checks are enforced in every build; DEBUG bypass exists only in prepare.
    public static func validateApplication(_ app: URL) throws {
        try validateSignedCode(app, identifier: "dev.omnesis.desktop")
    }

    public static func validateInstallerContainer(_ container: URL) throws {
        guard container.isFileURL, container.pathExtension.lowercased() == "dmg",
              container.resolvingSymlinksInPath() == container.standardizedFileURL else {
            throw DesktopRuntimeCache.Failure.invalidPayload
        }
        guard try container.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile == true else {
            throw DesktopRuntimeCache.Failure.invalidPayload
        }
        try validateSignedCode(container, identifier: nil)
    }

    private static func validateSignedCode(_ app: URL, identifier: String?) throws {
        var ownCode: SecCode?
        guard SecCodeCopySelf([], &ownCode) == errSecSuccess, let ownCode,
              SecCodeCheckValidity(ownCode, [], nil) == errSecSuccess else {
            throw DesktopRuntimeCache.Failure.invalidPayload
        }
        var ownStaticCode: SecStaticCode?
        guard SecCodeCopyStaticCode(ownCode, [], &ownStaticCode) == errSecSuccess,
              let ownStaticCode else {
            throw DesktopRuntimeCache.Failure.invalidPayload
        }
        var information: CFDictionary?
        guard SecCodeCopySigningInformation(ownStaticCode, SecCSFlags(rawValue: kSecCSSigningInformation), &information) == errSecSuccess,
              let values = information as? [String: Any],
              let team = values[kSecCodeInfoTeamIdentifier as String] as? String,
              team.count == 10, team.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber) }) else {
            throw DesktopRuntimeCache.Failure.invalidPayload
        }
        let identifierClause = identifier.map { " and identifier \"\($0)\"" } ?? ""
        let text = "anchor apple generic\(identifierClause) and certificate leaf[subject.OU] = \"\(team)\""
        var requirement: SecRequirement?
        guard SecRequirementCreateWithString(text as CFString, [], &requirement) == errSecSuccess else {
            throw DesktopRuntimeCache.Failure.invalidPayload
        }
        var code: SecStaticCode?
        guard SecStaticCodeCreateWithPath(app as CFURL, [], &code) == errSecSuccess, let code,
              SecStaticCodeCheckValidity(
                  code,
                  SecCSFlags(rawValue: kSecCSStrictValidate | kSecCSCheckAllArchitectures | kSecCSCheckNestedCode),
                  requirement
              ) ==
              errSecSuccess else {
            throw DesktopRuntimeCache.Failure.invalidPayload
        }
    }
}
