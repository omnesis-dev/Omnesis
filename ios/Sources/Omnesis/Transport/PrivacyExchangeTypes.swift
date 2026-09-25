// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

// One exchange across the boundary, and the ledger behind it.
//
// `PrivacyExchangePresentation` is the server-produced, task-level account of
// what an external agent asked and what, if anything, left the machine. Its
// value semantics are load-bearing: `sharedAnswer` is populated only after
// recorded external egress, while `draftAnswer` and `pendingCandidate` are
// local data that must never be presented as already shared.

public enum PrivacyAuditEventKind: String, Decodable, Equatable, Sendable {
    case externalRequest = "external_request"
    case agentTrace = "agent_trace"
    case candidateGenerated = "candidate_generated"
    case privacyReview = "privacy_review"
    case reductionGenerated = "reduction_generated"
    case approvalRequested = "approval_requested"
    case approvalResolved = "approval_resolved"
    case released
    case denied
    case failed
    case truncated
    case egress
    case unknown

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = PrivacyAuditEventKind(rawValue: raw) ?? .unknown
    }
}

public enum PrivacyTaskAuditStatus: String, Decodable, Equatable, Sendable {
    case released
    case releasedWithReductions = "released_with_reductions"
    case approvalRequired = "approval_required"
    case denied
    case running
    case failed
    case canceled
    case unknown

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = PrivacyTaskAuditStatus(rawValue: raw) ?? .unknown
    }
}

public enum PrivacyExchangeOutcome: String, Decodable, Equatable, Sendable {
    case checking
    case needsReview = "needs_review"
    case ready
    case shared
    case sharedWithReductions = "shared_with_reductions"
    case notShared = "not_shared"
    case failed
    case canceled
    case unknown

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = PrivacyExchangeOutcome(rawValue: raw) ?? .unknown
    }
}

public enum PrivacyExchangeUserDecision: String, Decodable, Equatable, Sendable {
    case approved
    case approvedButBlocked = "approved_but_blocked"
    case denied
    case expired
}

public enum PrivacyExchangeDenialReason: String, Decodable, Equatable, Sendable {
    case privacyPolicy = "privacy_policy"
    case hardStop = "hard_stop"
    case userDenied = "user_denied"
    case expired
    case canceled
    case approvalNotAvailable = "approval_not_available"
    case unknown

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = PrivacyExchangeDenialReason(rawValue: raw) ?? .unknown
    }
}

public struct PrivacyExchangeWorkflow: Decodable, Equatable, Sendable {
    public let name: String
    public let purpose: String

    public init(name: String, purpose: String) {
        self.name = name
        self.purpose = purpose
    }
}

public struct PrivacyExchangeApproval: Decodable, Equatable, Sendable {
    public let id: String
    public let status: PrivacyApprovalStatus
    public let expiresAt: Int64
    public let resolvedAt: Int64?

    public init(
        id: String,
        status: PrivacyApprovalStatus,
        expiresAt: Int64,
        resolvedAt: Int64?
    ) {
        self.id = id
        self.status = status
        self.expiresAt = expiresAt
        self.resolvedAt = resolvedAt
    }
}

public struct PrivacyExchangeReview: Decodable, Equatable, Sendable {
    public let fallbackCause: PrivacyReviewFallbackCause?
    public let findings: [PrivacyFinding]
    public let rationale: String
    /// The policy family the review was judged against, and its name at the
    /// time. A record written before families were named carries neither.
    public let policyFamilyId: String?
    public let policyFamilyName: String?

    public init(
        fallbackCause: PrivacyReviewFallbackCause?,
        findings: [PrivacyFinding],
        rationale: String,
        policyFamilyId: String? = nil,
        policyFamilyName: String? = nil
    ) {
        self.fallbackCause = fallbackCause
        self.findings = findings
        self.rationale = rationale
        self.policyFamilyId = policyFamilyId
        self.policyFamilyName = policyFamilyName
    }
}

