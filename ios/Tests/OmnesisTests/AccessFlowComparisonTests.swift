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
        XCTAssertEqual(draft.rule("answer")?.boundary.mode, .denylist, "Comparison must not rewrite stored wire semantics")
        XCTAssertEqual(original.rule("answer")?.boundary.mode, .all)
    }

    func testRenamedParticipantRemainsOneMatchButDifferentIdentifiersRemainDistinct() {
        let saved = ScopeRef.person(label: "Jamie Lopez", identifiers: [.init(type: "email", value: "jamie@example.org")])
        var policy = ScopePolicy.empty(sourceId: "gmail:mail@example.org", levelId: "example", capability: "answer")
        policy.appendMatchIfMissing(saved)
        policy.appendMatchIfMissing(.person(
            label: "Jamie renamed",
            identifiers: [.init(type: "email", value: "jamie@example.org")]
        ))
        XCTAssertEqual(policy.rules[0].match, [saved])
        policy.appendMatchIfMissing(.person(
            label: "Jamie Lopez",
            identifiers: [.init(type: "email", value: "another@example.org")]
        ))
        XCTAssertEqual(policy.rules[0].match.count, 2)
        let before = policy
        policy.rules.append(.init(match: [saved], action: "hide"))
        let advanced = policy
        policy.appendMatchIfMissing(.person(
            label: "Another contact",
            identifiers: [.init(type: "email", value: "third@example.org")]
        ))
        XCTAssertEqual(policy, advanced, "Unsupported saved policies must remain untouched")
        XCTAssertNotEqual(policy, before)
    }

    func testParticipantIdentityUsesIdentifierSetsWithoutDiscardingDifferentIdentifiers() {
        let email = ScopeIdentifier(type: "email", value: "jamie@example.org")
        let domain = ScopeIdentifier(type: "domain", value: "example.org")
        let original = ScopeRef.person(label: "Jamie Lopez", identifiers: [email, domain])
        let repeated = ScopeRef.person(label: "Renamed", identifiers: [domain, email, email])
        XCTAssertTrue(scopeRefIdentityMatches(original, repeated))
        var policy = ScopePolicy.empty(sourceId: "gmail:mail@example.org", levelId: "example", capability: "answer")
        policy.appendMatchIfMissing(original)
        let before = policy
        policy.appendMatchIfMissing(repeated)
        XCTAssertEqual(policy, before)
        var equivalent = before
        equivalent.rules[0].match = [repeated]
        XCTAssertEqual(canonicalAccessPolicy(before), canonicalAccessPolicy(equivalent))
        XCTAssertFalse(scopeRefIdentityMatches(original, .person(label: "Jamie Lopez", identifiers: [email])))
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
        XCTAssertEqual(scopePreviewFailureMessage(GatewayClient.Error.invalidResponse), "Counts could not be loaded.")
        XCTAssertTrue(scopePreviewFailureMessage(GatewayClient.Error.unauthorized).contains("gateway connection changed"))
    }
}
