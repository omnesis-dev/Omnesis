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

extension AccessScopePolicyTests {
    func testGuidedCreateSkipsIrrelevantQuestionsAndBackDoesNotMutateRules() {
        var draft = AccessLevelDraft(level: nil, overview: overview)
        draft.setEnabled("answer", false, overview: overview)
        draft.setEnabled("notes", true, overview: overview)
        XCTAssertEqual(draft.creationSteps, [.permissions, .review])
        let before = draft.serializedRules
        XCTAssertEqual(draft.nextStep(after: .permissions), .review)
        XCTAssertEqual(draft.previousStep(before: .review), .permissions)
        XCTAssertEqual(draft.serializedRules, before)
        draft.setEnabled("direct", true, overview: overview)
        XCTAssertEqual(draft.creationSteps, [.permissions, .directData, .future, .review])
        draft.setEnabled("answer", true, overview: overview)
        XCTAssertTrue(draft.creationSteps.contains(.directChoice))
        draft.setDirectSameAsAnswer(false)
        XCTAssertTrue(draft.creationSteps.contains(.directData))
    }

    func testTargetedEditKeepsIndependentDirectAndRevisionGuards() throws {
        let answer = AccessGrantRule.answer(
            sources: .init(mode: .allowlist, sourceIds: ["scope-chat:one"]),
            release: .unreviewed,
            filterRevision: 3,
            scopePolicies: [policy]
        )
        let direct = AccessGrantRule.direct(sources: .init(mode: .denylist, sourceIds: ["scope-chat:two"]), filterRevision: 5)
        let original = AccessLevelDraft(level: level([answer, direct]), overview: overview)
        var draft = original
        draft.setRule(answer.replacing(release: .reviewed(policyFamilyId: "review-policy")))
        XCTAssertEqual(draft.changedCapabilities(from: original), ["answer"])
        XCTAssertEqual(draft.rule("direct"), direct)
        XCTAssertEqual(draft.expectedRevision, 7)
        XCTAssertEqual(draft.expectedFilterRevisions, ["answer": 3, "direct": 5])
        let encoded = try JSONEncoder().encode(draft.serializedRules)
        XCTAssertEqual(try JSONDecoder().decode([AccessGrantRule].self, from: encoded), draft.serializedRules)
    }

    func testFilterModeAllContentIsExplicitAndDoesNotMutateSavedPolicy() {
        let original = policy
        let all = ScopeFilterMode.all.applying(to: original)
        XCTAssertTrue(all.rules[0].match.isEmpty)
        XCTAssertEqual(all.otherwise, "share")
        XCTAssertEqual(original, policy)
        let only = ScopeFilterMode.only.applying(to: original)
        XCTAssertEqual(only.rules[0].match, original.rules[0].match)
        XCTAssertEqual(only.otherwise, "hide")
        XCTAssertEqual(ScopeFilterMode(policy: original, hasSavedPolicy: true), .except)
    }

    func testSavedRuleSummarySurvivesUnavailableCountsWithoutRawKeys() {
        XCTAssertEqual(accessRestrictionSummary(nil), "All content")
        let summary = accessRestrictionSummary(policy)
        XCTAssertTrue(summary.hasPrefix("Except:"))
        XCTAssertTrue(summary.contains("Maya"))
        XCTAssertTrue(summary.contains("Unavailable saved item"))
        XCTAssertFalse(summary.contains("cedar"))
    }

    func testFolderNavigationKeepsSearchAndMethodUntilAnExplicitKindChange() {
        let folder = ScopeOption(ref: .init(kind: "folder", id: "design", label: "Design"), label: "Design", count: 8)
        var session = ScopePickerSession(kind: "folder", query: "plan", parentId: "design", ancestors: [folder])
        session.changeKind("folder", scopes: nil)
        XCTAssertEqual(session.parentId, "design")
        XCTAssertEqual(session.ancestors, [folder])
        session.goToParent()
        XCTAssertNil(session.parentId)
        XCTAssertTrue(session.ancestors.isEmpty)
        XCTAssertEqual(session.query, "plan")
        XCTAssertEqual(session.kind, "folder")
        session.parentId = "design"
        session.ancestors = [folder]
        session.changeKind("label", scopes: nil)
        XCTAssertNil(session.parentId)
        XCTAssertTrue(session.ancestors.isEmpty)
        XCTAssertEqual(session.query, "plan")
        XCTAssertEqual(session.kind, "label")
    }
}

