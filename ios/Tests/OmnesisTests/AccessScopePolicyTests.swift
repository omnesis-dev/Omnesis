// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

final class AccessScopePolicyTests: XCTestCase {
    private let policy = ScopePolicy(
        sourceId: "scope-chat:one",
        audience: .init(accessLevel: "level-example", capability: "answer"),
        rules: [.init(
            match: [
                .init(
                    kind: "participant",
                    label: "Maya",
                    identifiers: [.init(type: "email", value: "maya@example.org")]
                ),
                .init(kind: "conversation", id: "cedar"),
            ],
            action: "hide"
        )],
        otherwise: "share"
    )
    private var overview: AccessOverview {
        AccessOverview(
            principals: [],
            sources: [
                AccessSourceInstance(id: "scope-chat:one", name: "First account"),
                AccessSourceInstance(id: "scope-chat:two", name: "Second account"),
            ],
            policyFamilies: []
        )
    }

    private func level(_ rules: [AccessGrantRule]) -> AccessLevelSummary {
        AccessLevelSummary(
            id: "level-example",
            name: "Research assistant",
            revision: 7,
            rules: rules,
            connectionCount: 2,
            createdAt: 1,
            updatedAt: 2
        )
    }

    func testNewFilterDiscoveryRequiresExplicitAuthoringAvailability() {
        for enabled in [nil, false] as [Bool?] {
            XCTAssertFalse(accessFilterEntryVisible(
                authoringEnabled: enabled, sourceAllowed: true, hasDeclaration: true, hasSavedPolicy: false
            ))
        }
        XCTAssertTrue(accessFilterEntryVisible(
            authoringEnabled: true, sourceAllowed: true, hasDeclaration: true, hasSavedPolicy: false
        ))
        XCTAssertFalse(accessFilterEntryVisible(
            authoringEnabled: true, sourceAllowed: false, hasDeclaration: true, hasSavedPolicy: false
        ))
        XCTAssertFalse(accessFilterEntryVisible(
            authoringEnabled: true, sourceAllowed: true, hasDeclaration: false, hasSavedPolicy: false
        ))
    }

    func testSavedFilterInspectionSurvivesDisabledAuthoringAndMissingSource() {
        for enabled in [nil, false] as [Bool?] {
            XCTAssertTrue(accessFilterEntryVisible(
                authoringEnabled: enabled, sourceAllowed: false, hasDeclaration: false, hasSavedPolicy: true
            ))
        }
    }

    func testExplicitCopyCannotAddOrRemoveFiltersWhenAuthoringIsUnavailable() {
        let directPolicy = ScopePolicy(
            sourceId: policy.sourceId,
            audience: .init(accessLevel: "level-example", capability: "direct"),
            rules: policy.rules,
            otherwise: policy.otherwise
        )
        for (answerPolicies, directPolicies, enabled, permitted) in [
            ([policy], [], false, false), ([], [directPolicy], false, false), ([], [], false, true), ([policy], [directPolicy], true, true),
        ] {
            let answer = AccessGrantRule.answer(
                sources: .init(mode: .allowlist, sourceIds: [policy.sourceId]),
                release: .unreviewed,
                scopePolicies: answerPolicies
            )
            let direct = AccessGrantRule.direct(sources: .init(mode: .all, sourceIds: []), scopePolicies: directPolicies)
            var draft = AccessLevelDraft(level: level([answer, direct]), overview: overview)
            let original = draft
            XCTAssertEqual(draft.canCopyAnswer(authoringEnabled: enabled), permitted)
            draft.copyAnswer(authoringEnabled: enabled)
            if permitted {
                XCTAssertEqual(draft.rule("direct")?.boundary, answer.boundary)
                XCTAssertEqual(draft.rule("direct")?.scopePolicies.map(\.rules), answerPolicies.map(\.rules))
            } else { XCTAssertEqual(draft, original) }
        }
    }

