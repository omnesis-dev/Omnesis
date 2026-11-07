// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

final class AccessFlowComparisonTests: XCTestCase {
    func testSourceToggleRevertDoesNotLeaveAnEmptyChangedReview() {
        let source = AccessSourceInstance(id: "gmail:mail@example.org", name: "Gmail · mail@example.org")
        var overview = AccessOverview(principals: [], sources: [source], policyFamilies: [], defaultPolicyFamilyId: nil, levels: [])
        overview.sourceFilters = .init(enabled: true)
        var original = AccessLevelDraft(level: nil, overview: overview)
        original.setBoundary(.init(mode: .all, sourceIds: []), capability: "answer", authoringEnabled: true)
        var draft = original
        var selection = AccessSourceSelectionState(boundary: .init(mode: .all, sourceIds: []), knownSourceIds: [source.id])
        selection.setMode(.denylist, knownSourceIds: [source.id])
        selection.setAllowed(false, sourceId: source.id)
        draft.setBoundary(selection.boundary(knownSourceIds: [source.id]), capability: "answer", authoringEnabled: true)
        XCTAssertTrue(draft.hasChanges(from: original))
        selection.setAllowed(true, sourceId: source.id)
        draft.setBoundary(selection.boundary(knownSourceIds: [source.id]), capability: "answer", authoringEnabled: true)
        XCTAssertFalse(draft.hasChanges(from: original))
        XCTAssertTrue(draft.changedCapabilities(from: original).isEmpty)
        XCTAssertEqual(draft.rule("answer")?.boundary.mode, .denylist, "Comparison must not rewrite stored wire semantics")
        XCTAssertEqual(original.rule("answer")?.boundary.mode, .all)
    }

    func testChoosingRenamedMatchPreservesOneCanonicalSelectionButDifferentIdsRemainDistinct() {
        let saved = ScopeRef(kind: "label", id: "label-design", label: "Design")
        var policy = ScopePolicy.empty(sourceId: "gmail:mail@example.org", levelId: "example", capability: "answer")
        policy.appendMatchIfMissing(saved)
        policy.appendMatchIfMissing(.init(kind: "label", id: "label-design", label: "Design plans"))
        XCTAssertEqual(policy.rules[0].match, [saved])
        policy.appendMatchIfMissing(.init(kind: "label", id: "label-other-design", label: "Design"))
        XCTAssertEqual(policy.rules[0].match.count, 2)
        let before = policy
        policy.rules.append(.init(match: [saved], action: "hide"))
        let advanced = policy
        policy.appendMatchIfMissing(.init(kind: "label", id: "another", label: "Archive"))
        XCTAssertEqual(policy, advanced, "Unsupported saved policies must remain untouched")
        XCTAssertNotEqual(policy, before)
    }

    func testParticipantIdentityUsesIdentifierSetsWithoutDiscardingDifferentIdentifiers() {
        let email = ScopeIdentifier(type: "email", value: "jamie@example.org")
        let domain = ScopeIdentifier(type: "domain", value: "example.org")
        let original = ScopeRef(kind: "participant", label: "Jamie Lopez", identifiers: [email, domain])
        let repeated = ScopeRef(kind: "participant", label: "Renamed", identifiers: [domain, email, email])
        XCTAssertTrue(scopeRefIdentityMatches(original, repeated))
        var policy = ScopePolicy.empty(sourceId: "gmail:mail@example.org", levelId: "example", capability: "answer")
        policy.appendMatchIfMissing(original)
        let before = policy
        policy.appendMatchIfMissing(repeated)
        XCTAssertEqual(policy, before)
        var equivalent = before
        equivalent.rules[0].match = [repeated]
        XCTAssertEqual(canonicalAccessPolicy(before), canonicalAccessPolicy(equivalent))
        XCTAssertFalse(scopeRefIdentityMatches(original, .init(kind: "participant", identifiers: [email])))
    }

    func testChangingOnlyRestrictionModeStillRequiresExplicitDiscard() {
        let policy = ScopePolicy.empty(sourceId: "gmail:mail@example.org", levelId: "example", capability: "answer")
        XCTAssertFalse(scopeFilterHasChanges(initial: policy, policy: policy, mode: .except))
        XCTAssertTrue(scopeFilterHasChanges(initial: policy, policy: policy, mode: .only))
        XCTAssertFalse(scopeFilterHasChanges(initial: nil, policy: policy, mode: .all))
        XCTAssertTrue(scopeFilterHasChanges(initial: nil, policy: policy, mode: .only))
    }

    func testPreviewRecoveryDoesNotOfferIdenticalRetryForMissingAccountOrExpiredPairing() {
        XCTAssertFalse(scopePreviewCanRetry(GatewayClient.Error.unauthorized))
        XCTAssertFalse(scopePreviewCanRetry(GatewayClient.Error.notFound))
        XCTAssertTrue(scopePreviewCanRetry(GatewayClient.Error.invalidResponse))
        XCTAssertTrue(scopePreviewFailureMessage(GatewayClient.Error.invalidResponse).contains("selections are kept"))
    }

    func testPreparationPresentationIgnoresUnusedKindsButKeepsSelectedKindRemedy() {
        var policy = ScopePolicy.empty(sourceId: "gmail:mail@example.org", levelId: "example", capability: "answer")
        policy.rules[0].match = [.init(kind: "label", id: "label-design", label: "Design")]
        let unused = ScopeKindReadiness(
            kind: "participant",
            ready: false,
            reason: "metadata-refresh",
            message: "Preparing people",
            pending: 20
        )
        let selectedReady = ScopeKindReadiness(kind: "label", ready: true)
        let readiness = [unused, selectedReady]
        XCTAssertTrue(scopePreparationStatuses(policy: policy, readiness: readiness).isEmpty)
        XCTAssertTrue(policy.readyToSave(readiness), "Unused preparation must not be represented as blocking this ready decision")
        let selectedPending = ScopeKindReadiness(
            kind: "label",
            ready: false,
            reason: "metadata-refresh",
            message: "Preparing labels",
            processed: 42,
            pending: 18,
            behindCollectors: [.init(
                deviceId: "example-collector",
                name: "Example collector"
            )]
        )
        XCTAssertEqual(scopePreparationStatuses(policy: policy, readiness: [unused, selectedPending]), [selectedPending])
        XCTAssertFalse(policy.readyToSave([unused, selectedPending]))
        XCTAssertEqual(readiness, [unused, selectedReady], "Presentation must not alter readiness facts")
    }

    func testAdvancedPreparationPresentationUsesAllRulesAndFirstReferenceOrderWithoutDuplicates() {
        var policy = ScopePolicy.empty(sourceId: "gmail:mail@example.org", levelId: "example", capability: "answer")
        let label = ScopeRef(kind: "label", id: "label-design", label: "Design")
        policy.rules = [
            .init(match: [label], action: "hide"),
            .init(
                match: [
                    .init(kind: "participant", identifiers: [.init(type: "email", value: "jamie@example.org")]),
                    label,
                ],
                action: "share"
            ),
        ]
        let participant = ScopeKindReadiness(kind: "participant", ready: false, message: "Preparing people")
        let labels = ScopeKindReadiness(kind: "label", ready: false, message: "Preparing labels")
        XCTAssertEqual(scopePreparationStatuses(policy: policy, readiness: [participant, labels]), [labels, participant])
        XCTAssertFalse(policy.editable, "The display projection must also work for retained advanced rules")
    }
}