extension AccessScopePolicyTests {
    func testReviewNameValidationTrimsChecksLengthAndExemptsOwnLevel() {
        let saved = level([.notes])
        XCTAssertNotNil(accessLevelNameProblem("  ", id: "new", levels: [saved]))
        XCTAssertNotNil(accessLevelNameProblem(String(repeating: "x", count: 121), id: "new", levels: []))
        XCTAssertNotNil(accessLevelNameProblem("  RESEARCH ASSISTANT ", id: "new", levels: [saved]))
        XCTAssertNil(accessLevelNameProblem("  RESEARCH ASSISTANT ", id: saved.id, levels: [saved]))
        XCTAssertNil(accessLevelNameProblem("Library helper", id: "new", levels: [saved]))
    }
}

extension AccessScopePolicyTests {
    func testDataQuestionsRejectEmptySelectionsButRetainUnavailableSavedAuthority() {
        let new = AccessLevelDraft(level: nil, overview: overview)
        XCTAssertNotNil(new.sourceProblem("answer", overview: overview, original: new))
        var selected = new
        selected.setBoundary(.init(mode: .allowlist, sourceIds: ["scope-chat:one"]), capability: "answer", authoringEnabled: true)
        XCTAssertNil(selected.sourceProblem("answer", overview: overview, original: new))
        let missing = AccessLevelDraft(
            level: level([.direct(sources: .init(mode: .allowlist, sourceIds: ["scope-chat:retained"]))]),
            overview: overview
        )
        XCTAssertNil(missing.sourceProblem("direct", overview: overview, original: missing))
        var changedMode = missing
        changedMode.setBoundary(.init(mode: .denylist, sourceIds: ["scope-chat:retained"]), capability: "direct", authoringEnabled: true)
        XCTAssertNotNil(changedMode.sourceProblem("direct", overview: overview, original: missing))
        var blocked = selected
        blocked.setBoundary(.init(mode: .denylist, sourceIds: overview.sources.map(\.id)), capability: "answer", authoringEnabled: true)
        XCTAssertNotNil(blocked.sourceProblem("answer", overview: overview, original: new))
    }

    func testCanonicalAccountChangesDetectDifferentReferencesWithIdenticalLabels() {
        let source = "scope-chat:one"
        var first = AccessLevelDraft(
            level: level([.direct(sources: .init(mode: .allowlist, sourceIds: [source]), scopePolicies: [policy])]),
            overview: overview
        )
        var second = first
        var changed = policy
        changed.rules[0].match[1].id = "different-stable-selection"
        second.setPolicy(changed, sourceId: source, capability: "direct")
        let known = overview.availableSourceIds
        XCTAssertNotEqual(
            AccessAccountDecision(draft: first, capability: "direct", sourceId: source, knownIds: known),
            AccessAccountDecision(draft: second, capability: "direct", sourceId: source, knownIds: known)
        )
        changed = policy
        changed.rules[0].match[0].label = "Updated display label"
        first.setPolicy(changed, sourceId: source, capability: "direct")
        XCTAssertEqual(
            AccessAccountDecision(draft: first, capability: "direct", sourceId: source, knownIds: known),
            AccessAccountDecision(
                draft: AccessLevelDraft(level: level([.direct(
                    sources: .init(mode: .allowlist, sourceIds: [source]),
                    scopePolicies: [policy]
                )]), overview: overview),
                capability: "direct",
                sourceId: source,
                knownIds: known
            )
        )
    }

    func testAccountPresentationDistinguishesAccountsWithSameProviderName() {
        XCTAssertEqual(accessSourceDisplayName(.init(id: "mail:team@example.org", name: "Mail")), "Mail · team@example.org")
        XCTAssertEqual(
            accessSourceDisplayName(.init(id: "mail:team@example.org", name: "Mail · team@example.org")),
            "Mail · team@example.org"
        )
    }
}

