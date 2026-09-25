// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// Admin-scoped client for the answer privacy boundary.
///
/// List responses intentionally carry metadata only. The held candidate answer
/// is fetched from the single-approval route after the user opens its trusted
/// detail screen; it never appears in a push payload or the dashboard list.
public final class PrivacyClient: Sendable {
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

    /// Every policy family on the gateway, retired ones included, without
    /// their text. Which families exist is a small catalogue; each document is
    /// fetched on its own once the owner opens it.
    public func listPolicyFamilies() async throws -> [PrivacyPolicyFamilySummary] {
        let (data, _) = try await dispatch(method: "GET", path: "/admin/privacy/policies", body: nil)
        return try decodeOrThrow(PrivacyPolicyFamilyCatalogue.self, from: data).policies
    }

    /// One policy family's current text — the document a grant, a review or
    /// the Settings list points at.
    public func getPolicyFamily(id: String) async throws -> PrivacyPolicyDocument {
        let path = "/admin/privacy/policies/\(percentEncode(id))"
        let (data, _) = try await dispatch(method: "GET", path: path, body: nil)
        return try decodeOrThrow(PrivacyPolicyDocument.self, from: data)
    }

    public func getReviewerHealth() async throws -> PrivacyReviewerHealth {
        let (data, _) = try await dispatch(
            method: "GET",
            path: "/admin/privacy/reviewer-health",
            body: nil
        )
        return try decodeOrThrow(PrivacyReviewerHealth.self, from: data)
    }

    public func getApproval(id: String) async throws -> PrivacyApprovalDetail {
        let path = "/admin/privacy/approvals/\(percentEncode(id))"
        let (data, _) = try await dispatch(method: "GET", path: path, body: nil)
        struct Wrap: Decodable { let approval: PrivacyApprovalDetail }
        return try decodeOrThrow(Wrap.self, from: data).approval
    }

    /// A page of the approval ledger. The page's `totalCount` is the exact
    /// size of the matching set, so a caller that wants only the number of
    /// open decisions asks for a single row rather than paging the ledger.
    public func listApprovals(
        status: String = "pending",
        limit: Int = 50,
        cursor: String? = nil
    ) async throws
        -> PrivacyApprovalPage {
        var path = "/admin/privacy/approvals?status=\(queryEncode(status))&limit=\(limit)"
        if let cursor {
            path += "&cursor=\(queryEncode(cursor))"
        }
        let (data, _) = try await dispatch(method: "GET", path: path, body: nil)
        return try decodeOrThrow(PrivacyApprovalPage.self, from: data)
    }

    @discardableResult
    public func approve(id: String) async throws -> PrivacyApprovalResolution {
        let path = "/admin/privacy/approvals/\(percentEncode(id))/approve"
        let (data, _) = try await dispatch(method: "POST", path: path, body: nil)
        return try decodeOrThrow(PrivacyApprovalResolution.self, from: data)
    }

    public func listSubscriptionApprovals(
        status: String = "pending",
        limit: Int = 50,
        cursor: String? = nil
    ) async throws
        -> PrivacySubscriptionApprovalsEnvelope {
        var path = "/admin/privacy/subscription-approvals?status=\(queryEncode(status))&limit=\(limit)"
        if let cursor {
            path += "&cursor=\(queryEncode(cursor))"
        }
        let (data, _) = try await dispatch(method: "GET", path: path, body: nil)
        return try decodeOrThrow(PrivacySubscriptionApprovalsEnvelope.self, from: data)
    }

    public func getSubscriptionApproval(id: String) async throws
        -> PrivacySubscriptionApprovalDetail {
        let path = "/admin/privacy/subscription-approvals/\(percentEncode(id))"
        let (data, _) = try await dispatch(method: "GET", path: path, body: nil)
        let approval = try decodeOrThrow(
            PrivacySubscriptionApprovalEnvelope.self,
            from: data
        ).approval
        return try requireTrustedSubscriptionApproval(approval)
    }

    public func approveSubscription(id: String) async throws {
        try await resolveSubscriptionApproval(id: id, decision: "approve")
    }

    public func denySubscription(id: String) async throws {
        try await resolveSubscriptionApproval(id: id, decision: "deny")
    }

    public func getSubscription(id: String) async throws -> PrivacySubscriptionDetail {
        let path = "/admin/privacy/subscriptions/\(percentEncode(id))"
        let (data, _) = try await dispatch(method: "GET", path: path, body: nil)
        return try decodeOrThrow(PrivacySubscriptionEnvelope.self, from: data).subscription
    }