    func testSourceBoundaryChangesMustRetainKnownAndUnknownFilteredAccountsWhenReadOnly() {
        var missing = policy
        missing.sourceId = "scope-chat:missing"
        let answer = AccessGrantRule.answer(
            sources: .init(mode: .all, sourceIds: []),
            release: .unreviewed,
            scopePolicies: [policy, missing]
        )
        var draft = AccessLevelDraft(level: level([answer]), overview: overview)
        let original = draft
        for boundary in [
            AccessSourceBoundary(mode: .allowlist, sourceIds: [policy.sourceId]),
            .init(mode: .denylist, sourceIds: [missing.sourceId]),
        ] {
            draft.setBoundary(boundary, capability: "answer", authoringEnabled: false)
            XCTAssertEqual(draft, original)
        }
        let retained = AccessSourceBoundary(mode: .allowlist, sourceIds: [policy.sourceId, missing.sourceId])
        draft.setBoundary(retained, capability: "answer", authoringEnabled: false)
        XCTAssertEqual(draft.rule("answer")?.boundary, retained)
        XCTAssertEqual(draft.rule("answer")?.scopePolicies, [policy, missing])
        draft.setBoundary(.init(mode: .allowlist, sourceIds: [policy.sourceId]), capability: "answer", authoringEnabled: true)
        XCTAssertEqual(draft.rule("answer")?.scopePolicies, [policy])
        draft.setEnabled("answer", false, overview: overview)
        XCTAssertNil(draft.rule("answer"))
    }

    func testConsentCannotRelinkIndependentSavedFiltersWhileReadOnlyButCanUnlinkSafely() {
        for capability in ["answer", "direct"] {
            var form = AccessAuthorizationFormState(sourceIds: overview.availableSourceIds)
            form.linkSources = false
            form.scopePolicies = [capability: [policy]]
            form.setLinkedSources(true, authoringEnabled: false)
            XCTAssertFalse(form.linkSources)
            XCTAssertEqual(form.scopePolicies, [capability: [policy]])
            form.setLinkedSources(true, authoringEnabled: true)
            XCTAssertTrue(form.linkSources)
        }
        var unfiltered = AccessAuthorizationFormState(sourceIds: overview.availableSourceIds)
        unfiltered.linkSources = false
        unfiltered.setLinkedSources(true, authoringEnabled: false)
        XCTAssertTrue(unfiltered.linkSources)
        unfiltered.scopePolicies = ["answer": [policy]]
        unfiltered.setLinkedSources(false, authoringEnabled: false)
        XCTAssertEqual(unfiltered.scopePolicies["direct"]?.first?.rules, policy.rules)
    }

    func testConsentBoundaryRejectsRemovalOfAnUnknownFilteredAccountWithoutBlockingUnfilteredEdits() {
        var missing = policy
        missing.sourceId = "scope-chat:missing"
        var form = AccessAuthorizationFormState(sourceIds: overview.availableSourceIds)
        form.linkSources = false
        form.answerSources.setMode(.all, knownSourceIds: overview.availableSourceIds)
        form.scopePolicies = ["answer": [missing]]
        let original = form.answerSources
        let blocked = AccessSourceSelectionState(
            boundary: .init(mode: .allowlist, sourceIds: Array(overview.availableSourceIds)),
            knownSourceIds: overview.availableSourceIds
        )
        form.setSources(blocked, for: .answer, knownSourceIds: overview.availableSourceIds, authoringEnabled: false)
        XCTAssertEqual(form.answerSources, original)
        form.setSources(blocked, for: .direct, knownSourceIds: overview.availableSourceIds, authoringEnabled: false)
        XCTAssertEqual(form.directSources, blocked)
    }

