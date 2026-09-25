// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

final class AccessWireTypesTests: XCTestCase {
    func testNotesRuleRoundTripsWithoutReadingOrReleaseAuthority() throws {
        let rule = AccessGrantRule.notes
        let data = try JSONEncoder().encode(rule)
        XCTAssertEqual(try JSONDecoder().decode(AccessGrantRule.self, from: data), rule)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(object["capability"] as? String, "notes")
        XCTAssertNil(object["release"])
        XCTAssertEqual((object["sources"] as? [String: Any])?["mode"] as? String, "all")
        let invalid = Data(#"{"capability":"notes","sources":{"mode":"allowlist","sourceIds":["example:source"]}}"#.utf8)
        XCTAssertThrowsError(try JSONDecoder().decode(AccessGrantRule.self, from: invalid))
    }

    func testEmptyEffectiveSourceSelectionDoesNotPermitApproval() {
        let known: Set = ["notes:fictional"]
        var selection = AccessSourceSelectionState.newGrant(knownSourceIds: known)
        XCTAssertFalse(selection.permitsAnyKnownSource(known))
        selection.setAllowed(true, sourceId: "notes:fictional")
        XCTAssertTrue(selection.permitsAnyKnownSource(known))
        selection.setMode(.all, knownSourceIds: known)
        XCTAssertTrue(selection.permitsAnyKnownSource(known))
        XCTAssertFalse(selection.permitsAnyKnownSource([]))
    }

    func testConnectSelectionEncodesOneKindWithRulesAndLabel() throws {
        let selection = AccessAuthorizationSelection.connect(
            rules: [
                .notes,
                .answer(
                    sources: AccessSourceBoundary(mode: .allowlist, sourceIds: ["github:maya-reeves"]),
                    release: .reviewed(policyFamilyId: "policy-work-safe")
                ),
            ],
            credentialLabel: "Northstar Assistant"
        )
        let data = try JSONEncoder().encode(selection)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(object["kind"] as? String, "connect")
        XCTAssertEqual(object["credentialLabel"] as? String, "Northstar Assistant")
        XCTAssertEqual(Set(object.keys), ["kind", "rules", "credentialLabel"])
        let rules = try XCTUnwrap(object["rules"] as? [[String: Any]])
        XCTAssertEqual(rules.map { $0["capability"] as? String }, ["notes", "answer"])
    }

    /// A gateway that predates connection proposals sends no `connection`
    /// key, or a null one; either way the lookup reads as the `connect` flow.
    func testLookupEnvelopeDecodesWithoutAReconnectOrConnectionProposal() throws {
        for extra in [#""reconnect":null,"#, "", #""reconnect":null,"connection":null,"#] {
            let json = "{\(extra)\"request\":\(pendingRequestJSON)}"
            let envelope = try JSONDecoder().decode(
                AccessAuthorizationLookupEnvelope.self,
                from: Data(json.utf8)
            )
            XCTAssertEqual(envelope.request.clientName, "Northstar Assistant")
            XCTAssertNil(envelope.reconnect)
            XCTAssertNil(envelope.connection)
        }
    }

    /// A gateway ahead of this build may add keys beside `request` and
    /// `reconnect`; the envelope reads what it knows and leaves the rest.
    func testLookupEnvelopeIgnoresKeysItDoesNotKnow() throws {
        let json = #"{"request":\#(pendingRequestJSON),"reconnect":null,"nextStep":{"kind":"review"}}"#
        let envelope = try JSONDecoder().decode(
            AccessAuthorizationLookupEnvelope.self,
            from: Data(json.utf8)
        )
        XCTAssertEqual(envelope.request.id, "request-example")
        XCTAssertNil(envelope.reconnect)
    }

    func testLookupEnvelopeDecodesTheReconnectProposalWithItsGrant() throws {
        let json = """
        {"request":\(pendingRequestJSON),"reconnect":{"matchedBy":"name",
        "principal":{"id":"principal-northstar","name":"Northstar Assistant"},
        "grant":{"id":"grant-northstar","principalId":"principal-northstar",
        "name":"Northstar Assistant access","revision":2,"capabilities":[],
        "rules":[{"capability":"notes","sources":{"mode":"all","sourceIds":[]}},
        {"capability":"answer","sources":{"mode":"allowlist","sourceIds":["github:maya-reeves"]},
        "release":{"mode":"unreviewed"}}],
        "credentials":[{"id":"credential-northstar","label":"Northstar laptop","status":"active",
        "revokedAt":null,"createdAt":1}],
        "createdAt":1,"updatedAt":2,"expiresAt":null,"revokedAt":null}}}
        """
        let envelope = try JSONDecoder().decode(
            AccessAuthorizationLookupEnvelope.self,
            from: Data(json.utf8)
        )
        let reconnect = try XCTUnwrap(envelope.reconnect)
        XCTAssertEqual(reconnect.matchedBy, "name")
        XCTAssertEqual(reconnect.principal.id, "principal-northstar")
        XCTAssertEqual(reconnect.principal.name, "Northstar Assistant")
        XCTAssertEqual(reconnect.grant.id, "grant-northstar")
        XCTAssertEqual(reconnect.grant.revision, 2)
        XCTAssertEqual(reconnect.grant.rules, [
            .notes,
            .answer(
                sources: AccessSourceBoundary(mode: .allowlist, sourceIds: ["github:maya-reeves"]),
                release: .unreviewed
            ),
        ])
        XCTAssertEqual(reconnect.grant.credentials.map(\.label), ["Northstar laptop"])
    }

    private let pendingRequestJSON = """
    {"id":"request-example","approvalId":"approval-example","status":"pending",\
    "clientId":"client-example","clientName":"Northstar Assistant","clientUri":null,\
    "redirectOrigin":"http://127.0.0.1:8765","resource":"https://gateway.example/mcp",\
    "scope":"omnesis:access","expiresAt":1800000000000,"requiresAnswer":false}
    """

    private let known: Set<String> = [
        "github:maya-reeves",
        "gmail:maya.reeves@example.com",
        "claude-transcripts:workstation",
    ]

    func testNewGrantIsEmptyAllowlist() {
        let state = AccessSourceSelectionState.newGrant(knownSourceIds: known)
        XCTAssertEqual(
            state.boundary(knownSourceIds: known),
            AccessSourceBoundary(mode: .allowlist, sourceIds: [])
        )
    }

    func testAuthorizationConflictMessageDistinguishesRefreshSuccessFromFailure() {
        XCTAssertEqual(
            accessAuthorizationDecisionMessage(
                errorCode: "invalid-selection",
                choiceRefresh: .refreshed
            ),
            "Access choices changed. Review the refreshed request."
        )
        XCTAssertEqual(
            accessAuthorizationDecisionMessage(
                errorCode: "invalid-selection",
                choiceRefresh: .failed
            ),
            "The available access choices changed, but Omnesis could not reload them. "
                + "Close this sheet, enter the code again, and try once more."
        )
        XCTAssertEqual(
            accessAuthorizationDecisionMessage(
                errorCode: "device-unauthorized",
                choiceRefresh: .notAttempted
            ),
            "This phone is no longer authorized. Re-pair it from Settings."
        )
        XCTAssertEqual(
            accessAuthorizationDecisionMessage(
                errorCode: "invalid-input",
                choiceRefresh: .notAttempted
            ),
            "Some values are invalid. Review the source selections."
        )
    }

    func testAuthorizationDecisionRecoveryRequiresTheIntendedTerminalState() {
        XCTAssertTrue(accessAuthorizationDecisionWasRecorded(status: "approved", approve: true))
        XCTAssertTrue(accessAuthorizationDecisionWasRecorded(status: "code-issued", approve: true))
        XCTAssertTrue(accessAuthorizationDecisionWasRecorded(status: "complete", approve: true))
        XCTAssertTrue(accessAuthorizationDecisionWasRecorded(status: "denied", approve: false))
        XCTAssertFalse(accessAuthorizationDecisionWasRecorded(status: "denied", approve: true))
        XCTAssertFalse(accessAuthorizationDecisionWasRecorded(status: "pending", approve: true))
    }

    func testAuthorizationOutcomePresentationDistinguishesApprovalAndDenial() {
        let approved = accessAuthorizationOutcomePresentation(
            outcome: .approved,
            clientName: "Northstar Assistant"
        )
        XCTAssertEqual(approved.symbol, "checkmark.circle.fill")
        XCTAssertEqual(approved.title, "Access granted")
        XCTAssertTrue(approved.approved)

        let denied = accessAuthorizationOutcomePresentation(
            outcome: .denied,
            clientName: "Northstar Assistant"
        )
        XCTAssertEqual(denied.symbol, "xmark.circle.fill")
        XCTAssertEqual(denied.title, "Request denied")
        XCTAssertFalse(denied.approved)
        XCTAssertEqual(denied.detail, "Northstar Assistant was not given access to Omnesis.")
    }

    func testAuthorizationDeadlineCopyIncludesExpiryAndStopsAtZero() {
        XCTAssertEqual(
            accessAuthorizationDeadlineText(expiresAt: 700_000, nowMillis: 100_000),
            "Expires in 10 minutes."
        )
        XCTAssertEqual(
            accessAuthorizationDeadlineText(expiresAt: 100_000, nowMillis: 100_000),
            "This request has expired."
        )
    }

    func testAuthorizationDecisionGuardRejectsReentryAndExpiry() {
        XCTAssertTrue(
            accessAuthorizationMayBeginDecision(
                deciding: false,
                expiresAt: 100_000,
                nowMillis: 99999
            )
        )
        XCTAssertFalse(
            accessAuthorizationMayBeginDecision(
                deciding: true,
                expiresAt: 100_000,
                nowMillis: 99999
            )
        )
        XCTAssertFalse(
            accessAuthorizationMayBeginDecision(
                deciding: false,
                expiresAt: 100_000,
                nowMillis: 100_000
            )
        )
    }

    func testAuthorizationLookupDispositionNeverOpensAnExpiredWizard() {
        XCTAssertEqual(
            accessAuthorizationLookupDisposition(
                status: "pending",
                expiresAt: 100_000,
                nowMillis: 99999
            ),
            .pending
        )
        XCTAssertEqual(
            accessAuthorizationLookupDisposition(
                status: "pending",
                expiresAt: 100_000,
                nowMillis: 100_000
            ),
            .expired
        )
        XCTAssertEqual(
            accessAuthorizationLookupDisposition(
                status: "expired",
                expiresAt: 200_000,
                nowMillis: 100_000
            ),
            .expired
        )
    }

    func testCheckedAlwaysMeansAllowedAcrossModes() {
        for mode in AccessSourceMode.allCases {
            var state = AccessSourceSelectionState(
                boundary: AccessSourceBoundary(mode: mode, sourceIds: []),
                knownSourceIds: known
            )
            state.setAllowed(true, sourceId: "github:maya-reeves")
            XCTAssertTrue(state.allowedSourceIds.contains("github:maya-reeves"))
            state.setAllowed(false, sourceId: "github:maya-reeves")
            XCTAssertFalse(state.allowedSourceIds.contains("github:maya-reeves"))
        }
    }

    func testBlockingOneSourceUnderAllBecomesTheDenylistThatCanRecordIt() {
        var state = AccessSourceSelectionState(
            boundary: AccessSourceBoundary(mode: .all, sourceIds: []),
            knownSourceIds: known
        )
        state.setAllowed(false, sourceId: "github:maya-reeves")
        XCTAssertEqual(
            state.boundary(knownSourceIds: known),
            AccessSourceBoundary(mode: .denylist, sourceIds: ["github:maya-reeves"])
        )
        // Blocking one source says nothing about the next source connected.
        XCTAssertTrue(state.allowsFutureSources)
    }

    /// The overview lists the requests still waiting, newest first, each
    /// beside the code its client displays, which the phone does not read;
    /// a gateway that does not report them reads as none waiting.
    func testOverviewDecodesPendingRequestsAndReadsTheirAbsenceAsNone() throws {
        let base = #""principals":[],"sources":[],"policyFamilies":[]"#
        let listed = try JSONDecoder().decode(
            AccessOverview.self,
            from: Data("""
            {\(base),"pendingRequests":[{"id":"request-newest","clientName":"Northstar Assistant",\
            "userCode":"QRST-UVWX","createdAt":1800000000000,"expiresAt":1800000600000}]}
            """.utf8)
        )
        XCTAssertEqual(listed.pendingRequests, [
            AccessPendingRequest(
                id: "request-newest",
                clientName: "Northstar Assistant",
                createdAt: 1_800_000_000_000,
                expiresAt: 1_800_000_600_000
            ),
        ])
        let unlisted = try JSONDecoder().decode(AccessOverview.self, from: Data("{\(base)}".utf8))
        XCTAssertNil(unlisted.pendingRequests)
        XCTAssertEqual(unlisted.levels, [])
        let reencoded = try JSONSerialization.jsonObject(with: JSONEncoder().encode(unlisted)) as? [String: Any]
        XCTAssertNil(reencoded?["pendingRequests"])
    }

    /// The sources a grant can be drawn over are the available ones; a
    /// listed but unavailable source is shown for its retained decision only.
    func testOverviewOffersOnlyAvailableSources() {
        let overview = AccessOverview(
            principals: [],
            sources: [
                AccessSourceInstance(id: "github:maya-reeves", name: "GitHub"),
                AccessSourceInstance(id: "github:retired-workspace", name: "Retired", available: false),
            ],
            policyFamilies: []
        )
        XCTAssertEqual(overview.availableSourceIds, ["github:maya-reeves"])
    }

    func testDenylistSerializesBlockedRowsAndPreservesUnavailableDecision() {
        var state = AccessSourceSelectionState(
            boundary: AccessSourceBoundary(
                mode: .denylist,
                sourceIds: ["gmail:removed@example.com", "gmail:maya.reeves@example.com"]
            ),
            knownSourceIds: known
        )
        XCTAssertFalse(state.allowedSourceIds.contains("gmail:maya.reeves@example.com"))
        state.setAllowed(true, sourceId: "gmail:maya.reeves@example.com")
        XCTAssertEqual(
            state.boundary(knownSourceIds: known).sourceIds,
            ["gmail:removed@example.com"]
        )
    }

    func testAllowlistDoesNotGainAFutureSourceWhileDenylistDoes() {
        let original: Set = ["github:maya-reeves"]
        let withFuture = original.union(["notion-pages:team-space"])
        let allowlist = AccessSourceSelectionState(
            boundary: AccessSourceBoundary(
                mode: .allowlist,
                sourceIds: ["github:maya-reeves"]
            ),
            knownSourceIds: original
        )
        let denylist = AccessSourceSelectionState(
            boundary: AccessSourceBoundary(mode: .denylist, sourceIds: []),
            knownSourceIds: original
        )

        XCTAssertFalse(allowlist.allowedSourceIds.contains("notion-pages:team-space"))
        XCTAssertFalse(
            Set(allowlist.boundary(knownSourceIds: withFuture).sourceIds)
                .contains("notion-pages:team-space")
        )
        XCTAssertFalse(
            Set(denylist.boundary(knownSourceIds: withFuture).sourceIds)
                .contains("notion-pages:team-space")
        )
    }

    func testGrantRuleWireShapeIsStrictlyDiscriminated() throws {
        let rule = AccessGrantRule.answer(
            sources: AccessSourceBoundary(
                mode: .allowlist,
                sourceIds: ["github:maya-reeves"]
            ),
            release: .reviewed(policyFamilyId: "policy-work-safe")
        )
        let data = try JSONEncoder().encode(rule)
        XCTAssertEqual(try JSONDecoder().decode(AccessGrantRule.self, from: data), rule)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(object["capability"] as? String, "answer")
        XCTAssertEqual((object["release"] as? [String: Any])?["mode"] as? String, "reviewed")
    }
}