extension AccessScopePolicyTests {
    func testAllContentCommitRemovesRestrictionDuringBackfillWithoutInventingHiddenFacts() {
        let all = ScopeFilterMode.all.applying(to: policy)
        XCTAssertEqual(
            ScopeFilterCommitState(
                mode: .all,
                policy: all,
                sourceId: all.sourceId,
                authoringEnabled: true,
                preview: nil,
                previewedPolicy: nil,
                loading: true,
                hasError: true
            ).decision,
            .apply(nil)
        )
        XCTAssertEqual(
            ScopeFilterCommitState(
                mode: .all,
                policy: all,
                sourceId: all.sourceId,
                authoringEnabled: false,
                preview: nil,
                previewedPolicy: nil,
                loading: false,
                hasError: false
            ).decision,
            .blocked
        )
        XCTAssertEqual(
            ScopeFilterCommitState(
                mode: .all,
                policy: all,
                sourceId: "other-source",
                authoringEnabled: true,
                preview: nil,
                previewedPolicy: nil,
                loading: false,
                hasError: false
            ).decision,
            .blocked
        )
        let pending = ScopePreview(
            sourceId: policy.sourceId,
            total: 3,
            visible: 0,
            hidden: 3,
            unknown: 3,
            items: [],
            samples: [],
            readiness: [.init(kind: "participant", ready: false, reason: "backfill")]
        )
        XCTAssertEqual(
            ScopeFilterCommitState(
                mode: .except,
                policy: policy,
                sourceId: policy.sourceId,
                authoringEnabled: true,
                preview: pending,
                previewedPolicy: policy,
                loading: false,
                hasError: false
            ).decision,
            .blocked
        )
    }
}

extension AccessScopePolicyTests {
    func testTargetedReviewChangeReturnsToReviewAndRetainsDraftWithoutReplayingQuestions() {
        var draft = AccessLevelDraft(level: nil, overview: overview)
        draft.name = "Library helper"
        draft.setBoundary(.init(mode: .allowlist, sourceIds: ["scope-chat:one"]), capability: "answer", authoringEnabled: true)
        var navigation = AccessFlowNavigation(step: .review, started: true)
        navigation.open(.answerData, isEditing: false, draft: draft)
        let before = draft.serializedRules
        navigation.advance(draft: draft, isEditing: false)
        XCTAssertEqual(navigation.step, .review)
        XCTAssertEqual(draft.serializedRules, before)
        navigation.open(.release, isEditing: false, draft: draft)
        navigation.back(draft: draft, isEditing: false)
        XCTAssertEqual(navigation.step, .review)
        var editing = AccessFlowNavigation()
        XCTAssertEqual(editing.current(isEditing: true), .overview)
        editing.open(.future, isEditing: true, draft: draft)
        editing.advance(draft: draft, isEditing: true)
        XCTAssertEqual(editing.current(isEditing: true), .overview)
        XCTAssertEqual(draft.serializedRules, before)
    }
}

extension AccessScopePolicyTests {
    func testLabelHydrationKeepsBeforeAndAfterIdentitiesWithoutBecomingAuthority() {
        let before = ScopeRef(kind: "folder", id: "old-folder")
        let after = ScopeRef(kind: "folder", id: "new-folder")
        let first = ScopePreview.Item(ref: before, label: "Design", count: 7)
        let second = ScopePreview.Item(ref: after, label: "Archive", count: 7)
        let hints = mergingScopeLabelHints([first], [second])
        XCTAssertEqual(hints.map(\.label), ["Design", "Archive"])
        XCTAssertFalse(scopeRefIdentityMatches(before, after))
        let updated = ScopePreview.Item(ref: before, label: "Design plans", count: 8)
        XCTAssertEqual(mergingScopeLabelHints(hints, [updated]).map(\.label), ["Design plans", "Archive"])
    }
}

extension AccessScopePolicyTests {
    func testRevertingReleaseAndWhitespaceNameRestoresOriginalAuthorityWithoutDirtyReview() throws {
        let original = AccessLevelDraft(level: level([
            .answer(sources: .init(mode: .allowlist, sourceIds: ["scope-chat:one"]), release: .unreviewed),
            .direct(sources: .init(mode: .allowlist, sourceIds: ["scope-chat:two"])), .notes,
        ]), overview: overview)
        var draft = original
        try draft.setRule(XCTUnwrap(draft.rule("answer")?.replacing(release: .reviewed(policyFamilyId: "review-policy"))))
        XCTAssertTrue(draft.hasChanges(from: original))
        try draft.setRule(XCTUnwrap(draft.rule("answer")?.replacing(release: .unreviewed)))
        draft.name = "  " + original.name + "  "
        XCTAssertFalse(draft.hasChanges(from: original))
        XCTAssertTrue(draft.changedCapabilities(from: original).isEmpty)
        XCTAssertEqual(draft.expectedRevision, original.expectedRevision)
        XCTAssertEqual(draft.expectedFilterRevisions, original.expectedFilterRevisions)
    }
}

