// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

/// A level or approval without source filters is sent with exactly the keys a gateway that
/// knows no filters accepts: its rule schema is strict, so one extra key refuses the request.
final class AccessUnfilteredWireShapeTests: XCTestCase {
    private let request = AccessAuthorizationRequest(
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

    /// An overview as a gateway without filters serves it: no `sourceFilters`, no declarations.
    private let overview = AccessOverview(
        principals: [],
        sources: [AccessSourceInstance(id: "notes:maya-reeves", name: "Notes")],
        policyFamilies: [AccessPolicyFamilySummary(id: "policy-example", name: "Standard", revision: "1")],
        defaultPolicyFamilyId: "policy-example"
    )

    private func ruleKeys(_ rules: [AccessGrantRule]) throws -> [String: Set<String>] {
        let data = try JSONEncoder().encode(rules)
        let objects = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [[String: Any]])
        return Dictionary(uniqueKeysWithValues: objects.map { ($0["capability"] as? String ?? "", Set($0.keys)) })
    }

    func testApprovalRulesWithDirectFollowingAnswerCarryNoFilterKeys() throws {
        let draft = AccessLevelDraft.approving(request: request, overview: overview, prefill: nil)
        var level = AccessDraftDecisions(draft: draft, overview: overview, original: draft)
        level.setHeld("direct", true)
        level.setHeld("notes", true)
        var sources = try XCTUnwrap(level.sourceSelection("answer"))
        sources.setAllowed(true, sourceId: "notes:maya-reeves")
        level.setSourceSelection(sources, capability: "answer")
        XCTAssertTrue(level.directFollowsAnswer)

        let rules = try XCTUnwrap(level.sendableRules)
        XCTAssertEqual(try ruleKeys(rules), [
            "notes": ["capability", "sources"],
            "direct": ["capability", "sources"],
            "answer": ["capability", "sources", "release"],
        ])
        guard case .connect(let sent, _) = try XCTUnwrap(accessConnectSelection(rules: level.sendableRules, request: request)) else {
            return XCTFail("A gateway without connection proposals is approved with connect")
        }
        XCTAssertEqual(sent, rules)
    }

    func testAnUnfilteredRuleFromAGatewayRoundTripsWithTheSameKeys() throws {
        let wire = #"[{"capability":"direct","sources":{"mode":"all","sourceIds":[]}},"#
            + #"{"capability":"answer","sources":{"mode":"allowlist","sourceIds":["notes:maya-reeves"]},"release":{"mode":"unreviewed"}}]"#
        let rules = try JSONDecoder().decode([AccessGrantRule].self, from: Data(wire.utf8))
        XCTAssertEqual(try ruleKeys(rules), [
            "direct": ["capability", "sources"],
            "answer": ["capability", "sources", "release"],
        ])
    }

    func testANewLevelWithDirectFollowingAnswerCarriesNoFilterKeys() throws {
        var draft = AccessLevelDraft(level: nil, overview: overview)
        draft.setEnabled("direct", true, overview: overview)
        draft.setBoundary(.init(mode: .allowlist, sourceIds: ["notes:maya-reeves"]), capability: "answer", authoringEnabled: nil)
        XCTAssertTrue(draft.directSameAsAnswer)
        XCTAssertEqual(try ruleKeys(draft.serializedRules), [
            "direct": ["capability", "sources"],
            "answer": ["capability", "sources", "release"],
        ])
    }

    /// The real boundary of a filtered rule is `scopeSources`; `sources` is what an older client may copy.
    func testAFilteredRuleIsReadAtItsRealBoundary() throws {
        let wire = #"{"capability":"direct","sources":{"mode":"denylist","sourceIds":["notes:maya-reeves"]},"#
            + #""scopeSources":{"mode":"all","sourceIds":[]},"filterRevision":2}"#
        let rule = try JSONDecoder().decode(AccessGrantRule.self, from: Data(wire.utf8))
        XCTAssertEqual(rule.boundary, AccessSourceBoundary(mode: .all, sourceIds: []))
        let sent = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(rule)) as? [String: Any])
        XCTAssertNil(sent["scopeSources"])
    }
}