    func testNewAuthoritySelectionGatesEffectivePoliciesWithoutHidingReviewOrExistingReuse() throws {
        let fixtures = AccessConnectionFixtures()
        let request = fixtures.request()
        let answer = AccessGrantRule.answer(
            sources: .init(mode: .all, sourceIds: []),
            release: .unreviewed,
            filterRevision: 7,
            scopePolicies: [policy]
        )
        var catalogue = AccessOverview(principals: [], sources: overview.sources, policyFamilies: [], levels: [level([answer])])
        var form = AccessAuthorizationFormState.opening(request: request, overview: catalogue, prefill: [answer])
        let choice = AccessConnectionChoice.opening(
            request: request,
            overview: catalogue,
            proposal: fixtures.proposal(.newLevel, match: false),
            nowMillis: fixtures.now
        )
        XCTAssertFalse(try XCTUnwrap(form.rules(request: request, overview: catalogue).first?.scopePolicies.isEmpty))
        XCTAssertNil(form.rules(request: request, overview: catalogue).first?.filterRevision)
        XCTAssertEqual(form.rules(request: request, overview: catalogue).first?.scopePolicies.first?.audience.accessLevel, "new")
        XCTAssertNil(form.selection(request: request, overview: catalogue))
        XCTAssertNil(choice.selection(request: request, overview: catalogue, form: form))
        var reused = choice
        reused.levelId = "level-example"
        XCTAssertNotNil(reused.selection(request: request, overview: catalogue, form: form))
        catalogue.sourceFilters = .init(enabled: true)
        XCTAssertNotNil(form.selection(request: request, overview: catalogue))
        XCTAssertNotNil(choice.selection(request: request, overview: catalogue, form: form))
        catalogue.sourceFilters = .init(enabled: false)
        form.answerEnabled = false
        form.notesEnabled = true
        XCTAssertEqual(form.scopePolicies["answer"], [policy])
        XCTAssertNotNil(form.selection(request: request, overview: catalogue))
        XCTAssertNotNil(choice.selection(request: request, overview: catalogue, form: form))
        form.answerEnabled = true
        form.scopePolicies = [:]
        XCTAssertNotNil(form.selection(request: request, overview: catalogue))
        XCTAssertNotNil(choice.selection(request: request, overview: catalogue, form: form))
        let clearedRule = AccessGrantRule.answer(sources: answer.boundary, release: .unreviewed, filterRevision: 7, scopePolicies: [])
        let cleared = AccessAuthorizationFormState.opening(request: request, overview: catalogue, prefill: [clearedRule])
        XCTAssertNil(cleared.rules(request: request, overview: catalogue).first?.filterRevision)
        XCTAssertNotNil(choice.selection(request: request, overview: catalogue, form: cleared))
    }

    func testFilteredRuleRoundtripKeepsTypedIdentifiersAndRevision() throws {
        let rule = AccessGrantRule.answer(
            sources: .init(mode: .all, sourceIds: []),
            release: .unreviewed,
            filterRevision: 9,
            scopePolicies: [policy]
        )
        let data = try JSONEncoder().encode(rule)
        XCTAssertEqual(try JSONDecoder().decode(AccessGrantRule.self, from: data), rule)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(json["filterRevision"] as? Int, 9)
        XCTAssertNotNil(json["scopePolicies"])
    }

    func testSavedDirectCopyIsExplicitAndLaterAnswerChangesStayIndependent() {
        let answer = AccessGrantRule.answer(
            sources: .init(mode: .all, sourceIds: []),
            release: .unreviewed,
            filterRevision: 4,
            scopePolicies: [policy]
        )
        var draft = AccessLevelDraft(
            level: level([answer, .direct(sources: .init(mode: .all, sourceIds: []), filterRevision: 2)]),
            overview: overview
        )
        XCTAssertFalse(draft.directSameAsAnswer)
        XCTAssertEqual(draft.rule("direct")?.scopePolicies, [])
        draft.copyAnswer()
        XCTAssertEqual(draft.rule("direct")?.scopePolicies.first?.audience.capability, "direct")
        draft.setPolicy(nil, sourceId: policy.sourceId, capability: "answer")
        XCTAssertEqual(draft.serializedRules.first { $0.capability == "direct" }?.scopePolicies.count, 1)
        draft.setEnabled("answer", false, overview: overview)
        XCTAssertEqual(draft.expectedFilterRevisions, ["answer": 4, "direct": 2])
    }

