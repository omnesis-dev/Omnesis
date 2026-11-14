// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

final class AccessLevelDraftFilterTests: XCTestCase {
    private let policy = ScopePolicy(
        sourceId: "scope-chat:one",
        audience: .init(accessLevel: "level-example", capability: "answer"),
        rules: [.init(
            match: [.person(label: "Maya Reeves", identifiers: [.init(type: "email", value: "maya@example.org")])],
            action: "share"
        )],
        otherwise: "hide"
    )
    private let overview = AccessOverview(
        principals: [],
        sources: [
            AccessSourceInstance(id: "scope-chat:one", name: "First account"),
            AccessSourceInstance(id: "scope-chat:two", name: "Second account"),
        ],
        policyFamilies: []
    )
    private let everything = AccessSourceBoundary(mode: .all, sourceIds: [])

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

    private func encodedRevision(_ draft: AccessLevelDraft, capability: String) throws -> Int? {
        let data = try JSONEncoder().encode(draft.serializedRules)
        let rules = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [[String: Any]])
        return rules.first { $0["capability"] as? String == capability }?["filterRevision"] as? Int
    }

    func testCapabilityTurnedOffAndOnAgainKeepsTheRevisionItsSavedFiltersAreFencedOn() throws {
        let answer = AccessGrantRule.answer(sources: everything, release: .unreviewed, filterRevision: 4, scopePolicies: [policy])
        var draft = AccessLevelDraft(level: level([answer, .notes]), overview: overview)
        draft.setEnabled("answer", false, overview: overview)
        draft.setEnabled("answer", true, overview: overview)
        XCTAssertEqual(draft.rule("answer")?.filterRevision, 4)
        draft.setBoundary(everything, capability: "answer", authoringEnabled: true)
        draft.setPolicy(policy, sourceId: policy.sourceId, capability: "answer")
        XCTAssertEqual(try encodedRevision(draft, capability: "answer"), 4)
        XCTAssertEqual(draft.expectedFilterRevisions, ["answer": 4])

        var direct = policy
        direct.audience = .init(accessLevel: "level-example", capability: "direct")
        draft.setEnabled("direct", true, overview: overview)
        XCTAssertNil(draft.rule("direct")?.filterRevision)
        draft.setBoundary(everything, capability: "direct", authoringEnabled: true)
        draft.setPolicy(direct, sourceId: direct.sourceId, capability: "direct")
        XCTAssertEqual(try encodedRevision(draft, capability: "direct"), 0)
    }

    func testADeselectedAccountKeepsItsFilterInTheDraftButSavesWithoutItAndNeverBlocksSaving() {
        let answer = AccessGrantRule.answer(sources: everything, release: .unreviewed, filterRevision: 3, scopePolicies: [policy])
        let original = AccessLevelDraft(level: level([answer]), overview: overview)
        var deselected = original
        deselected.setBoundary(.init(mode: .denylist, sourceIds: [policy.sourceId]), capability: "answer", authoringEnabled: true)
        XCTAssertEqual(deselected.rule("answer")?.scopePolicies, [policy])
        XCTAssertEqual(deselected.serializedRules.first?.scopePolicies, [])
        XCTAssertNil(deselected.sourceProblem("answer", overview: overview, original: original))
        XCTAssertTrue(deselected.hasChanges(from: original))

        var restored = deselected
        restored.setBoundary(everything, capability: "answer", authoringEnabled: true)
        XCTAssertEqual(restored.serializedRules.first?.scopePolicies, [policy], "Selecting the account again brings its filter back")
        XCTAssertFalse(restored.hasChanges(from: original))
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
        draft.setDirectSameAsAnswer(false, authoringEnabled: true)
        XCTAssertFalse(draft.directSameAsAnswer)
        var navigation = AccessFlowNavigation(step: .review, started: true)
        navigation.open(.directData, isEditing: false, draft: draft)
        draft.setBoundary(.init(mode: .allowlist, sourceIds: ["scope-chat:two"]), capability: "direct", authoringEnabled: true)
        XCTAssertNil(draft.sourceProblem("direct", overview: overview, original: draft))
        XCTAssertEqual(draft.serializedRules.first { $0.capability == "direct" }?.scopePolicies, [])
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

    private func decision(_ mode: ScopeFilterMode, _ value: ScopePolicy) -> ScopeFilterCommit {
        ScopeFilterCommitState(
            mode: mode,
            policy: value,
            sourceId: value.sourceId,
            authoringEnabled: true
        ).decision
    }

    func testEverythingExceptNothingCommitsNoPolicy() {
        var nothingHidden = ScopeFilterMode.except.applying(to: policy)
        nothingHidden.rules[0].match = []
        XCTAssertEqual(decision(.except, nothingHidden), .apply(nil))

        var nothingShared = ScopeFilterMode.only.applying(to: policy)
        nothingShared.rules[0].match = []
        XCTAssertEqual(decision(.only, nothingShared), .blocked)
        // Counts never hold a filter back: one that names something applies before any count has arrived.
        let hiding = ScopeFilterMode.except.applying(to: policy)
        XCTAssertEqual(decision(.except, hiding), .apply(hiding))
        var tooLong = hiding
        tooLong.rules[0].match = (0 ... scopeFilterMaxEntries).map { .membership(field: "extra.chatJid", id: "chat-\($0)") }
        XCTAssertEqual(decision(.except, tooLong), .blocked)
        // The gateway counts each of a person's identifiers against the limit, and every other entry once.
        let identifiers = (0 ..< scopeFilterMaxEntries).map { ScopeIdentifier(type: "email", value: "person\($0)@example.org") }
        var people = hiding
        people.rules[0].match = [.person(label: "Maya Reeves", identifiers: identifiers)]
        XCTAssertEqual(people.entryCount, scopeFilterMaxEntries)
        XCTAssertTrue(people.withinLimits)
        people.rules[0].match.append(.membership(field: "extra.chatJid", id: "chat-one"))
        XCTAssertEqual(people.entryCount, scopeFilterMaxEntries + 1)
        XCTAssertEqual(decision(.except, people), .blocked)
    }

    func testRefusedSavesAreClassifiedForTheStateTheEditorShows() {
        XCTAssertEqual(accessLevelSaveFailure(GatewayClient.Error.notFound, isEditing: true), .missingLevel)
        XCTAssertEqual(accessLevelSaveFailure(GatewayClient.Error.notFound, isEditing: false), .other)
        let refusal = { (code: String) in GatewayClient.Error.serverError(status: 409, body: #"{"error":"\#(code)"}"#) }
        XCTAssertEqual(accessLevelSaveFailure(refusal("stale-revision"), isEditing: true), .revisionConflict)
        XCTAssertEqual(accessLevelSaveFailure(refusal("level-name-taken"), isEditing: true), .nameTaken)
        XCTAssertEqual(accessLevelSaveFailure(refusal("level-in-use"), isEditing: true), .levelInUse)
        XCTAssertEqual(accessLevelSaveFailure(refusal("invalid-selection"), isEditing: true), .other)
        let sentence = "Label filters need Gmail to be resynced. Search keeps working meanwhile."
        let withSentence = GatewayClient.Error.serverError(
            status: 409, body: #"{"error":"invalid-selection","message":"\#(sentence)"}"#
        )
        XCTAssertEqual(accessLevelSaveFailure(withSentence, isEditing: true), .refused(sentence))
        XCTAssertEqual(accessLevelSaveFailure(withSentence, isEditing: false), .refused(sentence))
        // A sentence that happens to mention a revision is not a revision conflict.
        let mentionsRevision = GatewayClient.Error.serverError(
            status: 409, body: #"{"error":"invalid-selection","message":"Resync it first; the revision is old."}"#
        )
        XCTAssertEqual(accessLevelSaveFailure(mentionsRevision, isEditing: true), .refused("Resync it first; the revision is old."))
        XCTAssertEqual(accessLevelSaveFailure(GatewayClient.Error.serverError(status: 503, body: "unavailable"), isEditing: true), .other)
    }
}