    @discardableResult
    public func revokeSubscription(id: String) async throws -> PrivacySubscriptionDetail {
        let path = "/admin/privacy/subscriptions/\(percentEncode(id))/revoke"
        let (data, _) = try await dispatch(method: "POST", path: path, body: nil)
        return try decodeOrThrow(PrivacySubscriptionEnvelope.self, from: data).subscription
    }

    public func listSubscriptionFirings(
        subscriptionId: String,
        limit: Int = 50,
        cursor: String? = nil
    ) async throws
        -> PrivacySubscriptionFiringPage {
        var path = "/admin/privacy/subscriptions/\(percentEncode(subscriptionId))/firings?limit=\(limit)"
        if let cursor {
            path += "&cursor=\(queryEncode(cursor))"
        }
        let (data, _) = try await dispatch(method: "GET", path: path, body: nil)
        return try decodeOrThrow(PrivacySubscriptionFiringPage.self, from: data)
    }

    @discardableResult
    public func deny(id: String) async throws -> PrivacyApprovalResolution {
        try await resolve(id: id, action: "deny")
    }

    /// The Privacy landing feed: every exchange the owner has, newest first,
    /// across all conversations. Flat because an exchange is the unit — a row
    /// grouped by conversation would carry a title, a time and a status that
    /// each describe a different event.
    public func listExchangeFeed(
        limit: Int = 50,
        cursor: String? = nil
    ) async throws
        -> PrivacyExchangeFeedPage {
        var path = "/admin/privacy/exchanges?limit=\(limit)"
        if let cursor {
            path += "&cursor=\(queryEncode(cursor))"
        }
        let (data, _) = try await dispatch(method: "GET", path: path, body: nil)
        return try decodeOrThrow(PrivacyExchangeFeedPage.self, from: data)
    }

    public func listExchanges(
        conversationId: String,
        limit: Int = 50,
        cursor: String? = nil,
        includeAgentTracesTaskId: String? = nil
    ) async throws
        -> PrivacyExchangePage {
        var path = "/admin/privacy/conversations/\(percentEncode(conversationId))/exchanges?limit=\(limit)"
        if let cursor {
            path += "&cursor=\(queryEncode(cursor))"
        }
        if let includeAgentTracesTaskId {
            path += "&includeAgentTracesTaskId=\(queryEncode(includeAgentTracesTaskId))"
        }
        let (data, _) = try await dispatch(method: "GET", path: path, body: nil)
        return try decodeOrThrow(PrivacyExchangePage.self, from: data)
    }

    public func listEvents(
        conversationId: String,
        limit: Int = 50,
        cursor: String? = nil
    ) async throws
        -> PrivacyAuditEventPage {
        var path = "/admin/privacy/conversations/\(percentEncode(conversationId))/events?limit=\(limit)"
        if let cursor {
            path += "&cursor=\(queryEncode(cursor))"
        }
        let (data, _) = try await dispatch(method: "GET", path: path, body: nil)
        return try decodeOrThrow(PrivacyAuditEventPage.self, from: data)
    }

    public func deleteConversation(id: String) async throws {
        let path = "/admin/privacy/conversations/\(percentEncode(id))"
        let (data, _) = try await dispatch(method: "DELETE", path: path, body: nil)
        struct Wrap: Decodable { let deleted: Bool }
        guard try decodeOrThrow(Wrap.self, from: data).deleted else {
            throw GatewayClient.Error.invalidResponse
        }
    }

    /// Direct MCP transcript sessions, newest first. Same admin posture as the
    /// Answer reads above: the operator sees every principal. A gateway from
    /// before this boundary 404s — callers map that to an unsupported state,
    /// never to an empty list.
    public func listDirectSessions(limit: Int = 50) async throws -> [DirectAuditSessionSummary] {
        let path = "/admin/privacy/direct/sessions?limit=\(limit)"
        let (data, _) = try await dispatch(method: "GET", path: path, body: nil)
        return try decodeOrThrow(DirectAuditSessionList.self, from: data).sessions
    }

    public func listDirectSessionEvents(
        sessionId: String,
        limit: Int = 100
    ) async throws
        -> [DirectAuditEventSummary] {
        let path = "/admin/privacy/direct/sessions/\(percentEncode(sessionId))/events?limit=\(limit)"
        let (data, _) = try await dispatch(method: "GET", path: path, body: nil)
        return try decodeOrThrow(DirectAuditEventList.self, from: data).events
    }