    func testPoliciesStayWithTheirSourceAccountAndIdentifiersDoNotGrow() {
        var second = policy
        second.sourceId = "scope-chat:two"
        let answer = AccessGrantRule.answer(
            sources: .init(mode: .all, sourceIds: []),
            release: .unreviewed,
            scopePolicies: [policy, second]
        )
        var draft = AccessLevelDraft(level: level([answer]), overview: overview)
        draft.setPolicy(nil, sourceId: policy.sourceId, capability: "answer")
        XCTAssertEqual(draft.rule("answer")?.scopePolicies, [second])
        XCTAssertEqual(second.rules[0].match[0].identifiers?.map(\.value), ["maya@example.org"])
    }

    func testNewDirectLinkMaterializesAnIndependentAudience() {
        var draft = AccessLevelDraft(level: nil, overview: overview)
        draft.setEnabled("direct", true, overview: overview)
        var policy = policy
        policy.audience.accessLevel = "new"
        draft.setPolicy(policy, sourceId: policy.sourceId, capability: "answer")
        XCTAssertEqual(
            draft.serializedRules.first { $0.capability == "direct" }?.scopePolicies.first?.audience,
            .init(accessLevel: "new", capability: "direct")
        )
    }

    func testTypedIdentifierValidationRefusesOpaqueAndWrongKindValues() {
        XCTAssertNil(scopeTypedIdentifier("opaque-member", type: "phone"))
        XCTAssertNil(scopeTypedIdentifier("maya@example.org", type: "phone"))
        XCTAssertEqual(scopeTypedIdentifier("+1 (555) 010-0123", type: "phone")?.value, "+15550100123")
        XCTAssertEqual(scopeTypedIdentifier("EXAMPLE.ORG", type: "domain")?.value, "example.org")
    }

