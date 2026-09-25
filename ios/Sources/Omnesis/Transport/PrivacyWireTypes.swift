// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

// The wire contract of the answer privacy boundary: the shapes `PrivacyClient`
// decodes, and the small value semantics that keep held data from ever being
// presented as already shared.
//
// MARK: - Wire types

public struct PrivacyPolicyDocument: Decodable, Equatable, Sendable {
    public let policy: String
    public let revision: String
    public let updatedAt: Int64?
    public init(
        policy: String,
        revision: String,
        updatedAt: Int64?
    ) {
        self.policy = policy
        self.revision = revision
        self.updatedAt = updatedAt
    }
}

/// One named policy family as the catalogue lists it: its identity, where its
/// text currently stands, and which grants are judged against it. The text
/// itself is fetched per family. `archivedAt` is set once the family has been
/// retired; a retired family keeps its history but governs nothing new.
public struct PrivacyPolicyFamilySummary: Decodable, Equatable, Sendable, Identifiable {
    public let id: String
    public let name: String
    public let currentRevision: String
    public let currentVersion: Int
    public let updatedAt: Int64
    public let archivedAt: Int64?
    public let affectedGrantIds: [String]

    public init(
        id: String,
        name: String,
        currentRevision: String,
        currentVersion: Int,
        updatedAt: Int64,
        archivedAt: Int64?,
        affectedGrantIds: [String]
    ) {
        self.id = id
        self.name = name
        self.currentRevision = currentRevision
        self.currentVersion = currentVersion
        self.updatedAt = updatedAt
        self.archivedAt = archivedAt
        self.affectedGrantIds = affectedGrantIds
    }
}

/// The `policies` envelope of the catalogue route.
public struct PrivacyPolicyFamilyCatalogue: Decodable, Equatable, Sendable {
    public let policies: [PrivacyPolicyFamilySummary]
}

public struct PrivacyReviewerHealth: Decodable, Equatable, Sendable {
    public enum Status: String, Decodable, Equatable, Sendable {
        case ok
        case attention
    }

    public let status: Status
    public let recentOperationalFailureCount: Int
    public let lastFailureAt: Int64?

    public init(status: Status, recentOperationalFailureCount: Int, lastFailureAt: Int64?) {
        self.status = status
        self.recentOperationalFailureCount = recentOperationalFailureCount
        self.lastFailureAt = lastFailureAt
    }
}

public enum PrivacyApprovalStatus: String, Decodable, Equatable, Sendable {
    case pending
    case approved
    case denied
    case expired
}

public enum PrivacyAnswerStatus: String, Decodable, Equatable, Sendable {
    case released
    case releasedWithReductions = "released_with_reductions"
    case approvalRequired = "approval_required"
    case denied
}

public struct PrivacyExternalAgent: Decodable, Equatable, Sendable {
    public let displayName: String
    public let narrativeName: String?
    public let integrationSlug: String?
    public let connectionName: String?
    public let source: PrivacyExternalAgentSource

    public init(
        displayName: String,
        narrativeName: String? = nil,
        integrationSlug: String? = nil,
        connectionName: String? = nil,
        source: PrivacyExternalAgentSource
    ) {
        self.displayName = displayName
        self.narrativeName = narrativeName
        self.integrationSlug = integrationSlug
        self.connectionName = connectionName
        self.source = source
    }

    private enum CodingKeys: String, CodingKey {
        case displayName, narrativeName, integrationSlug, connectionName, source
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        displayName = try container.decode(String.self, forKey: .displayName)
        narrativeName = try? container.decode(String.self, forKey: .narrativeName)
        integrationSlug = try? container.decode(String.self, forKey: .integrationSlug)
        connectionName = try? container.decode(String.self, forKey: .connectionName)
        source = (try? container.decode(PrivacyExternalAgentSource.self, forKey: .source))
            ?? .unknown
    }
}

