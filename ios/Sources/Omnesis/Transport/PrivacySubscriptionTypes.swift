// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

// Watches: the standing subscriptions an external integration proposes and the
// operator approves, plus the one-POST reconcile rules their decisions follow.
// A watch is a different noun from an exchange — a standing grant of access
// rather than one question and one answer — so its contract lives apart from
// the boundary types in PrivacyWireTypes.swift.

enum PrivacySubscriptionApprovalOutcome {
    case accepted
    case reconciled(PrivacySubscriptionApprovalDetail)
    case failed(Error, PrivacySubscriptionApprovalDetail?)
}

/// A decision POST is never retried. If its response is lost, one authoritative
/// read may prove that the gateway committed a terminal state.
func resolveSubscriptionApprovalAndReconcile(
    resolve: () async throws -> Void,
    reload: () async throws -> PrivacySubscriptionApprovalDetail
) async throws
    -> PrivacySubscriptionApprovalOutcome {
    do {
        try await resolve()
        return .accepted
    } catch is CancellationError {
        throw CancellationError()
    } catch {
        let actionError = error
        let latest: PrivacySubscriptionApprovalDetail?
        do {
            latest = try await reload()
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            latest = nil
        }
        if let latest, latest.status != "pending" {
            return .reconciled(latest)
        }
        return .failed(actionError, latest)
    }
}

enum PrivacySubscriptionRevokeOutcome {
    case accepted(PrivacySubscriptionDetail)
    case reconciled(PrivacySubscriptionDetail)
    case failed(Error, PrivacySubscriptionDetail?)
}

/// Revoke follows the same one-POST rule. A single GET can reconcile an
/// ambiguous transport failure; only a terminal state overrides that failure.
func revokeSubscriptionAndReconcile(
    revoke: () async throws -> PrivacySubscriptionDetail,
    reload: () async throws -> PrivacySubscriptionDetail
) async throws
    -> PrivacySubscriptionRevokeOutcome {
    do {
        return try await .accepted(revoke())
    } catch is CancellationError {
        throw CancellationError()
    } catch {
        let actionError = error
        let latest: PrivacySubscriptionDetail?
        do {
            latest = try await reload()
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            latest = nil
        }
        if let latest, ["revoked", "expired"].contains(latest.status) {
            return .reconciled(latest)
        }
        return .failed(actionError, latest)
    }
}

public struct PrivacySubscriptionCondition: Decodable, Equatable, Sendable {
    public let kind: String
    public let description: String

    public init(kind: String = "natural-language", description: String) {
        self.kind = kind
        self.description = description
    }
}

public struct PrivacySubscriptionReaction: Decodable, Equatable, Sendable {
    public let kind: String
    public let instruction: String

    public init(kind: String = "agent-workflow", instruction: String) {
        self.kind = kind
        self.instruction = instruction
    }
}

public struct PrivacyInterpretedCondition: Decodable, Equatable, Sendable {
    public let summary: String
    public let pushDetail: String

    public init(summary: String, pushDetail: String = "existence") {
        self.summary = summary
        self.pushDetail = pushDetail
    }
}

public struct PrivacySubscriptionApprovalSummary: Decodable, Equatable, Identifiable, Sendable {
    public let id: String
    public let subscriptionId: String
    public let workflowHandle: String
    public let integration: PrivacyExternalAgent
    public let status: String
    public let interpretedCondition: PrivacyInterpretedCondition
    public let revisionId: String
    public let revision: Int
    public let createdAt: Int64
    public let expiresAt: Int64
    public let resolvedAt: Int64?

    public init(
        id: String,
        subscriptionId: String,
        workflowHandle: String,
        integration: PrivacyExternalAgent,
        status: String,
        interpretedCondition: PrivacyInterpretedCondition,
        revisionId: String,
        revision: Int,
        createdAt: Int64,
        expiresAt: Int64,
        resolvedAt: Int64?
    ) {
        self.id = id
        self.subscriptionId = subscriptionId
        self.workflowHandle = workflowHandle
        self.integration = integration
        self.status = status
        self.interpretedCondition = interpretedCondition
        self.revisionId = revisionId
        self.revision = revision
        self.createdAt = createdAt
        self.expiresAt = expiresAt
        self.resolvedAt = resolvedAt
    }
}

