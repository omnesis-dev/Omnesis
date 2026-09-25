// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

/// Invented connections, levels and proposals for the Connection step's
/// tests: a desk connection on a research level shared by two connections,
/// a Notes-only level nobody uses, and a level named to test ordering.
struct AccessConnectionFixtures {
    let known: Set<String> = ["github:maya-reeves", "gmail:maya.reeves@example.com"]
    /// The clock the fixtures open choices at.
    let now: Int64 = 1_790_000_000_000

    static let answerRules: [AccessGrantRule] = [
        .answer(
            sources: AccessSourceBoundary(mode: .all, sourceIds: []),
            release: .reviewed(policyFamilyId: "policy-work-safe")
        ),
    ]

    var answerRules: [AccessGrantRule] {
        Self.answerRules
    }

    let researchLevel: AccessLevelSummary
    let notesLevel: AccessLevelSummary
    let zetaLevel: AccessLevelSummary
    let deskGrant: AccessGrantSummary
    /// The desk connection as the replace list shows it.
    let deskConnection: AccessLiveConnection

    init() {
        let research = Self.level(
            "level-research",
            name: "Research assistants",
            rules: Self.answerRules + [.notes],
            connectionCount: 2,
            revision: 4
        )
        researchLevel = research
        notesLevel = Self.level("level-notes", name: "notes only", rules: [.notes], connectionCount: 0)
        zetaLevel = Self.level("level-zeta", name: "Zeta", rules: Self.answerRules)
        deskGrant = Self.grant(
            "grant-desk",
            rules: research.rules,
            revision: 6,
            levelId: research.id,
            lastUsed: [1_800_000_000_000]
        )
        deskConnection = AccessLiveConnection(id: "principal-desk", name: "Northstar desk", grant: deskGrant)
    }

    func request(requiresAnswer: Bool = false) -> AccessAuthorizationRequest {
        AccessAuthorizationRequest(
            id: "request-example",
            approvalId: "approval-example",
            status: "pending",
            clientId: "client-example",
            clientName: "Northstar Assistant",
            clientUri: nil,
            redirectOrigin: "http://127.0.0.1:8765",
            resource: "https://gateway.example/mcp",
            scope: "omnesis:access",
            expiresAt: 1_800_000_000_000,
            requiresAnswer: requiresAnswer
        )
    }

    static func grant(
        _ id: String,
        rules: [AccessGrantRule],
        revision: Int = 1,
        levelId: String? = nil,
        lastUsed: [Int64?] = [],
        revokedAt: Int64? = nil,
        expiresAt: Int64? = nil
    )
        -> AccessGrantSummary {
        AccessGrantSummary(
            id: id,
            name: "\(id) access",
            revision: revision,
            rules: rules,
            credentials: lastUsed.enumerated().map { index, millis in
                AccessCredentialSummary(
                    id: "\(id)-credential-\(index)",
                    label: id,
                    status: "active",
                    revokedAt: nil,
                    lastUsedAt: millis
                )
            },
            expiresAt: expiresAt,
            revokedAt: revokedAt,
            levelId: levelId
        )
    }

    static func principal(
        _ id: String,
        name: String,
        grants: [AccessGrantSummary],
        kind: String = "interactive",
        revokedAt: Int64? = nil
    )
        -> AccessPrincipalSummary {
        AccessPrincipalSummary(id: id, name: name, kind: kind, grants: grants, revokedAt: revokedAt)
    }

    static func level(
        _ id: String,
        name: String,
        rules: [AccessGrantRule],
        connectionCount: Int = 1,
        revision: Int = 1
    )
        -> AccessLevelSummary {
        AccessLevelSummary(
            id: id,
            name: name,
            revision: revision,
            rules: rules,
            connectionCount: connectionCount,
            createdAt: 1,
            updatedAt: 1
        )
    }

    func overview(
        levels: [AccessLevelSummary]? = nil,
        principals: [AccessPrincipalSummary]? = nil
    )
        -> AccessOverview {
        AccessOverview(
            principals: principals ?? [Self.principal("principal-desk", name: "Northstar desk", grants: [deskGrant])],
            sources: known.sorted().map { AccessSourceInstance(id: $0, name: $0) },
            policyFamilies: [AccessPolicyFamilySummary(id: "policy-work-safe", name: "Work-safe", revision: "rev-1")],
            defaultPolicyFamilyId: "policy-work-safe",
            levels: levels ?? [zetaLevel, researchLevel, notesLevel]
        )
    }

    func proposal(
        _ recommended: AccessConnectionProposal.Recommendation,
        matchedBy: String = "client",
        match: Bool = true
    )
        -> AccessConnectionProposal {
        AccessConnectionProposal(
            defaultName: "Northstar Assistant 2",
            defaultLevelName: "Northstar Assistant",
            match: match
                ? AccessConnectionProposal.Match(
                    connectionId: "principal-desk",
                    connectionName: "Northstar desk",
                    matchedBy: matchedBy,
                    levelId: researchLevel.id,
                    grant: deskGrant
                )
                : nil,
            recommended: recommended
        )
    }

    func opened(
        _ proposal: AccessConnectionProposal,
        request: AccessAuthorizationRequest? = nil,
        overview: AccessOverview? = nil
    )
        -> AccessConnectionChoice {
        AccessConnectionChoice.opening(
            request: request ?? self.request(),
            overview: overview ?? self.overview(),
            proposal: proposal,
            nowMillis: now
        )
    }

    /// A blank permissions form over the fixtures' sources.
    func form(request: AccessAuthorizationRequest? = nil, overview: AccessOverview? = nil) -> AccessAuthorizationFormState {
        .opening(request: request ?? self.request(), overview: overview ?? self.overview(), prefill: nil)
    }
}
