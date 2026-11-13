// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

/// Reversible decisions in the access-level editor: a permission switched off
/// and on, Direct linked to Answer and separated again, one cancelled
/// question, and bulk choices over a searched account list.
final class AccessLevelEditingTests: XCTestCase {
    private let maya = ScopeRef(kind: "participant", label: "Maya Reeves", identifiers: [.init(type: "email", value: "maya@example.org")])
    private let jamie = ScopeRef(kind: "participant", label: "Jamie Lopez", identifiers: [.init(type: "email", value: "jamie@example.org")])
    private let david = ScopeRef(kind: "participant", label: "David Lin", identifiers: [.init(type: "email", value: "david@example.org")])
    private let sources = (1 ... 6).map { AccessSourceInstance(id: "scope-chat:account-\($0)", name: "Account \($0)") }
    private var overview: AccessOverview {
        AccessOverview(
            principals: [],
            sources: sources,
            policyFamilies: [],
            levels: [level([.notes], id: "level-other", name: "Notes only")]
        )
    }

    private func policy(_ refs: [ScopeRef], sourceId: String = "scope-chat:account-1", action: String = "share") -> ScopePolicy {
        ScopePolicy(
            sourceId: sourceId,
            audience: .init(accessLevel: "level-example", capability: "answer"),
            rules: [.init(match: refs, action: action)],
            otherwise: action == "share" ? "hide" : "share"
        )
    }

    private func level(_ rules: [AccessGrantRule], id: String = "level-example", name: String = "Research assistant")
        -> AccessLevelSummary {
        AccessLevelSummary(id: id, name: name, revision: 7, rules: rules, connectionCount: 0, createdAt: 1, updatedAt: 2)
    }

    private func allowlist(_ numbers: [Int]) -> AccessSourceBoundary {
        .init(mode: .allowlist, sourceIds: numbers.map { "scope-chat:account-\($0)" })
    }

    func testPermissionSwitchedOffAndOnAgainReturnsWithItsBoundaryAndFilters() {
        let answer = AccessGrantRule.answer(
            sources: allowlist([1, 2]),
            release: .unreviewed,
            filterRevision: 4,
            scopePolicies: [policy([maya])]
        )
        var draft = AccessLevelDraft(level: level([answer, .notes]), overview: overview)
        let original = draft
        draft.setEnabled("answer", false, overview: overview)
        XCTAssertNil(draft.rule("answer"))
        draft.setEnabled("answer", true, overview: overview)
        XCTAssertEqual(draft.rule("answer"), answer)
        XCTAssertFalse(draft.hasChanges(from: original))

        draft.setEnabled("direct", true, overview: overview)
        draft.setBoundary(allowlist([3]), capability: "direct", authoringEnabled: true)
        draft.setEnabled("direct", false, overview: overview)
        draft.setEnabled("direct", true, overview: overview)
        XCTAssertEqual(draft.rule("direct")?.boundary, allowlist([3]))
    }

    func testDirectSwitchedOnBesideAnswerStartsLinkedAndOpensDirectDataNext() {
        let answer = AccessGrantRule.answer(sources: allowlist([1, 2]), release: .unreviewed, scopePolicies: [policy([maya])])
        var filtering = overview
        filtering.sourceFilters = .init(enabled: true)
        var draft = AccessLevelDraft(level: level([answer]), overview: filtering)
        var navigation = AccessFlowNavigation()
        navigation.open(.permissions, isEditing: true, draft: draft)
        draft.setEnabled("direct", true, overview: filtering)
        XCTAssertTrue(draft.directSameAsAnswer)
        let direct = draft.serializedRules.first { $0.capability == "direct" }
        XCTAssertEqual(direct?.boundary, allowlist([1, 2]), "Direct reads what Answer reads, never more")
        XCTAssertEqual(direct?.scopePolicies.map(\.rules), [policy([maya]).rules])
        navigation.advance(draft: draft, isEditing: true)
        XCTAssertEqual(navigation.step, .directData)
    }

    func testDirectSwitchedOnWithoutAnswerStartsWithNoAccountsOfItsOwn() {
        var draft = AccessLevelDraft(level: level([.notes]), overview: overview)
        draft.setEnabled("direct", true, overview: overview)
        XCTAssertFalse(draft.directSameAsAnswer)
        XCTAssertEqual(draft.serializedRules.first { $0.capability == "direct" }?.boundary, allowlist([]))
    }