public struct PrivacySubscriptionApprovalDetail: Decodable, Equatable, Identifiable, Sendable {
    public let id: String
    public let subscriptionId: String
    public let workflowHandle: String
    public let integration: PrivacyExternalAgent
    public let status: String
    public let interpretedCondition: PrivacyInterpretedCondition
    public let interpretation: PrivacyInterpretedCondition
    public let workflowId: String
    public let integrationDeviceId: String
    public let integrationDevice: PrivacySubscriptionIntegrationDevice
    public let workflow: PrivacySubscriptionWorkflow
    public let revisionId: String
    public let revision: Int
    public let createdAt: Int64
    public let expiresAt: Int64
    public let resolvedAt: Int64?
    public let condition: PrivacySubscriptionCondition
    public let reaction: PrivacySubscriptionReaction
    public let categories: [String]
    public let policyRevision: String

    public init(
        id: String,
        subscriptionId: String,
        workflowHandle: String,
        integration: PrivacyExternalAgent,
        status: String,
        interpretedCondition: PrivacyInterpretedCondition,
        interpretation: PrivacyInterpretedCondition,
        workflowId: String,
        integrationDeviceId: String,
        integrationDevice: PrivacySubscriptionIntegrationDevice,
        workflow: PrivacySubscriptionWorkflow,
        revisionId: String,
        revision: Int,
        createdAt: Int64,
        expiresAt: Int64,
        resolvedAt: Int64?,
        condition: PrivacySubscriptionCondition,
        reaction: PrivacySubscriptionReaction,
        categories: [String],
        policyRevision: String
    ) {
        self.id = id
        self.subscriptionId = subscriptionId
        self.workflowHandle = workflowHandle
        self.integration = integration
        self.status = status
        self.interpretedCondition = interpretedCondition
        self.interpretation = interpretation
        self.workflowId = workflowId
        self.integrationDeviceId = integrationDeviceId
        self.integrationDevice = integrationDevice
        self.workflow = workflow
        self.revisionId = revisionId
        self.revision = revision
        self.createdAt = createdAt
        self.expiresAt = expiresAt
        self.resolvedAt = resolvedAt
        self.condition = condition
        self.reaction = reaction
        self.categories = categories
        self.policyRevision = policyRevision
    }
}

public struct PrivacySubscriptionIntegrationDevice: Decodable, Equatable, Sendable {
    public let id: String
    public let name: String
    public let kind: String

    public init(id: String, name: String, kind: String = "agent") {
        self.id = id
        self.name = name
        self.kind = kind
    }
}

public struct PrivacySubscriptionWorkflow: Decodable, Equatable, Sendable {
    public let id: String
    public let name: String
    public let purpose: String

    public init(id: String, name: String, purpose: String) {
        self.id = id
        self.name = name
        self.purpose = purpose
    }
}

public struct PrivacySubscriptionApprovalsEnvelope: Decodable, Equatable, Sendable {
    public let approvals: [PrivacySubscriptionApprovalSummary]
    public let nextCursor: String?
    public let totalCount: Int

    public init(
        approvals: [PrivacySubscriptionApprovalSummary],
        nextCursor: String?,
        totalCount: Int
    ) {
        self.approvals = approvals
        self.nextCursor = nextCursor
        self.totalCount = totalCount
    }

    private enum CodingKeys: String, CodingKey {
        case approvals, nextCursor, totalCount
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        approvals = try container.decodeIfPresent(
            [PrivacySubscriptionApprovalSummary].self,
            forKey: .approvals
        ) ?? []
        nextCursor = try container.decodeIfPresent(String.self, forKey: .nextCursor)
        totalCount = try container.decodeIfPresent(Int.self, forKey: .totalCount)
            ?? approvals.count
    }
}

public struct PrivacySubscriptionApprovalEnvelope: Decodable, Equatable, Sendable {
    public let approval: PrivacySubscriptionApprovalDetail
}

public struct PrivacySubscriptionDetail: Decodable, Equatable, Identifiable, Sendable {
    public let id: String
    public let workflowHandle: String
    public let integration: PrivacyExternalAgent
    public let status: String
    public let interpretedCondition: PrivacyInterpretedCondition
    public let revisionId: String
    public let revision: Int
    public let createdAt: Int64
    public let updatedAt: Int64
    public let expiresAt: Int64
    public let revokedAt: Int64?
    public let firingCount: Int
    public let lastFiredAt: Int64?
    public let condition: PrivacySubscriptionCondition
    public let reaction: PrivacySubscriptionReaction
    public let categories: [String]
    public let policyRevision: String