    public func getDirectEvent(id: String) async throws -> DirectAuditEventDetail {
        let path = "/admin/privacy/direct/events/\(percentEncode(id))"
        let (data, _) = try await dispatch(method: "GET", path: path, body: nil)
        struct Wrap: Decodable { let event: DirectAuditEventDetail }
        return try decodeOrThrow(Wrap.self, from: data).event
    }

    public func deleteDirectSession(id: String) async throws {
        let path = "/admin/privacy/direct/sessions/\(percentEncode(id))"
        let (data, _) = try await dispatch(method: "DELETE", path: path, body: nil)
        struct Wrap: Decodable { let deleted: Bool }
        guard try decodeOrThrow(Wrap.self, from: data).deleted else {
            throw GatewayClient.Error.invalidResponse
        }
    }

    private func resolve(id: String, action: String) async throws -> PrivacyApprovalResolution {
        let path = "/admin/privacy/approvals/\(percentEncode(id))/\(action)"
        let (data, _) = try await dispatch(method: "POST", path: path, body: nil)
        return try decodeOrThrow(PrivacyApprovalResolution.self, from: data)
    }

    private func resolveSubscriptionApproval(id: String, decision: String) async throws {
        struct Body: Encodable { let decision: String }
        let path = "/admin/privacy/subscription-approvals/\(percentEncode(id))/resolve"
        let body = try encoder.encode(Body(decision: decision))
        _ = try await dispatch(method: "POST", path: path, body: body)
    }

    private func dispatch(
        method: String,
        path: String,
        body: Data?
    ) async throws
        -> (Data, HTTPURLResponse) {
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
        case 200 ... 299: return (data, http)
        case 401: throw GatewayClient.Error.unauthorized
        case 403: throw GatewayClient.Error.forbidden
        case 404: throw GatewayClient.Error.notFound
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

    private func requireTrustedSubscriptionApproval(
        _ approval: PrivacySubscriptionApprovalDetail
    ) throws
        -> PrivacySubscriptionApprovalDetail {
        let allowedStatuses = ["pending", "approved", "denied", "expired"]
        let hasTrustedContract =
            approval.id.isNonBlank
                && approval.subscriptionId.isNonBlank
                && approval.workflowHandle.isNonBlank
                && approval.integration.displayName.isNonBlank
                && approval.integration.source == .token
                && allowedStatuses.contains(approval.status)
                && approval.interpretedCondition.summary.isNonBlank
                && approval.interpretedCondition.pushDetail == "existence"
                && approval.interpretation.summary.isNonBlank
                && approval.interpretation.pushDetail == "existence"
                && approval.interpretation == approval.interpretedCondition
                && approval.workflowId.isNonBlank
                && approval.integrationDeviceId.isNonBlank
                && approval.integrationDevice.id == approval.integrationDeviceId
                && approval.integrationDevice.name.isNonBlank
                && approval.integrationDevice.kind == "agent"
                && approval.workflow.id == approval.workflowId
                && approval.workflow.name.isNonBlank
                && approval.workflow.purpose.isNonBlank
                && approval.revisionId.isNonBlank
                && approval.revision > 0
                && approval.createdAt > 0
                && approval.expiresAt > 0
                && approval.condition.kind == "natural-language"
                && approval.condition.description.isNonBlank
                && approval.reaction.kind == "agent-workflow"
                && approval.reaction.instruction.isNonBlank
                && !approval.categories.isEmpty
                && approval.categories.allSatisfy(\.isNonBlank)
                && approval.policyRevision.isNonBlank
        guard hasTrustedContract else {
            throw GatewayClient.Error.decoding(
                "Subscription approval response was incomplete or untrusted."
            )
        }
        return approval
    }

    private func percentEncode(_ raw: String) -> String {
        let unreserved = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-._~"))
        return raw.addingPercentEncoding(withAllowedCharacters: unreserved) ?? raw
    }

    private func queryEncode(_ raw: String) -> String {
        var allowed = CharacterSet.urlQueryAllowed
        allowed.remove(charactersIn: "&=+#")
        return raw.addingPercentEncoding(withAllowedCharacters: allowed) ?? raw
    }
}

/// Used by the trusted-contract check above: a field the gateway must fill.
extension String {
    fileprivate var isNonBlank: Bool {
        !trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
}
