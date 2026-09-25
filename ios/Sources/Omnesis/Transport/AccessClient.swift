// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// Paired-phone client for reviewing pending MCP authorization requests.
/// The notification itself grants no lookup authority: a flow starts from
/// the short code the initiating MCP window displayed, or from the id of a
/// request the overview already lists as waiting.
public final class AccessClient: Sendable {
    public let baseURL: URL
    public let token: String
    private let session: URLSessionLike
    private let decoder = JSONDecoder()
    private let encoder = JSONEncoder()

    public init(baseURL: URL, token: String, session: URLSessionLike = OmnesisURLSession.shared) {
        self.baseURL = baseURL
        self.token = token
        self.session = session
    }

    /// The pending request behind a code, with the access the gateway proposes
    /// reconnecting the client to when it already holds some.
    public func lookup(code: String) async throws -> AccessAuthorizationLookupEnvelope {
        struct Body: Encodable { let code: String }
        let data = try encoder.encode(Body(code: code))
        let response = try await dispatch(
            method: "POST",
            path: "/admin/access/authorizations/lookup",
            body: data
        )
        return try decodeOrThrow(AccessAuthorizationLookupEnvelope.self, from: response)
    }

    /// The same envelope for a request the overview lists as waiting, so the
    /// owner can open it without retyping its code. A request that is unknown
    /// or no longer pending is a `notFound`.
    public func lookup(id: String) async throws -> AccessAuthorizationLookupEnvelope {
        let path = "/admin/access/authorizations/\(percentEncode(id))"
        let response = try await dispatch(method: "GET", path: path, body: nil)
        return try decodeOrThrow(AccessAuthorizationLookupEnvelope.self, from: response)
    }

    public func overview() async throws -> AccessOverview {
        let data = try await dispatch(method: "GET", path: "/admin/access", body: nil)
        return try decodeOrThrow(AccessOverview.self, from: data)
    }

    public func decide(
        approvalId: String,
        decision: AccessAuthorizationDecision
    ) async throws {
        let body = try encoder.encode(decision)
        let path = "/admin/access/authorizations/\(percentEncode(approvalId))/decision"
        _ = try await dispatch(method: "POST", path: path, body: body)
    }

    private func dispatch(method: String, path: String, body: Data?) async throws -> Data {
        guard let requestURL = URL(string: path, relativeTo: baseURL)?.absoluteURL else {
            throw GatewayClient.Error.invalidURL
        }
        var request = URLRequest(url: requestURL)
        request.cachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        request.httpMethod = method
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("no-store", forHTTPHeaderField: "Cache-Control")
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = body
        }
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw GatewayClient.Error.invalidResponse
        }
        switch http.statusCode {
        case 200 ... 299: return data
        case 401: throw GatewayClient.Error.unauthorized
        case 403: throw GatewayClient.Error.forbidden
        case 404: throw GatewayClient.Error.notFound
        case 409: throw GatewayClient.Error.serverError(
                status: http.statusCode,
                body: String(data: data, encoding: .utf8) ?? ""
            )
        default:
            throw GatewayClient.Error.serverError(
                status: http.statusCode,
                body: String(data: data, encoding: .utf8) ?? ""
            )
        }
    }

    private func decodeOrThrow<T: Decodable>(_ type: T.Type, from data: Data) throws -> T {
        do {
            return try decoder.decode(type, from: data)
        } catch {
            throw GatewayClient.Error.decoding("\(error)")
        }
    }

    private func percentEncode(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? value
    }
}
