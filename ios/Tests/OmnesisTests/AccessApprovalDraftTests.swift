// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

/// How the new level of an approval opens and closes: what a fresh connection
/// starts from, what a prefill from an existing connection's rules becomes,
/// and what the approval sends back.
final class AccessApprovalDraftTests: XCTestCase {
    private let known: Set<String> = [
        "github:maya-reeves",
        "gmail:maya.reeves@example.com",
        "claude-transcripts:workstation",
    ]

    private let request = AccessAuthorizationRequest(
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
        requiresAnswer: false
    )

    /// A source the overview still lists but cannot read right now. It is
    /// shown for the decision it retains and is never part of "every source".
    private let unavailable = "github:retired-workspace"

    private var overview: AccessOverview {
        AccessOverview(
            principals: [],
            sources: known.sorted().map { AccessSourceInstance(id: $0, name: $0) }
                + [AccessSourceInstance(id: unavailable, name: unavailable, available: false)],
            policyFamilies: [
                AccessPolicyFamilySummary(id: "policy-work-safe", name: "Work-safe", revision: "rev-1"),
                AccessPolicyFamilySummary(id: "policy-strict", name: "Strict", revision: "rev-1"),
            ],
            defaultPolicyFamilyId: "policy-work-safe"
        )
    }

    /// The new level an approval draws, opened from `prefill` the way a lookup opens it.
    private func opened(_ prefill: [AccessGrantRule]?, request: AccessAuthorizationRequest? = nil) -> AccessDraftDecisions {
        let request = request ?? self.request
        let draft = AccessLevelDraft.approving(request: request, overview: overview, prefill: prefill)
        return AccessDraftDecisions(draft: draft, overview: overview, original: draft, answerRequired: request.requiresAnswer)
    }

    private func sent(_ level: AccessDraftDecisions, request: AccessAuthorizationRequest? = nil) -> AccessAuthorizationSelection? {
        accessConnectSelection(rules: level.sendableRules, request: request ?? self.request)
    }

    private func allowEverySource(_ level: inout AccessDraftDecisions) throws {
        let all = try XCTUnwrap(level.selection(settingAllowed: true, for: overview.sources, capability: "answer"))
        level.setSourceSelection(all, capability: "answer")
    }

    /// A fresh connection starts with Answer on, released through the default
    /// policy, and nothing else: the owner has to allow sources before it
    /// describes a grant.
    func testAFreshConnectionStartsFromAnswerWithTheDefaultPolicy() throws {
        var level = opened(nil)
        XCTAssertEqual(level.capabilityHoldings, AccessCapabilityHoldings(answer: true))
        XCTAssertEqual(level.release, .reviewed(policyFamilyId: "policy-work-safe"))
        XCTAssertEqual(level.draft, AccessLevelDraft(level: nil, overview: overview), "The level editor's blank level")
        XCTAssertNil(sent(level))

        try allowEverySource(&level)
        XCTAssertEqual(
            sent(level),
            .connect(
                rules: [.answer(
                    sources: AccessSourceBoundary(mode: .allowlist, sourceIds: known.sorted()),
                    release: .reviewed(policyFamilyId: "policy-work-safe")
                )],
                credentialLabel: "Northstar Assistant"
            )
        )
    }

    /// Allowing every source records the available ones only, the set every
    /// platform would record for the same overview: the unavailable one is
    /// neither ticked nor written.
    func testAllowingEverySourceRecordsAvailableSourcesOnly() throws {
        var level = opened(nil)
        XCTAssertEqual(level.sourceSelection("answer")?.allowedSourceIds, [])
        try allowEverySource(&level)
        XCTAssertEqual(level.sourceSelection("answer")?.allowedSourceIds, known)
        XCTAssertEqual(level.draft.rule("answer")?.boundary, AccessSourceBoundary(mode: .allowlist, sourceIds: known.sorted()))
        XCTAssertEqual(level.allowedCountLabel("answer"), "3 of 3 allowed")
    }

    /// A grant that names the listed-but-unavailable source keeps naming it,
    /// the same way it keeps a source the overview no longer lists at all.
    func testAListedUnavailableSourceIsARetainedReference() throws {
        let allowlist = AccessSourceBoundary(mode: .allowlist, sourceIds: ["github:maya-reeves", unavailable])
        let denylist = AccessSourceBoundary(mode: .denylist, sourceIds: [unavailable])
        var level = opened([
            .direct(sources: allowlist),
            .answer(sources: denylist, release: .unreviewed),
        ])
        XCTAssertEqual(level.sourceSelection("answer")?.allowedSourceIds, known)
        XCTAssertEqual(
            sent(level),
            .connect(
                rules: [.direct(sources: allowlist), .answer(sources: denylist, release: .unreviewed)],
                credentialLabel: "Northstar Assistant"
            )
        )
        // Allowing every available source under the denylist leaves the
        // retained exception in place: nothing offered can clear it.
        try allowEverySource(&level)
        XCTAssertEqual(level.draft.rule("answer")?.boundary, denylist)
    }