/// Where the gateway got the caller's name. A breadcrumb no screen renders, so a
/// value this build does not know degrades to `unknown` rather than failing the
/// decode and taking the approval it was attached to off the screen with it.
public enum PrivacyExternalAgentSource: String, Decodable, Equatable, Sendable {
    case token
    case integration
    case principal
    case fallback
    case unknown

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = PrivacyExternalAgentSource(rawValue: raw) ?? .unknown
    }
}

public struct PrivacyApprovalDetail: Decodable, Equatable, Sendable, Identifiable {
    public let id: String
    public let taskId: String
    public let workflowId: String
    public let conversationId: String
    public let workflowName: String
    public let externalAgent: PrivacyExternalAgent?
    public let status: PrivacyApprovalStatus
    public let createdAt: Int64
    public let expiresAt: Int64
    public let resolvedAt: Int64?
    public let sharedAt: Int64?
    public let workflowPurpose: String
    public let question: String
    public let candidateAnswer: String?
    public let review: PrivacyReviewRecord

    public init(
        id: String,
        taskId: String,
        workflowId: String,
        conversationId: String,
        workflowName: String,
        externalAgent: PrivacyExternalAgent? = nil,
        status: PrivacyApprovalStatus,
        createdAt: Int64,
        expiresAt: Int64,
        resolvedAt: Int64?,
        sharedAt: Int64? = nil,
        workflowPurpose: String,
        question: String,
        candidateAnswer: String?,
        review: PrivacyReviewRecord
    ) {
        self.id = id
        self.taskId = taskId
        self.workflowId = workflowId
        self.conversationId = conversationId
        self.workflowName = workflowName
        self.externalAgent = externalAgent
        self.status = status
        self.createdAt = createdAt
        self.expiresAt = expiresAt
        self.resolvedAt = resolvedAt
        self.sharedAt = sharedAt
        self.workflowPurpose = workflowPurpose
        self.question = question
        self.candidateAnswer = candidateAnswer
        self.review = review
    }
}

/// One row of the approval ledger. The list route carries metadata only —
/// the held candidate answer is fetched from the single-approval route once
/// the owner opens its trusted detail screen.
public struct PrivacyApprovalSummary: Decodable, Equatable, Sendable, Identifiable {
    public let id: String
    public let taskId: String
    public let workflowId: String
    public let conversationId: String
    public let workflowName: String
    public let externalAgent: PrivacyExternalAgent?
    public let status: PrivacyApprovalStatus
    public let createdAt: Int64
    public let expiresAt: Int64
    public let resolvedAt: Int64?

    public init(
        id: String,
        taskId: String,
        workflowId: String,
        conversationId: String,
        workflowName: String,
        externalAgent: PrivacyExternalAgent? = nil,
        status: PrivacyApprovalStatus,
        createdAt: Int64,
        expiresAt: Int64,
        resolvedAt: Int64?
    ) {
        self.id = id
        self.taskId = taskId
        self.workflowId = workflowId
        self.conversationId = conversationId
        self.workflowName = workflowName
        self.externalAgent = externalAgent
        self.status = status
        self.createdAt = createdAt
        self.expiresAt = expiresAt
        self.resolvedAt = resolvedAt
    }
}

/// A page of the approval ledger. `totalCount` is the whole matching set, not
/// the page — for `status=pending` it is the exact number of open decisions,
/// with a row whose deadline has already lapsed excluded. A caller that only
/// needs the number therefore asks for one row and reads this field.
public struct PrivacyApprovalPage: Decodable, Equatable, Sendable {
    public let approvals: [PrivacyApprovalSummary]
    public let nextCursor: String?
    public let totalCount: Int

    public init(approvals: [PrivacyApprovalSummary], nextCursor: String?, totalCount: Int) {
        self.approvals = approvals
        self.nextCursor = nextCursor
        self.totalCount = totalCount
    }
}

struct PrivacyApprovalRequestGate {
    private(set) var generation = 0

