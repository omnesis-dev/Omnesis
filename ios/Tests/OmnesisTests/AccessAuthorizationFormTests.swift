// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

/// How the access form opens and closes: what a fresh connection starts
/// from, what a prefill from an existing connection's rules becomes on the
/// screen, and what the approval sends back.
final class AccessAuthorizationFormTests: XCTestCase {
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

    /// A fresh connection starts with Answer on, released through the default
    /// policy, and nothing else: the owner has to allow sources before it
    /// describes a grant.
    func testAFreshConnectionStartsFromAnswerWithTheDefaultPolicy() {
        var form = AccessAuthorizationFormState(sourceIds: known)
        form.populate(request: request, overview: overview)
        XCTAssertEqual(form.holdings(request: request), AccessCapabilityHoldings(answer: true))
        XCTAssertEqual(form.answerRelease, .reviewed)
        XCTAssertEqual(form.policyFamilyId, "policy-work-safe")
        XCTAssertNil(form.selection(request: request, overview: overview))

        form.answerSources.allowAll(known)
        XCTAssertEqual(
            form.selection(request: request, overview: overview),
            .connect(
                rules: [.answer(
                    sources: AccessSourceBoundary(mode: .allowlist, sourceIds: known.sorted()),
                    release: .reviewed(policyFamilyId: "policy-work-safe")
                )],
                credentialLabel: "Northstar Assistant"
            )
        )
    }

    /// The wizard opens knowing the available sources only, so allowing
    /// every source records the set every platform would record for the same
    /// overview — the unavailable one is neither offered nor written.
    func testTheWizardOpensOnAvailableSourcesOnly() {
        var form = AccessAuthorizationFormState.opening(request: request, overview: overview, prefill: nil)
        XCTAssertEqual(form.answerSources.allowedSourceIds, [])
        form.answerSources.setMode(.all, knownSourceIds: overview.availableSourceIds)
        XCTAssertEqual(form.answerSources.allowedSourceIds, known)
        XCTAssertFalse(form.answerSources.allowedSourceIds.contains(unavailable))
        form.answerSources.setMode(.allowlist, knownSourceIds: overview.availableSourceIds)
        XCTAssertEqual(
            form.selection(request: request, overview: overview),
            .connect(
                rules: [.answer(
                    sources: AccessSourceBoundary(mode: .allowlist, sourceIds: known.sorted()),
                    release: .reviewed(policyFamilyId: "policy-work-safe")
                )],
                credentialLabel: "Northstar Assistant"
            )
        )
    }

    /// A grant that names the listed-but-unavailable source keeps naming it,
    /// the same way it keeps a source the overview no longer lists at all.
    func testAListedUnavailableSourceIsARetainedReference() {
        let allowlist = AccessSourceBoundary(mode: .allowlist, sourceIds: ["github:maya-reeves", unavailable])
        let denylist = AccessSourceBoundary(mode: .denylist, sourceIds: [unavailable])
        var form = AccessAuthorizationFormState.opening(
            request: request,
            overview: overview,
            prefill: [
                .direct(sources: allowlist),
                .answer(sources: denylist, release: .unreviewed),
            ]
        )
        XCTAssertEqual(form.answerSources.allowedSourceIds, known)
        XCTAssertEqual(
            form.selection(request: request, overview: overview),
            .connect(
                rules: [.direct(sources: allowlist), .answer(sources: denylist, release: .unreviewed)],
                credentialLabel: "Northstar Assistant"
            )
        )
        // Allowing every available source under the denylist leaves the
        // retained exception in place: nothing offered can clear it.
        form.answerSources.allowAll(overview.availableSourceIds)
        XCTAssertEqual(
            form.answerSources.boundary(knownSourceIds: overview.availableSourceIds),
            denylist
        )
    }

    /// A prefill opens on the access an existing connection holds, and
    /// approving without a change sends those same rules back.
    func testAPrefillOpensOnTheExistingRules() {
        let rules: [AccessGrantRule] = [
            .notes,
            .direct(sources: AccessSourceBoundary(mode: .allowlist, sourceIds: ["github:maya-reeves"])),
            .answer(
                sources: AccessSourceBoundary(mode: .denylist, sourceIds: ["claude-transcripts:workstation"]),
                release: .reviewed(policyFamilyId: "policy-strict")
            ),
        ]
        var form = AccessAuthorizationFormState(sourceIds: known)
        form.populate(request: request, overview: overview, prefill: rules)
        XCTAssertEqual(
            form.holdings(request: request),
            AccessCapabilityHoldings(answer: true, direct: true, notes: true)
        )
        XCTAssertEqual(form.policyFamilyId, "policy-strict")
        // Direct's own narrower list is kept as a second list.
        XCTAssertFalse(form.linkSources)
        XCTAssertEqual(form.sourceScopes(request: request), [.answer, .direct])
        XCTAssertEqual(
            form.selection(request: request, overview: overview),
            .connect(rules: rules, credentialLabel: "Northstar Assistant")
        )
    }