/// Server-produced, task-level presentation of one external boundary exchange.
/// `sharedAnswer` is populated only after recorded external egress;
/// `draftAnswer` and `pendingCandidate` remain local to the operator's audit.
public struct PrivacyExchangePresentation: Decodable, Equatable, Sendable, Identifiable {
    public let taskId: String
    public let conversationId: String
    public let workflowId: String
    public let externalAgent: PrivacyExternalAgent
    public let workflow: PrivacyExchangeWorkflow
    public let question: String
    public let status: PrivacyTaskAuditStatus
    public let outcome: PrivacyExchangeOutcome
    public let createdAt: Int64
    public let resolvedAt: Int64?
    public let sharedAt: Int64?
    public let sharedAnswer: String?
    /// The locally recorded candidate. It is visible to the operator in the
    /// privacy audit, but this value does not mean the answer left the machine.
    public let draftAnswer: String?
    public let pendingCandidate: String?
    public let reductions: [String]
    public let approval: PrivacyExchangeApproval?
    public let userDecision: PrivacyExchangeUserDecision?
    public let denialReason: PrivacyExchangeDenialReason?
    public let review: PrivacyExchangeReview?
    /// The gateway's reviewed, safe explanation of why Omnesis did not complete
    /// this exchange. Never derived from an audit payload, which can carry
    /// private request context.
    public let failure: PrivacyExchangeFailure?
    /// Local-only, bounded generation transcripts, oldest attempt first.
    /// Empty on gateways from before the trace boundary, which omit the key.
    public let agentTraces: [PrivacyAgentTrace]
    /// Stored attempts omitted because of projection size/count/shape limits.
    public let agentTraceOmittedAttempts: Int

    public var id: String {
        taskId
    }

    /// Human-facing event time. Shared outcomes use the recorded egress time,
    /// while every other outcome falls back to its decision or creation time.
    public var presentationTimestamp: Int64 {
        sharedAt ?? resolvedAt ?? createdAt
    }

    /// The only answer the human-facing audit may label as shared.
    public var externallyVisibleAnswer: String? {
        switch outcome {
        case .shared, .sharedWithReductions: sharedAnswer
        case .checking, .needsReview, .ready, .notShared, .failed, .canceled, .unknown: nil
        }
    }

    /// Held data is shown only while the corresponding approval is pending.
    public var candidateAwaitingReview: String? {
        guard outcome == .needsReview, approval?.status == .pending else { return nil }
        return pendingCandidate
    }

    public init(
        taskId: String,
        conversationId: String,
        workflowId: String,
        externalAgent: PrivacyExternalAgent,
        workflow: PrivacyExchangeWorkflow,
        question: String,
        status: PrivacyTaskAuditStatus,
        outcome: PrivacyExchangeOutcome,
        createdAt: Int64,
        resolvedAt: Int64?,
        sharedAt: Int64? = nil,
        sharedAnswer: String?,
        draftAnswer: String? = nil,
        pendingCandidate: String?,
        reductions: [String],
        approval: PrivacyExchangeApproval?,
        userDecision: PrivacyExchangeUserDecision?,
        denialReason: PrivacyExchangeDenialReason? = nil,
        review: PrivacyExchangeReview?,
        failure: PrivacyExchangeFailure? = nil,
        agentTraces: [PrivacyAgentTrace] = [],
        agentTraceOmittedAttempts: Int = 0
    ) {
        self.taskId = taskId
        self.conversationId = conversationId
        self.workflowId = workflowId
        self.externalAgent = externalAgent
        self.workflow = workflow
        self.question = question
        self.status = status
        self.outcome = outcome
        self.createdAt = createdAt
        self.resolvedAt = resolvedAt
        self.sharedAt = sharedAt
        self.sharedAnswer = sharedAnswer
        self.draftAnswer = draftAnswer
        self.pendingCandidate = pendingCandidate
        self.reductions = reductions
        self.approval = approval
        self.userDecision = userDecision
        self.denialReason = denialReason
        self.review = review
        self.failure = failure
        self.agentTraces = agentTraces
        self.agentTraceOmittedAttempts = agentTraceOmittedAttempts
    }

    private enum CodingKeys: String, CodingKey {
        case taskId, conversationId, workflowId, externalAgent, workflow, question
        case status, outcome, createdAt, resolvedAt, sharedAt, sharedAnswer, draftAnswer
        case pendingCandidate, reductions, approval, userDecision, denialReason, review, failure
        case agentTraces, agentTraceOmittedAttempts
    }

