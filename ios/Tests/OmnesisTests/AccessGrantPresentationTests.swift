// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

/// How a grant decision is *presented*: which capability occupies which slot,
/// what a source list says when it refuses, and what the owner's choice about
/// future sources leaves alone.
final class AccessGrantPresentationTests: XCTestCase {
    private let known: Set<String> = [
        "github:maya-reeves",
        "gmail:maya.reeves@example.com",
        "claude-transcripts:workstation",
    ]

    func testBlockingEverySourceUnderAllStillRecordsEveryBlock() {
        var state = AccessSourceSelectionState(
            boundary: AccessSourceBoundary(mode: .all, sourceIds: []),
            knownSourceIds: known
        )
        for sourceId in known {
            state.setAllowed(false, sourceId: sourceId)
        }
        XCTAssertEqual(
            state.boundary(knownSourceIds: known),
            AccessSourceBoundary(mode: .denylist, sourceIds: known.sorted())
        )
        XCTAssertFalse(state.permitsAnyKnownSource(known))
    }

    func testFutureSourceChoiceLeavesEveryConnectedDecisionAlone() {
        var state = AccessSourceSelectionState(
            boundary: AccessSourceBoundary(mode: .allowlist, sourceIds: ["github:maya-reeves"]),
            knownSourceIds: known
        )
        XCTAssertFalse(state.allowsFutureSources)

        state.setFutureSourcesAllowed(true, knownSourceIds: known)
        XCTAssertTrue(state.allowsFutureSources)
        XCTAssertEqual(state.allowedSourceIds, ["github:maya-reeves"])
        // A partial selection cannot be "all sources", so it becomes the
        // denylist that admits the future while keeping the exceptions.
        XCTAssertEqual(
            state.boundary(knownSourceIds: known),
            AccessSourceBoundary(
                mode: .denylist,
                sourceIds: known.subtracting(["github:maya-reeves"]).sorted()
            )
        )

        state.setFutureSourcesAllowed(false, knownSourceIds: known)
        XCTAssertFalse(state.allowsFutureSources)
        XCTAssertEqual(
            state.boundary(knownSourceIds: known),
            AccessSourceBoundary(mode: .allowlist, sourceIds: ["github:maya-reeves"])
        )
    }

    func testAdmittingTheFutureWithEverySourceAllowedIsAllSources() {
        var state = AccessSourceSelectionState(
            boundary: AccessSourceBoundary(mode: .allowlist, sourceIds: known.sorted()),
            knownSourceIds: known
        )
        state.setFutureSourcesAllowed(true, knownSourceIds: known)
        XCTAssertEqual(
            state.boundary(knownSourceIds: known),
            AccessSourceBoundary(mode: .all, sourceIds: [])
        )
    }

    func testCapabilitySlotsKeepAFixedOrder() {
        XCTAssertEqual(AccessCapability.allCases, [.answer, .direct, .notes])
        XCTAssertEqual(AccessCapability.allCases.map(\.label), ["Answer", "Direct", "Notes"])
    }

    func testPillRowReadsAsOneSentence() {
        XCTAssertEqual(
            AccessCapabilityHoldings(answer: true, direct: true).spokenSummary,
            "Answer and Direct allowed, Notes not allowed"
        )
        XCTAssertEqual(AccessCapabilityHoldings(notes: true).spokenSummary, "Notes allowed, Answer and Direct not allowed")
        XCTAssertEqual(
            AccessCapabilityHoldings(answer: true, direct: true, notes: true).spokenSummary,
            "Answer, Direct and Notes allowed"
        )
        XCTAssertEqual(AccessCapabilityHoldings().spokenSummary, "Answer, Direct and Notes not allowed")
    }

    func testHoldingsReadEveryCapabilityOffTheRulesBeingApproved() {
        let holdings = accessCapabilityHoldings(rules: [
            .notes,
            .direct(sources: AccessSourceBoundary(mode: .all, sourceIds: [])),
            .answer(
                sources: AccessSourceBoundary(mode: .all, sourceIds: []),
                release: .unreviewed
            ),
        ])
        XCTAssertEqual(
            holdings,
            AccessCapabilityHoldings(answer: true, direct: true, notes: true)
        )
        XCTAssertTrue(holdings.holdsAnything)

        let reviewed = accessCapabilityHoldings(rules: [
            .answer(
                sources: AccessSourceBoundary(mode: .all, sourceIds: []),
                release: .reviewed(policyFamilyId: "policy-example")
            ),
        ])
        XCTAssertEqual(reviewed, AccessCapabilityHoldings(answer: true))
        XCTAssertFalse(accessCapabilityHoldings(rules: []).holdsAnything)
    }