    /// A prefill opens on the access an existing connection holds, as the
    /// new level's own, and approving without a change sends those rules.
    func testAPrefillOpensOnTheExistingRules() {
        let rules: [AccessGrantRule] = [
            .notes,
            .direct(sources: AccessSourceBoundary(mode: .allowlist, sourceIds: ["github:maya-reeves"])),
            .answer(
                sources: AccessSourceBoundary(mode: .denylist, sourceIds: ["claude-transcripts:workstation"]),
                release: .reviewed(policyFamilyId: "policy-strict")
            ),
        ]
        let saved: [AccessGrantRule] = [
            .notes,
            .direct(sources: rules[1].boundary, filterRevision: 3),
            .answer(sources: rules[2].boundary, release: .reviewed(policyFamilyId: "policy-strict"), filterRevision: 5),
        ]
        let level = opened(saved)
        XCTAssertEqual(level.capabilityHoldings, AccessCapabilityHoldings(answer: true, direct: true, notes: true))
        XCTAssertEqual(level.release, .reviewed(policyFamilyId: "policy-strict"))
        // Direct's own narrower list is kept as a second list.
        XCTAssertFalse(level.directSameAsAnswer)
        XCTAssertEqual(level.draft.creationSteps, [.permissions, .answerData, .directChoice, .directData, .future, .release, .review])
        XCTAssertEqual(level.draft.id, "new")
        XCTAssertNil(level.draft.expectedRevision)
        // No revision of the saved level is sent.
        XCTAssertEqual(sent(level), .connect(rules: rules, credentialLabel: "Northstar Assistant"))
    }

    /// Two reading rules that read the same accounts with the same filters
    /// reopen as the single shared list the level editor would show.
    func testMatchingReadingRulesReopenAsOneSharedList() {
        let boundary = AccessSourceBoundary(mode: .all, sourceIds: [])
        let level = opened([
            .direct(sources: boundary),
            .answer(sources: boundary, release: .unreviewed),
        ])
        XCTAssertTrue(level.directFollowsAnswer)
        XCTAssertEqual(level.draft.creationSteps, [.permissions, .answerData, .directChoice, .future, .release, .review])
        XCTAssertEqual(level.release, .unreviewed)

        let filter = ScopePolicy(
            sourceId: "github:maya-reeves",
            audience: .init(accessLevel: "level-saved", capability: "answer"),
            rules: [.init(match: [.tree(field: "extra.folderIds", id: "projects")], action: "share")],
            otherwise: "hide"
        )
        var copied = filter
        copied.audience.capability = "direct"
        let filtered = opened([
            .answer(sources: boundary, release: .unreviewed, filterRevision: 2, scopePolicies: [filter]),
            .direct(sources: boundary, filterRevision: 2, scopePolicies: [copied]),
        ])
        XCTAssertTrue(filtered.directFollowsAnswer, "The same filters on both rules are one list, as in the level editor")
        XCTAssertEqual(filtered.draft.serializedRules.flatMap(\.scopePolicies).map(\.audience.accessLevel), ["new", "new"])
    }

    /// A grant without Answer reopens without it: the prefill replaces the
    /// fresh-connection default rather than adding to it.
    func testANotesOnlyGrantReopensWithoutAnswer() {
        let level = opened([.notes])
        XCTAssertEqual(level.capabilityHoldings, AccessCapabilityHoldings(notes: true))
        XCTAssertEqual(level.draft.creationSteps, [.permissions, .review])
        XCTAssertEqual(sent(level), .connect(rules: [.notes], credentialLabel: "Northstar Assistant"))
    }

    /// An agent that asks through Answer holds it whatever the prefill says,
    /// and the owner cannot switch it off.
    func testAnAgentThatNeedsAnswerAlwaysHoldsIt() {
        let needsAnswer = renamedRequest(request.clientName, requiresAnswer: true)
        var level = opened([.notes], request: needsAnswer)
        XCTAssertTrue(level.answerRequired)
        XCTAssertEqual(level.capabilityHoldings, AccessCapabilityHoldings(answer: true, notes: true))
        level.setHeld("answer", false)
        XCTAssertTrue(level.holds("answer"))
        XCTAssertEqual(level.release, .reviewed(policyFamilyId: "policy-work-safe"))
    }

