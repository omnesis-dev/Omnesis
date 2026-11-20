// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// Google sign-in to the cloud account: the build's iOS OAuth client, valid only when the app
/// registers its callback scheme (the reversed client ID).
struct GoogleCloudPairingConfiguration: Sendable {
    let clientId: String

    static func configured(bundle: Bundle = .main) -> GoogleCloudPairingConfiguration? {
        guard let id = bundle.object(forInfoDictionaryKey: "OmnesisGoogleClientID") as? String,
              id.hasSuffix(".apps.googleusercontent.com"), !id.contains("$(") else { return nil }
        let scheme = id.split(separator: ".").reversed().joined(separator: ".")
        let entries = bundle.object(forInfoDictionaryKey: "CFBundleURLTypes") as? [[String: Any]] ?? []
        guard entries.contains(where: { ($0["CFBundleURLSchemes"] as? [String])?.contains(scheme) == true }) else { return nil }
        return GoogleCloudPairingConfiguration(clientId: id)
    }
}

@MainActor
protocol GooglePairingBrowser: AnyObject {
    func signIn(_ authorization: GoogleNativeAuthorization) async throws -> URL
    func cancel()
}
