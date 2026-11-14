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

    /// Whether this client still speaks for the gateway credential the app holds now.
    func isCurrent(_ current: AccessClient?) -> Bool {
        current?.baseURL == baseURL && current?.token == token
    }

    /// Keep a nested editor bound to the authorization that opened its draft.
    func authorized(for current: AccessClient?) throws -> AccessClient {
        guard isCurrent(current) else { throw GatewayClient.Error.unauthorized }
        return self
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

    public func createLevel(name: String, rules: [AccessGrantRule]) async throws -> AccessLevelSummary {
        struct Body: Encodable { let name: String
            let rules: [AccessGrantRule]
        }
        return try await saveLevel(
            method: "POST",
            path: "/admin/access/levels",
            body: encoder.encode(Body(name: name, rules: rules))
        )
    }

    public func updateLevel(
        id: String,
        name: String,
        rules: [AccessGrantRule],
        expectedRevision: Int,
        expectedFilterRevisions: [String: Int]
    ) async throws
        -> AccessLevelSummary {
        struct Body: Encodable {
            let name: String
            let rules: [AccessGrantRule]
            let expectedRevision: Int
            let expectedFilterRevisions: [String: Int]
        }
        return try await saveLevel(
            method: "PATCH",
            path: "/admin/access/levels/\(percentEncode(id))",
            body: encoder.encode(Body(
                name: name,
                rules: rules,
                expectedRevision: expectedRevision,
                expectedFilterRevisions: expectedFilterRevisions
            ))
        )
    }

    /// The gateway refuses with `level-in-use` while a connection or an integration is on the level.
    public func deleteLevel(id: String) async throws {
        _ = try await dispatch(method: "DELETE", path: "/admin/access/levels/\(percentEncode(id))", body: nil)
    }

    private func saveLevel(method: String, path: String, body: Data) async throws -> AccessLevelSummary {
        struct Reply: Decodable { let level: AccessLevelSummary }
        return try await decodeOrThrow(Reply.self, from: dispatch(method: method, path: path, body: body)).level
    }

    /// The fields a filter on one account can use, each with its state. Returns at once: counts the gateway is
    /// still working out come back pending with `retryAfterMs` set.
    public func filterEditor(sourceId: String) async throws -> SourceFilterEditor {
        let path = "/admin/access/source-filters/\(percentEncode(sourceId))"
        return try await decodeOrThrow(SourceFilterEditor.self, from: scopeRead(method: "GET", path: path, body: nil))
    }

    /// One page of the items a field offers: a search, the top of its tree, the children of `parentId`, or one
    /// device's tree for a field kept per device.
    public func scopeOptions(
        sourceId: String,
        field: String,
        query: String = "",
        parentId: String? = nil,
        device: String? = nil,
        cursor: String? = nil
    ) async throws
        -> ScopeOptions {
        var components = URLComponents()
        components.percentEncodedPath = "/admin/access/source-filters/\(percentEncode(sourceId))/options"
        components.queryItems = [URLQueryItem(name: "field", value: field), URLQueryItem(name: "q", value: query)]
        if let parentId { components.queryItems?.append(URLQueryItem(name: "parentId", value: parentId)) }
        if let device { components.queryItems?.append(URLQueryItem(name: "device", value: device)) }
        if let cursor { components.queryItems?.append(URLQueryItem(name: "cursor", value: cursor)) }
        // URLComponents leaves "+" as it is, and the gateway reads a bare "+" in a query as a space: "+44 7700…"
        // and "c++" must arrive as typed.
        components.percentEncodedQuery = components.percentEncodedQuery?.replacingOccurrences(of: "+", with: "%2B")
        return try await decodeOrThrow(ScopeOptions.self, from: scopeRead(method: "GET", path: components.string!, body: nil))
    }

    public func scopePreview(_ policy: ScopePolicy) async throws -> ScopePreviewResponse {
        struct Body: Encodable { let policy: ScopePolicy }
        let path = "/admin/access/source-filters/\(percentEncode(policy.sourceId))/preview"
        return try await decodeOrThrow(ScopePreviewResponse.self, from: scopeRead(
            method: "POST",
            path: path,
            body: encoder.encode(Body(policy: policy))
        ))
    }

    /// The gateway's reading of a typed phone number, email address or domain.
    public func checkIdentifier(type: String, value: String) async throws -> ScopeIdentifierCheck {
        struct Body: Encodable { let type: String
            let value: String
        }
        let data = try await dispatch(
            method: "POST",
            path: "/admin/access/source-filters/identifiers",
            body: encoder.encode(Body(type: type, value: value))
        )
        return try decodeOrThrow(ScopeIdentifierCheck.self, from: data)
    }

    /// What a filter can see on one document.
    public func documentFilterDetails(documentId: String) async throws -> DocumentFilterDetails {
        let data = try await dispatch(method: "GET", path: "/admin/documents/\(percentEncode(documentId))/filter-details", body: nil)
        return try decodeOrThrow(DocumentFilterDetails.self, from: data)
    }

    /// Which access levels can read one document, and why.
    public func documentAccess(documentId: String) async throws -> DocumentAccessAudit {
        let data = try await dispatch(method: "GET", path: "/admin/documents/\(percentEncode(documentId))/access", body: nil)
        return try decodeOrThrow(DocumentAccessAudit.self, from: data)
    }

    private func scopeRead(method: String, path: String, body: Data?) async throws -> Data {
        let canonical: Data = if let body {
            try JSONSerialization.data(withJSONObject: JSONSerialization.jsonObject(with: body), options: [.sortedKeys])
        } else { Data() }
        let key = [baseURL.absoluteString, token, method, path, canonical.base64EncodedString()].joined(separator: "\n")
        return try await ScopeReadCoordinator.shared.read(key: key) { [self] in
            try await dispatch(method: method, path: path, body: body)
        }
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
        value
            .addingPercentEncoding(
                withAllowedCharacters: CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")
            ) ??
            value
    }
}