    /// A grant reviewed by a policy the overview no longer lists reopens on
    /// the default policy: the picker can only show what the overview offers,
    /// and a retired id would leave it with nothing selected.
    func testAReviewedPolicyTheOverviewNoLongerListsFallsBackToTheDefault() {
        let level = opened([
            .answer(
                sources: AccessSourceBoundary(mode: .all, sourceIds: []),
                release: .reviewed(policyFamilyId: "policy-retired")
            ),
        ])
        XCTAssertEqual(level.release, .reviewed(policyFamilyId: "policy-work-safe"))
        XCTAssertEqual(
            sent(level),
            .connect(
                rules: [.answer(
                    sources: AccessSourceBoundary(mode: .all, sourceIds: []),
                    release: .reviewed(policyFamilyId: "policy-work-safe")
                )],
                credentialLabel: "Northstar Assistant"
            )
        )
    }

    /// A grant that still names a source since removed keeps naming it: the
    /// reference survives the draft and goes back out in the selection, so a
    /// prefill approved as shown is the grant the gateway already accepts.
    func testASourceAbsentFromTheOverviewSurvivesIntoTheSelection() {
        let allowlist = AccessSourceBoundary(
            mode: .allowlist,
            sourceIds: ["github:maya-reeves", "github:retired-workspace"]
        )
        let denylist = AccessSourceBoundary(mode: .denylist, sourceIds: ["gmail:removed@example.com"])
        let rules: [AccessGrantRule] = [
            .direct(sources: allowlist),
            .answer(sources: denylist, release: .unreviewed),
        ]
        XCTAssertEqual(sent(opened(rules)), .connect(rules: rules, credentialLabel: "Northstar Assistant"))
    }

    /// A new level has to read an account that is connected: a prefill whose
    /// only account is gone is not sent until one is chosen.
    func testAPrefillThatReadsNoConnectedAccountIsNotSent() {
        let level = opened([
            .answer(sources: .init(mode: .allowlist, sourceIds: ["gmail:removed@example.com"]), release: .unreviewed),
        ])
        XCTAssertEqual(level.problem(.answerData), "Select at least one source for Answer.")
        XCTAssertNil(sent(level))
    }

    /// The level a refresh rebuilds follows the lookup taken with it: once
    /// the prefill it named is gone, the wizard opens on the defaults again.
    func testARefreshWithoutAPrefillReopensOnTheDefaults() {
        XCTAssertEqual(opened([.notes]).capabilityHoldings, AccessCapabilityHoldings(notes: true))

        let refreshed = opened(nil)
        XCTAssertEqual(refreshed.capabilityHoldings, AccessCapabilityHoldings(answer: true))
        XCTAssertEqual(refreshed.release, .reviewed(policyFamilyId: "policy-work-safe"))
        XCTAssertNil(sent(refreshed))
    }

    /// The credential label is the client's name, cut to what the wire holds.
    func testTheCredentialLabelIsTheClientNameWithinTheWireLimit() {
        let longName = String(repeating: "Northstar ", count: 20)
        let renamed = renamedRequest(longName)
        guard case .connect(_, let label)? = sent(opened([.notes], request: renamed), request: renamed) else {
            return XCTFail("Expected a connect selection")
        }
        XCTAssertEqual(label, String(longName.prefix(160)))
    }

    /// The cut lands on a character boundary: a name whose 160th UTF-16 unit
    /// is the first half of a surrogate pair loses the whole character, and
    /// one that fits exactly is kept whole.
    func testTheCredentialLabelNeverSplitsASurrogatePair() {
        let fill = String(repeating: "N", count: 159)
        for (name, expected) in [
            (fill + "🎉", fill),
            (String(fill.dropLast()) + "🎉", String(fill.dropLast()) + "🎉"),
        ] {
            let renamed = renamedRequest(name)
            guard case .connect(_, let label)? = sent(opened([.notes], request: renamed), request: renamed) else {
                return XCTFail("Expected a connect selection")
            }
            XCTAssertEqual(label, expected)
            XCTAssertLessThanOrEqual(label.utf16.count, 160)
        }
    }

    private func renamedRequest(_ clientName: String, requiresAnswer: Bool = false) -> AccessAuthorizationRequest {
        AccessAuthorizationRequest(
            id: request.id,
            approvalId: request.approvalId,
            status: request.status,
            clientId: request.clientId,
            clientName: clientName,
            clientUri: nil,
            redirectOrigin: request.redirectOrigin,
            resource: request.resource,
            scope: request.scope,
            expiresAt: request.expiresAt,
            requiresAnswer: requiresAnswer
        )
    }
}