    func testDirectSwitchedOnBesideAFilteredAnswerWithoutFilterEditingStartsWithNoAccountsOfItsOwn() {
        let answer = AccessGrantRule.answer(sources: allowlist([1, 2]), release: .unreviewed, scopePolicies: [policy([maya])])
        var draft = AccessLevelDraft(level: level([answer]), overview: overview)
        draft.setEnabled("direct", true, overview: overview)
        XCTAssertFalse(draft.directSameAsAnswer)
        XCTAssertEqual(draft.serializedRules.first { $0.capability == "direct" }?.boundary, allowlist([]))
        XCTAssertEqual(draft.serializedRules.first { $0.capability == "direct" }?.scopePolicies, [])
    }

    func testChoosingSeparateDataAgainRestoresTheDirectSelectionThatAnswersCopyReplaced() {
        var draft = AccessLevelDraft(level: nil, overview: overview)
        draft.setBoundary(allowlist([1, 2]), capability: "answer", authoringEnabled: true)
        draft.setEnabled("direct", true, overview: overview)
        draft.setDirectSameAsAnswer(false)
        XCTAssertEqual(draft.rule("direct")?.boundary, allowlist([1, 2]), "A first separation starts from Answer's selection")
        draft.setBoundary(allowlist([5]), capability: "direct", authoringEnabled: true)

        draft.setDirectSameAsAnswer(true)
        XCTAssertEqual(draft.serializedRules.first { $0.capability == "direct" }?.boundary, allowlist([1, 2]))
        draft.setDirectSameAsAnswer(false)
        XCTAssertEqual(draft.rule("direct")?.boundary, allowlist([5]))
        XCTAssertEqual(draft.serializedRules.first { $0.capability == "direct" }?.boundary, allowlist([5]))
    }

    func testEditedDirectDataSwitchesBetweenAnswersListAndItsOwnUntilCancelled() {
        let answer = AccessGrantRule.answer(sources: allowlist([1, 2, 3]), release: .unreviewed)
        let direct = AccessGrantRule.direct(sources: allowlist([1]))
        var draft = AccessLevelDraft(level: level([answer, direct]), overview: overview)
        XCTAssertFalse(draft.directSameAsAnswer, "A saved level opens with Direct's own list")
        var navigation = AccessFlowNavigation()
        navigation.open(.directData, isEditing: true, draft: draft)

        draft.setDirectSameAsAnswer(true)
        XCTAssertEqual(draft.serializedRules.first { $0.capability == "direct" }?.boundary, allowlist([1, 2, 3]))
        draft.setBoundary(allowlist([1, 2]), capability: "answer", authoringEnabled: true)
        XCTAssertEqual(
            draft.serializedRules.first { $0.capability == "direct" }?.boundary,
            allowlist([1, 2]),
            "A linked Direct follows later Answer edits"
        )
        draft.setDirectSameAsAnswer(false)
        XCTAssertEqual(draft.rule("direct")?.boundary, allowlist([1]), "Its own list comes back as it was")

        draft.setDirectSameAsAnswer(true)
        let restored = navigation.cancelDecision()
        XCTAssertEqual(restored?.directSameAsAnswer, false)
        XCTAssertEqual(restored?.serializedRules.first { $0.capability == "direct" }, direct)
    }

    func testASavedLevelWhoseDirectMirrorsAnswerOpensLinked() {
        let filter = policy([maya])
        var directFilter = filter
        directFilter.audience = .init(accessLevel: "level-example", capability: "direct")
        let answer = AccessGrantRule.answer(sources: allowlist([1, 2]), release: .unreviewed, scopePolicies: [filter])
        let mirrored = AccessLevelDraft(
            level: level([answer, .direct(sources: allowlist([2, 1]), scopePolicies: [directFilter])]),
            overview: overview
        )
        XCTAssertTrue(mirrored.directSameAsAnswer)
        let unfiltered = AccessGrantRule.direct(sources: allowlist([1, 2]))
        XCTAssertFalse(AccessLevelDraft(level: level([answer, unfiltered]), overview: overview).directSameAsAnswer)
        let everything = AccessGrantRule.direct(sources: .init(mode: .all, sourceIds: []), scopePolicies: [directFilter])
        XCTAssertFalse(AccessLevelDraft(level: level([answer, everything]), overview: overview).directSameAsAnswer)
    }