    func testNewFilteredRuleExplicitlySerializesZeroRevision() throws {
        let rule = AccessGrantRule.direct(sources: .init(mode: .all, sourceIds: []), scopePolicies: [policy])
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(rule)) as? [String: Any])
        XCTAssertEqual(json["filterRevision"] as? Int, 0)
    }

    func testConsentCopyPreservesCapturedIdentifiersWithoutLinkingDifferentFilters() {
        let request = AccessAuthorizationRequest(
            id: "request-example",
            approvalId: "approval-example",
            status: "pending",
            clientId: "client-example",
            clientName: "Research assistant",
            clientUri: nil,
            redirectOrigin: "https://client.example",
            resource: "https://gateway.example/mcp",
            scope: "omnesis:access",
            expiresAt: 1_800_000_000_000,
            requiresAnswer: false
        )
        let boundary = AccessSourceBoundary(mode: .all, sourceIds: [])
        let form = AccessAuthorizationFormState.opening(request: request, overview: overview, prefill: [
            .answer(sources: boundary, release: .unreviewed, filterRevision: 4, scopePolicies: [policy]), .direct(sources: boundary),
        ])
        XCTAssertFalse(form.linkSources)
        let rules = form.rules(request: request, overview: overview)
        XCTAssertEqual(rules.first { $0.capability == "answer" }?.scopePolicies.first?.rules, policy.rules)
        XCTAssertEqual(rules.first { $0.capability == "answer" }?.scopePolicies.first?.audience.accessLevel, "new")
        XCTAssertEqual(rules.first { $0.capability == "direct" }?.scopePolicies, [])
    }

    func testSourcePreparationBlocksEmptyListsButUnrelatedKindsDoNot() {
        let empty = ScopePolicy.empty(sourceId: "scope-chat:one", levelId: "new", capability: "answer")
        XCTAssertFalse(empty.readyToSave([.init(kind: "participant", ready: false, reason: "backfill")]))
        XCTAssertTrue(empty.readyToSave([.init(kind: "folder", ready: false, reason: "metadata-refresh")]))
        XCTAssertTrue(policy.readyToSave([
            .init(kind: "participant", ready: true),
            .init(kind: "conversation", ready: true),
            .init(kind: "folder", ready: false),
        ]))
        XCTAssertFalse(policy.readyToSave([.init(kind: "participant", ready: false), .init(kind: "conversation", ready: true)]))
    }

    func testMissingPrivacyPolicyNeverDefaultsToUnreviewedRelease() {
        var draft = AccessLevelDraft(level: nil, overview: overview)
        draft.name = "Research assistant"
        XCTAssertFalse(draft.valid)
        guard let answer = draft.rule("answer") else { return XCTFail("Answer starts enabled") }
        draft.setRule(answer.replacing(release: .unreviewed))
        XCTAssertTrue(draft.valid)
    }

    func testUnlinkingANewDraftMaterializesTheWholeAnswerPolicy() {
        var draft = AccessLevelDraft(level: nil, overview: overview)
        draft.setEnabled("direct", true, overview: overview)
        draft.setPolicy(policy, sourceId: policy.sourceId, capability: "answer")
        draft.setDirectSameAsAnswer(false)
        draft.setPolicy(nil, sourceId: policy.sourceId, capability: "answer")
        XCTAssertEqual(draft.rule("direct")?.scopePolicies.first?.rules, policy.rules)
        XCTAssertEqual(draft.rule("direct")?.scopePolicies.first?.audience.capability, "direct")
    }

    func testDisablingAnswerInConsentPreservesTheLinkedDirectFilter() {
        var form = AccessAuthorizationFormState(sourceIds: [policy.sourceId])
        form.directEnabled = true
        form.scopePolicies["answer"] = [policy]
        form.setAnswerEnabled(false, requiresAnswer: false)
        XCTAssertFalse(form.linkSources)
        XCTAssertEqual(form.scopePolicies["direct"]?.first?.rules, policy.rules)
        XCTAssertEqual(form.scopePolicies["direct"]?.first?.audience.capability, "direct")
    }

    func testDirectOnlyConsentCopyKeepsItsFilter() {
        let request = AccessAuthorizationRequest(
            id: "request-example",
            approvalId: "approval-example",
            status: "pending",
            clientId: "client-example",
            clientName: "Research assistant",
            clientUri: nil,
            redirectOrigin: "https://client.example",
            resource: "https://gateway.example/mcp",
            scope: "omnesis:access",
            expiresAt: 1_800_000_000_000,
            requiresAnswer: false
        )
        var directPolicy = policy
        directPolicy.audience.capability = "direct"
        let form = AccessAuthorizationFormState.opening(request: request, overview: overview, prefill: [
            .direct(sources: .init(mode: .all, sourceIds: []), filterRevision: 4, scopePolicies: [directPolicy]),
        ])
        XCTAssertEqual(form.rules(request: request, overview: overview).first?.scopePolicies.first?.rules, policy.rules)
    }

    func testDisablingAnswerRetainsAnIndependentDirectCopy() {
        var draft = AccessLevelDraft(level: nil, overview: overview)
        draft.setEnabled("direct", true, overview: overview)
        draft.setPolicy(policy, sourceId: policy.sourceId, capability: "answer")
        draft.setEnabled("answer", false, overview: overview)
        XCTAssertFalse(draft.directSameAsAnswer)
        XCTAssertEqual(draft.rule("direct")?.scopePolicies.first?.rules, policy.rules)
    }

    func testReservedPolicyIsReadOnlyAndRoundtrips() throws {
        var future = policy
        future.maxAge = "90d"
        future.rules[0].action = "ask"
        XCTAssertFalse(future.editable)
        XCTAssertEqual(try JSONDecoder().decode(ScopePolicy.self, from: JSONEncoder().encode(future)), future)
    }
}