    /// Hand-rolled so one malformed exchange cannot take the whole feed page
    /// with it. Every descriptive field falls back to a value that renders as
    /// "we don't know" rather than throwing, and the narrative parts of the
    /// record — the review, the approval, the failure — degrade to absent.
    ///
    /// The three ids stay required: they are this row's identity and the route
    /// to its detail, and a synthesized one would collide with its neighbours.
    /// Nothing here can turn local data into shared data — `sharedAnswer`,
    /// `draftAnswer`, and `pendingCandidate` keep distinct value semantics.
    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        taskId = try container.decode(String.self, forKey: .taskId)
        conversationId = try container.decode(String.self, forKey: .conversationId)
        workflowId = try container.decode(String.self, forKey: .workflowId)
        externalAgent = (try? container.decode(
            PrivacyExternalAgent.self,
            forKey: .externalAgent
        )) ?? PrivacyExternalAgent(displayName: "", source: .fallback)
        workflow = (try? container.decode(PrivacyExchangeWorkflow.self, forKey: .workflow))
            ?? PrivacyExchangeWorkflow(name: "", purpose: "")
        question = (try? container.decodeIfPresent(String.self, forKey: .question)) ?? ""
        status = (try? container.decodeIfPresent(PrivacyTaskAuditStatus.self, forKey: .status))
            ?? .unknown
        outcome = (try? container.decodeIfPresent(PrivacyExchangeOutcome.self, forKey: .outcome))
            ?? .unknown
        createdAt = (try? container.decodeIfPresent(Int64.self, forKey: .createdAt)) ?? 0
        resolvedAt = try? container.decodeIfPresent(Int64.self, forKey: .resolvedAt)
        sharedAt = try? container.decodeIfPresent(Int64.self, forKey: .sharedAt)
        sharedAnswer = try? container.decodeIfPresent(String.self, forKey: .sharedAnswer)
        draftAnswer = try? container.decodeIfPresent(String.self, forKey: .draftAnswer)
        pendingCandidate = try? container.decodeIfPresent(String.self, forKey: .pendingCandidate)
        reductions = (try? container.decodeIfPresent([String].self, forKey: .reductions)) ?? []
        approval = try? container.decodeIfPresent(
            PrivacyExchangeApproval.self,
            forKey: .approval
        )
        userDecision = try? container.decodeIfPresent(
            PrivacyExchangeUserDecision.self,
            forKey: .userDecision
        )
        denialReason = try? container.decodeIfPresent(
            PrivacyExchangeDenialReason.self,
            forKey: .denialReason
        )
        review = try? container.decodeIfPresent(PrivacyExchangeReview.self, forKey: .review)
        failure = try? container.decodeIfPresent(PrivacyExchangeFailure.self, forKey: .failure)
        // Decoded per entry so one malformed attempt degrades to a skipped
        // attempt, never to a lost transcript. Gateways from before the
        // trace boundary omit both keys and read as no transcript at all.
        let rawTraces = (try? container.decodeIfPresent(
            [JSONValue].self,
            forKey: .agentTraces
        )) ?? []
        agentTraces = rawTraces.compactMap(PrivacyAgentTrace.init(json:))
        agentTraceOmittedAttempts =
            (try? container.decodeIfPresent(Int.self, forKey: .agentTraceOmittedAttempts)) ?? 0
    }
}

public struct PrivacyExchangeFailure: Decodable, Equatable, Sendable {
    public enum Stage: Decodable, Equatable, Sendable {
        case answerGeneration
        case privacyCheck
        case unknown

        public init(from decoder: Decoder) throws {
            switch try decoder.singleValueContainer().decode(String.self) {
            case "answer_generation": self = .answerGeneration
            case "privacy_check": self = .privacyCheck
            default: self = .unknown
            }
        }
    }

    public let code: String
    public let message: String
    public let stage: Stage?
    /// One vetted line of provider disposition behind the humanized message,
    /// e.g. `HTTP 404 · NOT_FOUND · param=model`. The gateway composes it from
    /// envelope fields only — never upstream response prose — and omits the
    /// key entirely when the failure came from nothing a provider reported.
    public let detail: String?

    public init(code: String, message: String, stage: Stage? = nil, detail: String? = nil) {
        self.code = code
        self.message = message
        self.stage = stage
        self.detail = detail
    }

    private enum CodingKeys: String, CodingKey {
        case code
        case message
        case stage
        case detail
    }

    /// `code` and `message` are the contract; everything else is read
    /// best-effort so a gateway that adds, drops, or reshapes an optional
    /// field never costs this client the failure it already understands.
    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        code = try container.decode(String.self, forKey: .code)
        message = try container.decode(String.self, forKey: .message)
        stage = try? container.decodeIfPresent(Stage.self, forKey: .stage)
        detail = try? container.decodeIfPresent(String.self, forKey: .detail)
    }
}

public struct PrivacyExchangePage: Decodable, Equatable, Sendable {
    public let exchanges: [PrivacyExchangePresentation]
    public let previousCursor: String?
}