    func testAddingDirectToALevelBeingEditedAsksItsSourcesOnTheDirectDataScreen() {
        let answer = AccessGrantRule.answer(sources: allowlist([1]), release: .unreviewed)
        var draft = AccessLevelDraft(level: level([answer]), overview: overview)
        XCTAssertTrue(draft.directSameAsAnswer, "Nothing to keep apart: Direct starts linked once added")
        var navigation = AccessFlowNavigation()
        navigation.open(.permissions, isEditing: true, draft: draft)
        draft.setEnabled("direct", true, overview: overview)
        navigation.advance(draft: draft, isEditing: true)
        XCTAssertEqual(navigation.step, .directData)
        XCTAssertEqual(draft.serializedRules.first { $0.capability == "direct" }?.boundary, allowlist([1]))
    }

    func testAddingAnswerBesideDirectKeepsDirectsOwnAccounts() {
        var draft = AccessLevelDraft(level: level([.direct(sources: allowlist([3]))]), overview: overview)
        draft.setEnabled("answer", true, overview: overview)
        XCTAssertFalse(draft.directSameAsAnswer)
        XCTAssertEqual(draft.serializedRules.first { $0.capability == "direct" }?.boundary, allowlist([3]))
    }

    func testCancellingOneQuestionRestoresTheDraftAsItStoodAndKeepsEarlierChanges() {
        let answer = AccessGrantRule.answer(sources: allowlist([1]), release: .unreviewed)
        var draft = AccessLevelDraft(level: level([answer]), overview: overview)
        var navigation = AccessFlowNavigation()
        navigation.open(.name, isEditing: true, draft: draft)
        draft.name = "Field research"
        navigation.advance(draft: draft, isEditing: true)
        XCTAssertEqual(navigation.current(isEditing: true), .overview)

        navigation.open(.permissions, isEditing: true, draft: draft)
        draft.setEnabled("direct", true, overview: overview)
        navigation.advance(draft: draft, isEditing: true)
        XCTAssertEqual(navigation.step, .directData)
        draft.setBoundary(allowlist([2]), capability: "direct", authoringEnabled: true)

        let restored = navigation.cancelDecision()
        XCTAssertEqual(navigation.current(isEditing: true), .overview)
        XCTAssertEqual(restored?.name, "Field research")
        XCTAssertNil(restored?.rule("direct"))
        XCTAssertEqual(restored?.rule("answer"), answer)
        XCTAssertNil(navigation.cancelDecision(), "Nothing is restored once no question is open")
    }

    func testCancellingAQuestionOpenedFromReviewReturnsToReview() {
        var draft = AccessLevelDraft(level: nil, overview: overview)
        draft.setBoundary(allowlist([1]), capability: "answer", authoringEnabled: true)
        var navigation = AccessFlowNavigation(step: .review, started: true)
        let entered = draft
        navigation.open(.answerData, isEditing: false, draft: draft)
        draft.setBoundary(allowlist([2]), capability: "answer", authoringEnabled: true)
        XCTAssertEqual(navigation.cancelDecision(), entered)
        XCTAssertEqual(navigation.step, .review)
        XCTAssertFalse(navigation.returnToReview)
    }

    func testANameAloneIsAChangeThatCanBeReviewedAndMustBeUsable() {
        var draft = AccessLevelDraft(level: level([.notes]), overview: overview)
        let original = draft
        XCTAssertFalse(draft.hasChanges(from: original))
        draft.name = "Field research"
        XCTAssertTrue(draft.hasChanges(from: original))
        let problem = { (name: String) in accessLevelNameProblem(name, id: draft.id, levels: self.overview.levels) }
        XCTAssertNil(problem(draft.name))
        XCTAssertEqual(problem("  "), "Enter a name for this access level.")
        XCTAssertEqual(problem("notes only"), "An access level already uses this name. Choose another.")
        XCTAssertEqual(problem(String(repeating: "n", count: 121)), "Use at most 120 characters.")
        XCTAssertNil(problem(String(repeating: "n", count: 120)))
        XCTAssertNotNil(problem(String(repeating: "n", count: 119) + "🎉"), "The gateway measures a name in UTF-16 units")
        XCTAssertFalse(draft.creationSteps.contains(.name))
    }