extension AccessScopePolicyTests {
    func testMissingSelectionKeepsFriendlyNameAndNeverPromotesOpaqueIdToPrimaryLabel() {
        let ref = ScopeRef(kind: "folder", id: "opaque-selection-key", label: "Blueprints")
        let missing = ScopePreview.Item(ref: ref, label: "opaque-selection-key", count: 0, missing: true)
        XCTAssertEqual(scopeDisplayLabel(ref, previewItem: missing), "Blueprints (unavailable)")
        let unlabelled = ScopeRef(kind: "folder", id: "opaque-selection-key")
        XCTAssertEqual(scopeDisplayLabel(unlabelled, previewItem: missing), "Saved item (unavailable)")
        let current = ScopePreview.Item(ref: ref, label: "Updated blueprints", count: 8)
        XCTAssertEqual(scopeDisplayLabel(ref, previewItem: current), "Updated blueprints")
    }
}

extension AccessScopePolicyTests {
    func testReleaseQuestionRequiresAnAvailablePolicyOrExplicitAutomaticRelease() throws {
        var draft = AccessLevelDraft(level: nil, overview: overview)
        XCTAssertFalse(draft.releaseIsValid(overview: overview))
        try draft.setRule(XCTUnwrap(draft.rule("answer")?.replacing(release: .reviewed(policyFamilyId: "retired-policy"))))
        XCTAssertFalse(draft.releaseIsValid(overview: overview))
        try draft.setRule(XCTUnwrap(draft.rule("answer")?.replacing(release: .unreviewed)))
        XCTAssertTrue(draft.releaseIsValid(overview: overview))
    }

    func testFormattedPhoneAccountIsNotRepeatedInCanonicalForm() {
        let source = AccessSourceInstance(id: "messaging:+15550100111", name: "Messaging · +1 (555) 010-0111")
        XCTAssertEqual(accessSourceDisplayName(source), source.name)
    }
}

extension AccessScopePolicyTests {
    func testAddingAnswerFromNotesOnlyReviewVisitsOnlyNewRequiredQuestions() throws {
        var draft = AccessLevelDraft(level: nil, overview: overview)
        draft.setEnabled("answer", false, overview: overview)
        draft.setEnabled("notes", true, overview: overview)
        var navigation = AccessFlowNavigation(step: .review, started: true)
        navigation.open(.permissions, isEditing: false, draft: draft)
        draft.setEnabled("answer", true, overview: overview)
        navigation.advance(draft: draft, isEditing: false)
        XCTAssertEqual(navigation.step, .answerData)
        draft.setBoundary(.init(mode: .allowlist, sourceIds: ["scope-chat:one"]), capability: "answer", authoringEnabled: true)
        navigation.advance(draft: draft, isEditing: false)
        XCTAssertEqual(navigation.step, .future)
        navigation.advance(draft: draft, isEditing: false)
        XCTAssertEqual(navigation.step, .release)
        try draft.setRule(XCTUnwrap(draft.rule("answer")?.replacing(release: .unreviewed)))
        navigation.advance(draft: draft, isEditing: false)
        XCTAssertEqual(navigation.step, .review)
    }

    func testLinkedReviewDirectEditMaterializesExactRulesAndKeepsAnswerUnchanged() {
        var draft = AccessLevelDraft(level: nil, overview: overview)
        draft.setRule(.answer(
            sources: .init(mode: .allowlist, sourceIds: ["scope-chat:one"]),
            release: .unreviewed,
            scopePolicies: [policy]
        ))
        draft.setEnabled("direct", true, overview: overview)
        let answer = draft.rule("answer")
        XCTAssertTrue(draft.prepareDirectEditing(authoringEnabled: true))
        XCTAssertFalse(draft.directSameAsAnswer)
        var navigation = AccessFlowNavigation(step: .review, started: true)
        navigation.open(.directData, isEditing: false, draft: draft)
        draft.setBoundary(.init(mode: .allowlist, sourceIds: ["scope-chat:two"]), capability: "direct", authoringEnabled: true)
        var directPolicy = policy
        directPolicy.sourceId = "scope-chat:two"
        directPolicy.audience = .init(accessLevel: draft.id, capability: "direct")
        draft.setPolicy(directPolicy, sourceId: directPolicy.sourceId, capability: "direct")
        navigation.advance(draft: draft, isEditing: false)
        XCTAssertEqual(navigation.step, .review)
        XCTAssertEqual(draft.serializedRules.first { $0.capability == "answer" }, answer)
        XCTAssertEqual(draft.serializedRules.first { $0.capability == "direct" }?.boundary.sourceIds, ["scope-chat:two"])
        XCTAssertEqual(draft.serializedRules.first { $0.capability == "direct" }?.scopePolicies, [directPolicy])
    }