    /// Two reading rules on one boundary reopen as the single shared list
    /// they were written from.
    func testMatchingReadingRulesReopenAsOneSharedList() {
        let boundary = AccessSourceBoundary(mode: .all, sourceIds: [])
        var form = AccessAuthorizationFormState(sourceIds: known)
        form.populate(
            request: request,
            overview: overview,
            prefill: [
                .direct(sources: boundary),
                .answer(sources: boundary, release: .unreviewed),
            ]
        )
        XCTAssertTrue(form.linkSources)
        XCTAssertEqual(form.sourceScopes(request: request), [.shared])
        XCTAssertEqual(form.answerRelease, .unreviewed)
        XCTAssertEqual(form.holdings(request: request).tone(.answer), .unreviewed)
    }

    /// A grant without Answer reopens without it: the prefill replaces the
    /// fresh-connection default rather than adding to it.
    func testANotesOnlyGrantReopensWithoutAnswer() {
        var form = AccessAuthorizationFormState(sourceIds: known)
        form.populate(request: request, overview: overview, prefill: [.notes])
        XCTAssertEqual(form.holdings(request: request), AccessCapabilityHoldings(notes: true))
        XCTAssertEqual(form.sourceScopes(request: request), [])
        XCTAssertEqual(
            form.selection(request: request, overview: overview),
            .connect(rules: [.notes], credentialLabel: "Northstar Assistant")
        )
    }

    /// A grant reviewed by a policy the overview no longer lists reopens on
    /// the default policy: the picker can only show what the overview offers,
    /// and a retired id would leave it with nothing selected.
    func testAReviewedPolicyTheOverviewNoLongerListsFallsBackToTheDefault() {
        var form = AccessAuthorizationFormState(sourceIds: known)
        form.populate(
            request: request,
            overview: overview,
            prefill: [
                .answer(
                    sources: AccessSourceBoundary(mode: .all, sourceIds: []),
                    release: .reviewed(policyFamilyId: "policy-retired")
                ),
            ]
        )
        XCTAssertEqual(form.answerRelease, .reviewed)
        XCTAssertEqual(form.policyFamilyId, "policy-work-safe")
        XCTAssertEqual(
            form.selection(request: request, overview: overview),
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
    /// reference survives the form and goes back out in the selection, so a
    /// prefill approved as shown is the grant the gateway already accepts.
    func testASourceAbsentFromTheOverviewSurvivesTheFormIntoTheSelection() {
        let allowlist = AccessSourceBoundary(
            mode: .allowlist,
            sourceIds: ["github:maya-reeves", "github:retired-workspace"]
        )
        let denylist = AccessSourceBoundary(mode: .denylist, sourceIds: ["gmail:removed@example.com"])
        var form = AccessAuthorizationFormState(sourceIds: known)
        form.populate(
            request: request,
            overview: overview,
            prefill: [
                .direct(sources: allowlist),
                .answer(sources: denylist, release: .unreviewed),
            ]
        )
        XCTAssertEqual(
            form.selection(request: request, overview: overview),
            .connect(
                rules: [
                    .direct(sources: allowlist),
                    .answer(sources: denylist, release: .unreviewed),
                ],
                credentialLabel: "Northstar Assistant"
            )
        )
    }

    /// The form a refresh rebuilds follows the lookup taken with it: once
    /// the prefill it named is gone, the wizard opens on the defaults again.
    func testARefreshWithoutAPrefillReopensOnTheDefaults() {
        let opened = AccessAuthorizationFormState.opening(request: request, overview: overview, prefill: [.notes])
        XCTAssertEqual(opened.holdings(request: request), AccessCapabilityHoldings(notes: true))

        let refreshed = AccessAuthorizationFormState.opening(request: request, overview: overview, prefill: nil)
        XCTAssertEqual(refreshed.holdings(request: request), AccessCapabilityHoldings(answer: true))
        XCTAssertEqual(refreshed.policyFamilyId, "policy-work-safe")
        XCTAssertNil(refreshed.selection(request: request, overview: overview))
    }

    /// The credential label is the client's name, cut to what the wire holds.
    func testTheCredentialLabelIsTheClientNameWithinTheWireLimit() {
        let longName = String(repeating: "Northstar ", count: 20)
        var form = AccessAuthorizationFormState(sourceIds: known)
        let renamed = renamedRequest(longName)
        form.populate(request: renamed, overview: overview, prefill: [.notes])
        guard case .connect(_, let label)? = form.selection(request: renamed, overview: overview) else {
            return XCTFail("Expected a connect selection")
        }
        XCTAssertEqual(label, String(longName.prefix(160)))
    }

    /// The cut lands on a character boundary: a name whose 160th UTF-16 unit
    /// is the first half of a surrogate pair loses the whole character, and
    /// one that fits exactly is kept whole.
    func testTheCredentialLabelNeverSplitsASurrogatePair() {
        let fill = String(repeating: "N", count: 159)
        var form = AccessAuthorizationFormState(sourceIds: known)
        for (name, expected) in [
            (fill + "🎉", fill),
            (String(fill.dropLast()) + "🎉", String(fill.dropLast()) + "🎉"),
        ] {
            let renamed = renamedRequest(name)
            form.populate(request: renamed, overview: overview, prefill: [.notes])
            guard case .connect(_, let label)? = form.selection(request: renamed, overview: overview) else {
                return XCTFail("Expected a connect selection")
            }
            XCTAssertEqual(label, expected)
            XCTAssertLessThanOrEqual(label.utf16.count, 160)
        }
    }

    private func renamedRequest(_ clientName: String) -> AccessAuthorizationRequest {
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
            requiresAnswer: false
        )
    }
}