    func testSelectAllAndClearReachOnlySearchedAccountsAndNeverTurnOnAnUnavailableOne() throws {
        let answer = AccessGrantRule.answer(sources: allowlist([1, 6]), release: .unreviewed)
        let draft = AccessLevelDraft(level: level([answer]), overview: overview)
        let decisions = AccessDraftDecisions(draft: draft, overview: overview, original: draft)
        let known = overview.availableSourceIds
        XCTAssertEqual(accessSourcesMatching(sources, query: "  ").count, 6)
        let visible = accessSourcesMatching(sources, query: "ACCOUNT-2") + accessSourcesMatching(sources, query: "Account 3")
        XCTAssertEqual(visible.map(\.id), ["scope-chat:account-2", "scope-chat:account-3"])
        let retired = AccessSourceInstance(id: "scope-chat:retired", name: "Unavailable saved account", available: false)

        let selected = try XCTUnwrap(decisions.selection(settingAllowed: true, for: visible + [retired], capability: "answer"))
        XCTAssertEqual(selected.boundary(knownSourceIds: known), allowlist([1, 2, 3, 6]))
        let cleared = try XCTUnwrap(decisions.selection(settingAllowed: false, for: [sources[0]], capability: "answer"))
        XCTAssertEqual(cleared.boundary(knownSourceIds: known), allowlist([6]))
        XCTAssertNil(decisions.selection(settingAllowed: true, for: visible, capability: "direct"))
    }

    func testARetainedUnavailableAccountCanBeTurnedOffAndTheLevelStillValidates() {
        let saved = AccessSourceBoundary(mode: .allowlist, sourceIds: ["scope-chat:account-1", "scope-chat:retired"])
        var draft = AccessLevelDraft(level: level([.answer(sources: saved, release: .unreviewed)]), overview: overview)
        let original = draft
        let retired = AccessSourceInstance(id: "scope-chat:retired", name: "Unavailable saved account", available: false)
        let known = overview.availableSourceIds
        let next = AccessDraftDecisions(draft: draft, overview: overview, original: original)
            .selection(settingAllowed: false, for: [retired], capability: "answer")
        XCTAssertEqual(next?.boundary(knownSourceIds: known), allowlist([1]))
        draft.setBoundary(allowlist([1]), capability: "answer", authoringEnabled: true)
        XCTAssertNil(draft.sourceProblem("answer", overview: overview, original: original))
        XCTAssertTrue(draft.hasChanges(from: original))
    }

    func testAChangedFilterListsWhatItAddsAndRemovesBeforeWhatItKeeps() {
        let renamed = ScopeRef(kind: "participant", label: "Maya R.", identifiers: maya.identifiers)
        let deltas = scopeRefDeltas(before: policy([maya, jamie]), after: policy([renamed, david]))
        XCTAssertEqual(deltas, [
            .init(ref: david, change: .added), .init(ref: jamie, change: .removed), .init(ref: renamed, change: .kept),
        ])
    }

    func testTickingAnItemAgainDeselectsItAndOnlyMatchingNothingIsRefused() {
        var value = policy([maya])
        value.toggleMatch(jamie)
        XCTAssertEqual(value.rules[0].match, [maya, jamie])
        value.toggleMatch(.init(kind: "participant", label: "Renamed", identifiers: maya.identifiers))
        XCTAssertEqual(value.rules[0].match, [jamie])
        value.toggleMatch(jamie)

        let preview = ScopePreview(
            sourceId: value.sourceId,
            total: 3,
            visible: 0,
            hidden: 3,
            unknown: 0,
            items: [],
            samples: [],
            readiness: [.init(kind: "participant", ready: true)]
        )
        let state = { (mode: ScopeFilterMode, policy: ScopePolicy) in
            ScopeFilterCommitState(
                mode: mode,
                policy: policy,
                sourceId: policy.sourceId,
                authoringEnabled: true,
                preview: preview,
                previewedPolicy: policy,
                loading: false,
                hasError: false
            ).decision
        }
        XCTAssertEqual(state(.only, value), .blocked)
        XCTAssertEqual(state(.except, ScopeFilterMode.except.applying(to: value)), .apply(nil))
        value.toggleMatch(maya)
        XCTAssertEqual(state(.only, value), .apply(value))
    }
}