    func testUnsupportedLinkedRestrictionCannotBeSilentlyDroppedDuringDirectCustomization() {
        var draft = AccessLevelDraft(level: nil, overview: overview)
        draft.setRule(.answer(
            sources: .init(mode: .allowlist, sourceIds: ["scope-chat:one"]),
            release: .unreviewed,
            scopePolicies: [policy]
        ))
        draft.setEnabled("direct", true, overview: overview)
        let before = draft.serializedRules
        XCTAssertFalse(draft.prepareDirectEditing(authoringEnabled: false))
        XCTAssertTrue(draft.directSameAsAnswer)
        XCTAssertEqual(draft.serializedRules, before)
    }
}

extension AccessScopePolicyTests {
    func testLevelInUseRemediationRestoresOnlyOriginalAnswerAndKeepsDirectDraft() {
        let original = AccessLevelDraft(level: level([
            .answer(sources: .init(mode: .allowlist, sourceIds: ["scope-chat:one"]), release: .unreviewed, scopePolicies: [policy]),
            .direct(sources: .init(mode: .allowlist, sourceIds: ["scope-chat:two"])),
        ]), overview: overview)
        var draft = original
        draft.setEnabled("answer", false, overview: overview)
        let direct = draft.rule("direct")
        let error = GatewayClient.Error.serverError(status: 409, body: #"{"error":"level-in-use"}"#)
        XCTAssertEqual(accessLevelMutationCode(error), "level-in-use")
        XCTAssertTrue(draft.restoreAnswer(from: original))
        XCTAssertEqual(draft.rule("answer"), original.rule("answer"))
        XCTAssertEqual(draft.rule("direct"), direct)
        XCTAssertEqual(draft.expectedFilterRevisions, original.expectedFilterRevisions)
        XCTAssertNil(accessLevelMutationCode(GatewayClient.Error.serverError(status: 500, body: #"{"error":"level-in-use"}"#)))
    }
}

extension AccessScopePolicyTests {
    func testContinueValidationUsesCurrentQuestionAndCanResolveMissingPolicyWithoutRestarting() throws {
        var draft = AccessLevelDraft(level: nil, overview: overview)
        let original = draft
        XCTAssertFalse(draft.questionIsValid(.answerData, overview: overview, original: original))
        XCTAssertFalse(draft.questionIsValid(.release, overview: overview, original: original))
        try draft.setRule(XCTUnwrap(draft.rule("answer")?.replacing(release: .unreviewed)))
        XCTAssertTrue(draft.questionIsValid(.release, overview: overview, original: original))
        draft.setEnabled("answer", false, overview: overview)
        XCTAssertFalse(draft.questionIsValid(.permissions, overview: overview, original: original))
        draft.setEnabled("notes", true, overview: overview)
        XCTAssertTrue(draft.questionIsValid(.permissions, overview: overview, original: original))
    }

    func testSeparatingDirectFromReviewVisitsNewDataQuestionThenReturnsToReview() {
        var draft = AccessLevelDraft(level: nil, overview: overview)
        draft.setBoundary(.init(mode: .allowlist, sourceIds: ["scope-chat:one"]), capability: "answer", authoringEnabled: true)
        draft.setEnabled("direct", true, overview: overview)
        var navigation = AccessFlowNavigation(step: .review, started: true)
        navigation.open(.directChoice, isEditing: false, draft: draft)
        draft.setDirectSameAsAnswer(false)
        navigation.advance(draft: draft, isEditing: false)
        XCTAssertEqual(navigation.step, .directData)
        navigation.advance(draft: draft, isEditing: false)
        XCTAssertEqual(navigation.step, .review)
    }
}