    public init(
        id: String,
        workflowHandle: String,
        integration: PrivacyExternalAgent,
        status: String,
        interpretedCondition: PrivacyInterpretedCondition,
        revisionId: String,
        revision: Int,
        createdAt: Int64,
        updatedAt: Int64,
        expiresAt: Int64,
        revokedAt: Int64?,
        firingCount: Int,
        lastFiredAt: Int64?,
        condition: PrivacySubscriptionCondition,
        reaction: PrivacySubscriptionReaction,
        categories: [String],
        policyRevision: String
    ) {
        self.id = id
        self.workflowHandle = workflowHandle
        self.integration = integration
        self.status = status
        self.interpretedCondition = interpretedCondition
        self.revisionId = revisionId
        self.revision = revision
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.expiresAt = expiresAt
        self.revokedAt = revokedAt
        self.firingCount = firingCount
        self.lastFiredAt = lastFiredAt
        self.condition = condition
        self.reaction = reaction
        self.categories = categories
        self.policyRevision = policyRevision
    }
}

public struct PrivacySubscriptionEnvelope: Decodable, Equatable, Sendable {
    public let subscription: PrivacySubscriptionDetail
}

public struct PrivacySubscriptionFiring: Decodable, Equatable, Identifiable, Sendable {
    public let id: String
    public let subscriptionId: String
    public let revisionId: String
    public let workflowHandle: String
    public let createdAt: Int64
    public let deliveryStatus: String
    public let acceptedAt: Int64?
    /// Where this firing lives in the watch runtime that produced it: the watch
    /// it belongs to, and the journal event it happened on.
    ///
    /// A wake and an installed watch's firing are the same event seen from two
    /// sides, and this is the identifier both sides stamp — so it is what folds
    /// them into one row. Absent together for a record whose plan is not a
    /// watch's, and for a firing written before the runtime stamped its
    /// identity this way.
    public let watchId: String?
    public let seq: Int?

    public init(
        id: String,
        subscriptionId: String,
        revisionId: String,
        workflowHandle: String,
        createdAt: Int64,
        deliveryStatus: String,
        acceptedAt: Int64?,
        watchId: String? = nil,
        seq: Int? = nil
    ) {
        self.id = id
        self.subscriptionId = subscriptionId
        self.revisionId = revisionId
        self.workflowHandle = workflowHandle
        self.createdAt = createdAt
        self.deliveryStatus = deliveryStatus
        self.acceptedAt = acceptedAt
        self.watchId = watchId
        self.seq = seq
    }
}

public struct PrivacySubscriptionFiringPage: Decodable, Equatable, Sendable {
    public let firings: [PrivacySubscriptionFiring]
    public let nextCursor: String?
}

func canRevokePrivacySubscription(_ status: String) -> Bool {
    status == "pending_approval" || status == "active" || status == "paused"
}

// MARK: - How a record reads

/// Where a subscription record stands, as a person reads it.
func subscriptionStatusLabel(_ status: String) -> String {
    switch status {
    case "active": "Active"
    case "paused": "Paused"
    case "revoked": "Revoked"
    case "expired": "Expired"
    case "pending_approval": "Needs review"
    case "pending": "Queued"
    case "approved": "Approved"
    case "denied": "Not allowed"
    case "delivered": "Delivered"
    case "blocked": "Blocked"
    case "failed": "Failed"
    case "canceled": "Canceled"
    default: "Unknown"
    }
}

/// What became of one disclosure the record sent.
func firingDeliveryStatusLabel(_ status: String) -> String {
    switch status {
    case "pending": "Queued"
    case "delivered": "Delivered"
    case "blocked": "Blocked"
    case "failed": "Failed"
    default: "Unknown"
    }
}

/// The store keeps its instants as epoch milliseconds.
func subscriptionDate(_ millis: Int64) -> String {
    Date(timeIntervalSince1970: TimeInterval(millis) / 1000).formatted(
        date: .abbreviated,
        time: .shortened
    )
}

/// An opaque store id, shortened to something a person can compare by eye.
func shortSubscriptionId(_ value: String) -> String {
    guard value.count > 18 else { return value }
    return "\(value.prefix(8))…\(value.suffix(6))"
}
