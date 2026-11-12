// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

public enum NotificationClaimCredentialError: Error, Equatable {
    case insecurePairing
    case invalidResponse
    case serverError(status: Int, body: String)
}

/// Mints and stores the extension's dedicated `push:claim` credential. The
/// app's broader paired token remains in its original keychain group, which
/// the notification-service extension is not entitled to read.
public struct NotificationClaimCredentialProvisioner: Sendable {
    public typealias Request = @Sendable (URLRequest) async throws -> (Data, URLResponse)

    private let pairing: Pairing
    private let store: PairingStore
    private let request: Request

    public init(pairing: Pairing, store: PairingStore, session: URLSessionLike) {
        self.init(pairing: pairing, store: store) { request in
            try await session.data(for: request)
        }
    }

    public init(pairing: Pairing, store: PairingStore, request: @escaping Request) {
        self.pairing = pairing
        self.store = store
        self.request = request
    }

    /// Route-only publication preserves the extension's existing narrow token.
    public static func updateDirectCandidates(pairing: Pairing, store: PairingStore) throws {
        guard pairing.tlsMode.isStrict, let stored = try NotificationClaimCredentials.stored(keychain: store),
              stored.url == pairing.url.absoluteString, stored.deviceId == pairing.deviceId,
              stored.tlsMode == pairing.tlsMode.rawValue, stored.fingerprint == pairing.fingerprint,
              stored.spkiFingerprint == pairing.spkiFingerprint,
              stored.directCandidates != pairing.directCandidates else { return }
        if let candidates = pairing.directCandidates { _ = try GatewayDirectRoute(origin: pairing.url, candidates: candidates) }
        try NotificationClaimCredentials.commit(.init(
            url: stored.url,
            token: stored.token,
            deviceId: stored.deviceId,
            tlsMode: stored.tlsMode,
            fingerprint: stored.fingerprint,
            spkiFingerprint: stored.spkiFingerprint,
            directCandidates: pairing.directCandidates
        ), keychain: store)
    }

    /// Idempotent for one pairing. A changed device id forces rotation before
    /// the new APNs identity is registered, so an old gateway credential is
    /// never paired with the new carrier token.
    public func ensure() async throws {
        let fingerprints = try trustedFingerprints()
        let fingerprint = fingerprints.leaf
        let spkiFingerprint = fingerprints.key
        if let stored = try NotificationClaimCredentials.stored(keychain: store),
           stored.url == pairing.url.absoluteString,
           stored.deviceId == pairing.deviceId,
           stored.tlsMode == pairing.tlsMode.rawValue,
           stored.fingerprint == fingerprint,
           stored.spkiFingerprint == spkiFingerprint,
           !stored.token.isEmpty {
            if stored.directCandidates != pairing.directCandidates {
                try NotificationClaimCredentials.commit(.init(
                    url: stored.url,
                    token: stored.token,
                    deviceId: stored.deviceId,
                    tlsMode: stored.tlsMode,
                    fingerprint: stored.fingerprint,
                    spkiFingerprint: stored.spkiFingerprint,
                    directCandidates: pairing.directCandidates
                ), keychain: store)
            }
            return
        }

        guard let url = URL(string: "/admin/tokens", relativeTo: pairing.url)?.absoluteURL else {
            throw NotificationClaimCredentialError.insecurePairing
        }
        var urlRequest = URLRequest(url: url)
        urlRequest.httpMethod = "POST"
        urlRequest.setValue("Bearer \(pairing.token)", forHTTPHeaderField: "Authorization")
        urlRequest.setValue("application/json", forHTTPHeaderField: "Accept")
        urlRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
        urlRequest.httpBody = try JSONEncoder().encode(
            MintBody(deviceId: pairing.deviceId, scopes: ["push:claim"], name: "notifications")
        )
        let (data, response) = try await request(urlRequest)
        guard let http = response as? HTTPURLResponse else {
            throw NotificationClaimCredentialError.invalidResponse
        }
        guard (200 ... 299).contains(http.statusCode) else {
            throw NotificationClaimCredentialError.serverError(
                status: http.statusCode,
                body: String(data: data, encoding: .utf8) ?? ""
            )
        }
        guard let minted = try? JSONDecoder().decode(MintResponse.self, from: data),
              minted.deviceId == pairing.deviceId,
              minted.scopes == ["push:claim"],
              !minted.token.isEmpty
        else {
            throw NotificationClaimCredentialError.invalidResponse
        }

        try NotificationClaimCredentials.commit(
            .init(
                url: pairing.url.absoluteString,
                token: minted.token,
                deviceId: pairing.deviceId,
                tlsMode: pairing.tlsMode.rawValue,
                fingerprint: fingerprint,
                spkiFingerprint: spkiFingerprint,
                directCandidates: pairing.directCandidates
            ),
            keychain: store
        )
    }

    private func trustedFingerprints() throws -> (leaf: String?, key: String?) {
        guard pairing.url.scheme?.lowercased() == "https" else {
            throw NotificationClaimCredentialError.insecurePairing
        }
        let fingerprint: String?
        var spkiFingerprint: String?
        switch pairing.tlsMode {
        case .system:
            fingerprint = nil
        case .pinnedKeyStrict:
            guard let spki = pairing.spkiFingerprint, spki.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil else {
                throw NotificationClaimCredentialError.insecurePairing
            }
            fingerprint = pairing.fingerprint
            spkiFingerprint = spki.lowercased()
        case .pinnedLeaf, .pinnedLeafStrict:
            guard let value = pairing.fingerprint,
                  value.count == 64,
                  value.allSatisfy(\.isHexDigit)
            else { throw NotificationClaimCredentialError.insecurePairing }
            fingerprint = value.lowercased()
        case .legacy:
            throw NotificationClaimCredentialError.insecurePairing
        }
        return (fingerprint, spkiFingerprint)
    }

    private struct MintBody: Encodable {
        let deviceId: String
        let scopes: [String]
        let name: String
    }

    private struct MintResponse: Decodable {
        let deviceId: String
        let scopes: [String]
        let token: String
    }
}
