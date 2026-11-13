// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// Thin HTTP wrapper used by PairingService to exchange a pairing code
/// for a device token. Mockable in tests.
public protocol PairingExchangeHTTP: Sendable {
    /// POST `{gatewayUrl}/devices/pair` with `{pairingCode, capabilities}`.
    /// Throws on non-2xx or decoding failure.
    func exchange(
        gatewayUrl: URL,
        pairingCode: String,
        capabilities: PairingCapabilities
    ) async throws
        -> DevicePairResponse
}

/// Default URLSession-backed exchange client.
///
/// Accepts an optional `URLSessionLike` so the V3 path can hand it a
/// `PinnedSession.session` that pins the gateway's self-signed cert
/// fingerprint on every challenge. Defaults to `URLSession.shared`
/// for V1/V2 legacy paths where pinning isn't negotiated.
public struct URLSessionPairingExchange: PairingExchangeHTTP {
    private let session: URLSessionLike

    public init(session: URLSessionLike = URLSession.shared) {
        self.session = session
    }

    public init(ownedSession: URLSession) {
        session = GatewayOwnedSession(ownedSession)
    }

    public func exchange(
        gatewayUrl: URL,
        pairingCode: String,
        capabilities: PairingCapabilities
    ) async throws
        -> DevicePairResponse {
        guard var components = URLComponents(url: gatewayUrl, resolvingAgainstBaseURL: false) else {
            throw PairingPayloadError.invalidURL
        }
        // Append `/devices/pair` to whatever path the base URL already has.
        let basePath = components.path.hasSuffix("/") ? components.path : (components.path + "/")
        components.path = basePath + "devices/pair"
        components.percentEncodedQuery = nil
        guard let requestURL = components.url else {
            throw PairingPayloadError.invalidURL
        }

        var request = URLRequest(url: requestURL)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")

        struct Body: Encodable {
            let pairingCode: String
            let capabilities: PairingCapabilities
        }
        let body = Body(pairingCode: pairingCode, capabilities: capabilities)
        request.httpBody = try JSONEncoder().encode(body)

        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw GatewayClient.Error.invalidResponse
        }
        if !(200 ... 299).contains(http.statusCode) {
            let text = String(data: data, encoding: .utf8) ?? ""
            throw GatewayClient.Error.serverError(status: http.statusCode, body: text)
        }
        do {
            return try JSONDecoder().decode(DevicePairResponse.self, from: data)
        } catch {
            throw GatewayClient.Error.decoding("\(error)")
        }
    }
}