    /// A new level over the known sources whose Answer and Direct each keep their own list.
    private func draft(answer: [String], direct: [String]) -> (draft: AccessLevelDraft, overview: AccessOverview) {
        let overview = AccessOverview(
            principals: [],
            sources: known.sorted().map { AccessSourceInstance(id: $0, name: $0) },
            policyFamilies: [AccessPolicyFamilySummary(id: "policy-example", name: "Standard", revision: "1")],
            defaultPolicyFamilyId: "policy-example"
        )
        var draft = AccessLevelDraft(level: nil, overview: overview)
        draft.setEnabled("direct", true, overview: overview)
        draft.setDirectSameAsAnswer(false)
        draft.setBoundary(.init(mode: .allowlist, sourceIds: answer), capability: "answer", authoringEnabled: true)
        draft.setBoundary(.init(mode: .allowlist, sourceIds: direct), capability: "direct", authoringEnabled: true)
        return (draft, overview)
    }

    func testAnEmptySourceListRefusesInTheNameOfItsCapability() {
        let empty = draft(answer: [], direct: [])
        XCTAssertEqual(
            empty.draft.sourceProblem("answer", overview: empty.overview, original: empty.draft),
            "Select at least one source for Answer."
        )
        XCTAssertEqual(
            empty.draft.sourceProblem("direct", overview: empty.overview, original: empty.draft),
            "Select at least one source for Direct."
        )
        let chosen = draft(answer: ["github:maya-reeves"], direct: [])
        XCTAssertNil(chosen.draft.sourceProblem("answer", overview: chosen.overview, original: chosen.draft))
        XCTAssertNil(chosen.draft.sourceProblem("notes", overview: chosen.overview, original: chosen.draft))
    }

    func testASourceListHoldsAtMostWhatARuleCanRecord() {
        let tooMany = (0 ... accessMaxSourceSelections).map { "github:workspace-\($0)" }
        let atTheLimit = Array(tooMany.dropLast(2)) + ["github:maya-reeves"]
        XCTAssertEqual(atTheLimit.count, accessMaxSourceSelections)
        let lists = draft(answer: tooMany, direct: atTheLimit)
        XCTAssertEqual(
            lists.draft.sourceProblem("answer", overview: lists.overview, original: lists.draft),
            "Answer can record at most 256 source selections."
        )
        XCTAssertNil(lists.draft.sourceProblem("direct", overview: lists.overview, original: lists.draft))
    }

    // MARK: - Unmapped failures

    /// One sentence for every unnamed failure meant an offline phone, a
    /// version mismatch and a server fault looked identical — to the owner and
    /// to whoever they reported it to.
    func testOfflineIsNamedRatherThanCollapsedIntoTryAgain() {
        let message = accessAuthorizationLookupMessage(URLError(.notConnectedToInternet))
        XCTAssertTrue(message.contains("offline"), message)
        XCTAssertFalse(message.contains("could not be loaded or updated"), message)
    }

    func testUnreachableGatewaySaysSoAndSuggestsTheNetwork() {
        let message = accessAuthorizationLookupMessage(URLError(.cannotConnectToHost))
        XCTAssertTrue(message.contains("Could not reach"), message)
        XCTAssertTrue(message.contains("network"), message)
    }

    func testUntrustedCertificatePointsAtRepairing() {
        let message = accessAuthorizationLookupMessage(URLError(.serverCertificateUntrusted))
        XCTAssertTrue(message.contains("not trusted"), message)
        XCTAssertTrue(message.contains("Re-pair"), message)
    }

    func testDecodeFailureNamesAVersionMismatch() {
        let message = accessAuthorizationLookupMessage(GatewayClient.Error.decoding("keyNotFound"))
        XCTAssertTrue(message.contains("cannot read"), message)
        XCTAssertTrue(message.contains("Update"), message)
    }

    /// A status in the text is what makes the next report diagnosable from a
    /// screenshot alone.
    func testServerFaultCarriesItsStatus() {
        let message = accessAuthorizationLookupMessage(
            GatewayClient.Error.serverError(status: 502, body: "")
        )
        XCTAssertTrue(message.contains("502"), message)
    }

    /// The named cases must keep their own wording.
    func testNamedCasesAreUnchanged() {
        XCTAssertTrue(
            accessAuthorizationLookupMessage(GatewayClient.Error.notFound)
                .contains("No pending authorization")
        )
        XCTAssertTrue(
            accessAuthorizationLookupMessage(GatewayClient.Error.unauthorized)
                .contains("no longer authorized")
        )
    }

    // MARK: - Step titles

    /// The chip titles are a cross-platform contract: the portal and Android
    /// render the same steps from their own copies of these strings, so a
    /// change here that is not mirrored there is a divergence, not a tweak.
    func testStepTitles() {
        XCTAssertEqual(
            AccessAuthorizationStep.allCases.map(\.title),
            ["Connection", "Permissions", "Data & privacy", "Review"]
        )
    }

    /// Only the one title too wide for the chips on a phone is shortened, and
    /// the full title stays available as the accessible name.
    func testOnlyTheWidestStepIsAbbreviated() {
        XCTAssertEqual(
            AccessAuthorizationStep.allCases.map(\.shortTitle),
            ["Connection", "Permissions", "Data", "Review"]
        )
        for step in AccessAuthorizationStep.allCases where step != .data {
            XCTAssertEqual(step.shortTitle, step.title, "\(step) should not be abbreviated")
        }
    }
}