    mutating func beginLoad(resolutionInFlight: Bool) -> Int? {
        guard !resolutionInFlight else { return nil }
        return advance()
    }

    mutating func beginResolution() -> Int {
        advance()
    }

    mutating func invalidate() {
        generation += 1
    }

    func owns(_ request: Int) -> Bool {
        request == generation
    }

    private mutating func advance() -> Int {
        generation += 1
        return generation
    }
}

public struct PrivacyReviewRecord: Decodable, Equatable, Sendable {
    public let recipeVersion: String
    public let provider: String?
    public let model: String?
    public let confidence: Double?
    public let policyRevision: String
    /// The policy family the review was judged against, and its name at the
    /// time. A record written before families were named carries neither.
    public let policyFamilyId: String?
    public let policyFamilyName: String?
    public let envelopeDigest: String?
    public let findings: [PrivacyFinding]
    public let rationale: String
    public let fallbackCause: PrivacyReviewFallbackCause?

    public init(
        recipeVersion: String,
        provider: String?,
        model: String?,
        confidence: Double?,
        policyRevision: String,
        policyFamilyId: String? = nil,
        policyFamilyName: String? = nil,
        envelopeDigest: String? = nil,
        findings: [PrivacyFinding],
        rationale: String,
        fallbackCause: PrivacyReviewFallbackCause? = nil
    ) {
        self.recipeVersion = recipeVersion
        self.provider = provider
        self.model = model
        self.confidence = confidence
        self.policyRevision = policyRevision
        self.policyFamilyId = policyFamilyId
        self.policyFamilyName = policyFamilyName
        self.envelopeDigest = envelopeDigest
        self.findings = findings
        self.rationale = rationale
        self.fallbackCause = fallbackCause
    }
}

/// Why the reviewer's verdict is not a plain answer. The full closed set the
/// gateway can emit; `unknown` covers a cause minted by a newer gateway than
/// this build knows about.
public enum PrivacyReviewFallbackCause: String, Decodable, Equatable, Sendable {
    case notConfigured = "not_configured"
    case requestFailed = "request_failed"
    case contextWindowExceeded = "context_window_exceeded"
    case outputTruncated = "output_truncated"
    case invalidOutput = "invalid_output"
    case lowConfidence = "low_confidence"
    case policyRequiresReview = "policy_requires_review"
    case hardStop = "hard_stop"
    case unknown

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = PrivacyReviewFallbackCause(rawValue: raw) ?? .unknown
    }
}

public struct PrivacyFinding: Decodable, Equatable, Sendable {
    public let category: String
    public let detailLevel: PrivacyDetailLevel
    public let subject: PrivacyFindingSubject
    public let disposition: PrivacyFindingDisposition
    public let description: String

    public init(
        category: String,
        detailLevel: PrivacyDetailLevel,
        subject: PrivacyFindingSubject,
        disposition: PrivacyFindingDisposition,
        description: String
    ) {
        self.category = category
        self.detailLevel = detailLevel
        self.subject = subject
        self.disposition = disposition
        self.description = description
    }
}

public enum PrivacyDetailLevel: String, Decodable, Equatable, Sendable {
    case existence
    case summary
    case exact
    case original
}

public enum PrivacyFindingSubject: String, Decodable, Equatable, Sendable {
    case user
    case otherPerson = "other_person"
    case multiplePeople = "multiple_people"
    case unknown
}

public enum PrivacyFindingDisposition: String, Decodable, Equatable, Sendable {
    case allow
    case reduce
    case approval
    case deny
}

/// Resolution response intentionally reuses the public answer contract shape.
/// Approve returns a released answer; deny returns a generic denied response.
public struct PrivacyApprovalResolution: Decodable, Equatable, Sendable {
    public let status: PrivacyAnswerStatus
    public let workflowId: String
    public let conversationId: String
    public let taskId: String
    public let releaseId: String?
    public let answer: String?
    public let reductions: [String]?
    public let reason: String?
}
