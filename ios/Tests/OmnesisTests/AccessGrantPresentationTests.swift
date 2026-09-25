// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

/// How a grant decision is *presented*: which capability occupies which slot
/// and in what tone, which capabilities a source list speaks for when it
/// refuses, and what the owner's choice about future sources leaves alone.
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
        state.blockAll(known)
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

    func testAGrantedCapabilityIsNeverDrawnAsWithheld() {
        for capability in AccessCapability.allCases {
            XCTAssertNotEqual(
                accessCapabilityTone(capability, held: true),
                .withheld,
                "\(capability.label) granted must not read as withheld"
            )
            XCTAssertEqual(accessCapabilityTone(capability, held: false), .withheld)
        }
    }

    func testDangerBelongsToDirectAndUnreviewedReleaseIsTheWarningTone() {
        XCTAssertEqual(accessCapabilityTone(.direct, held: true), .raw)
        XCTAssertEqual(accessCapabilityTone(.answer, held: true), .granted)
        XCTAssertEqual(
            accessCapabilityTone(.answer, held: true, unreviewed: true),
            .unreviewed
        )
        XCTAssertEqual(accessCapabilityTone(.notes, held: true), .notes)
        // Unreviewed release must not borrow Direct's tone: two dangers on one
        // row means neither is read as one.
        XCTAssertNotEqual(
            accessCapabilityTone(.answer, held: true, unreviewed: true),
            accessCapabilityTone(.direct, held: true)
        )
        // A withheld capability cannot be warned about.
        XCTAssertEqual(
            accessCapabilityTone(.answer, held: false, unreviewed: true),
            .withheld
        )
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
            AccessCapabilityHoldings(
                answer: true,
                direct: true,
                notes: true,
                answerUnreviewed: true
            )
        )
        XCTAssertTrue(holdings.holdsAnything)
        XCTAssertEqual(holdings.tone(.answer), .unreviewed)
        XCTAssertEqual(holdings.tone(.direct), .raw)
        XCTAssertEqual(holdings.tone(.notes), .notes)

        let reviewed = accessCapabilityHoldings(rules: [
            .answer(
                sources: AccessSourceBoundary(mode: .all, sourceIds: []),
                release: .reviewed(policyFamilyId: "policy-example")
            ),
        ])
        XCTAssertEqual(reviewed.tone(.answer), .granted)
        XCTAssertEqual(reviewed.tone(.direct), .withheld)
        XCTAssertFalse(accessCapabilityHoldings(rules: []).holdsAnything)
    }

    func testASharedSourceListRefusesInTheNameOfBothCapabilities() {
        XCTAssertEqual(
            accessSourceBoundaryError(
                scope: .shared,
                permitsAnyKnownSource: false,
                recordedSelectionCount: 0
            ),
            "Select at least one source for Answer and Direct."
        )
        XCTAssertEqual(
            accessSourceBoundaryError(
                scope: .answer,
                permitsAnyKnownSource: false,
                recordedSelectionCount: 0
            ),
            "Select at least one source for Answer."
        )
        XCTAssertEqual(
            accessSourceBoundaryError(
                scope: .direct,
                permitsAnyKnownSource: false,
                recordedSelectionCount: 0
            ),
            "Select at least one source for Direct."
        )
    }

    func testAnOversizedSourceListIsNamedBeforeAnEmptyOne() {
        XCTAssertEqual(
            accessSourceBoundaryError(
                scope: .shared,
                permitsAnyKnownSource: false,
                recordedSelectionCount: accessMaxSourceSelections + 1
            ),
            "Answer and Direct can record at most 256 source selections."
        )
        XCTAssertNil(
            accessSourceBoundaryError(
                scope: .answer,
                permitsAnyKnownSource: true,
                recordedSelectionCount: accessMaxSourceSelections
            )
        )
    }

    func testEachScopeTitlesItsOwnList() {
        XCTAssertEqual(AccessSourceScope.answer.editorTitle, "Answer sources")
        XCTAssertEqual(AccessSourceScope.direct.editorTitle, "Direct sources")
        XCTAssertEqual(
            AccessSourceScope.shared.editorTitle,
            "Sources for Answer and Direct"
        )
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

    // MARK: - The form
}
