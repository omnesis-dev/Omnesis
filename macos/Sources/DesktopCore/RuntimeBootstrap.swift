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
        return try DesktopRuntimeCache.prepare(
            source: appBundle.appendingPathComponent("Contents/Resources/runtime", isDirectory: true),
            validateSource: {
                #if !DEBUG
                try validateApp(appBundle)
                #endif
            }
        )
    }

    private static func validateApp(_ app: URL) throws {
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
        let text = "anchor apple generic and identifier \"dev.omnesis.desktop\" and certificate leaf[subject.OU] = \"\(team)\""
        var requirement: SecRequirement?
        guard SecRequirementCreateWithString(text as CFString, [], &requirement) == errSecSuccess else {
            throw DesktopRuntimeCache.Failure.invalidPayload
        }
        var code: SecStaticCode?
        guard SecStaticCodeCreateWithPath(app as CFURL, [], &code) == errSecSuccess, let code,
              SecStaticCodeCheckValidity(code, SecCSFlags(rawValue: kSecCSStrictValidate | kSecCSCheckAllArchitectures), requirement) ==
              errSecSuccess else {
            throw DesktopRuntimeCache.Failure.invalidPayload
        }
    }
}
