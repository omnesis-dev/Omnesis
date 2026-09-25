// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

/// The wire shapes of connections and access levels: the selections an
/// approval sends, the proposal a lookup carries, and the levels the
/// overview lists.
final class AccessConnectionWireTypesTests: XCTestCase {
    /// A new connection on a new level carries the level's name and rules
    /// inside `level`, and nothing a gateway would read as another kind.
    func testNewConnectionOnANewLevelEncodesExactKeys() throws {
        let rules: [AccessGrantRule] = [
            .answer(
                sources: AccessSourceBoundary(mode: .all, sourceIds: []),
                release: .unreviewed
            ),
        ]
        let object = try encodedObject(
            AccessAuthorizationSelection.newConnection(
                name: "Northstar desk",
                level: .new(name: "Northstar helpers", rules: rules)
            )
        )
        XCTAssertEqual(Set(object.keys), ["kind", "name", "level"])
        XCTAssertEqual(object["kind"] as? String, "new-connection")
        XCTAssertEqual(object["name"] as? String, "Northstar desk")
        let level = try XCTUnwrap(object["level"] as? [String: Any])
        XCTAssertEqual(Set(level.keys), ["kind", "name", "rules"])
        XCTAssertEqual(level["kind"] as? String, "new")
        XCTAssertEqual(level["name"] as? String, "Northstar helpers")
        XCTAssertEqual((level["rules"] as? [[String: Any]])?.map { $0["capability"] as? String }, ["answer"])
    }

    func testNewConnectionOnAnExistingLevelEncodesExactKeys() throws {
        let object = try encodedObject(
            AccessAuthorizationSelection.newConnection(
                name: "Northstar desk",
                level: .existing(levelId: "level-research", expectedLevelRevision: 3)
            )
        )
        XCTAssertEqual(Set(object.keys), ["kind", "name", "level"])
        XCTAssertEqual(object["kind"] as? String, "new-connection")
        let level = try XCTUnwrap(object["level"] as? [String: Any])
        XCTAssertEqual(Set(level.keys), ["kind", "levelId", "expectedLevelRevision"])
        XCTAssertEqual(level["kind"] as? String, "existing")
        XCTAssertEqual(level["levelId"] as? String, "level-research")
        XCTAssertEqual(level["expectedLevelRevision"] as? Int, 3)
    }

    func testReplaceConnectionEncodesExactKeys() throws {
        let object = try encodedObject(
            AccessAuthorizationSelection.replaceConnection(connectionId: "principal-northstar", expectedGrantRevision: 7)
        )
        XCTAssertEqual(Set(object.keys), ["kind", "connectionId", "expectedGrantRevision"])
        XCTAssertEqual(object["kind"] as? String, "replace-connection")
        XCTAssertEqual(object["connectionId"] as? String, "principal-northstar")
        XCTAssertEqual(object["expectedGrantRevision"] as? Int, 7)
    }

    func testLookupEnvelopeDecodesTheConnectionProposalWithItsMatch() throws {
        let json = """
        {"request":\(pendingRequestJSON),"reconnect":null,"connection":{"defaultName":"Northstar Assistant 2",
        "defaultLevelName":"Northstar Assistant","recommended":"existing-level","match":{
        "connectionId":"principal-northstar","connectionName":"Northstar desk","matchedBy":"client",
        "levelId":"level-research","grant":{"id":"grant-northstar","principalId":"principal-northstar",
        "name":"Northstar desk access","revision":5,"levelId":"level-research","capabilities":[],
        "rules":[{"capability":"notes","sources":{"mode":"all","sourceIds":[]}}],
        "credentials":[{"id":"credential-northstar","label":"Northstar desk","status":"active",
        "revokedAt":null,"createdAt":1,"lastUsedAt":1800000000000,"clientName":"Northstar Assistant"}],
        "createdAt":1,"updatedAt":2,"expiresAt":null,"revokedAt":null}}}}
        """
        let envelope = try JSONDecoder().decode(AccessAuthorizationLookupEnvelope.self, from: Data(json.utf8))
        XCTAssertNil(envelope.reconnect)
        let proposal = try XCTUnwrap(envelope.connection)
        XCTAssertEqual(proposal.defaultName, "Northstar Assistant 2")
        XCTAssertEqual(proposal.defaultLevelName, "Northstar Assistant")
        XCTAssertEqual(proposal.recommended, .existingLevel)
        let match = try XCTUnwrap(proposal.match)
        XCTAssertEqual(match.connectionId, "principal-northstar")
        XCTAssertEqual(match.connectionName, "Northstar desk")
        XCTAssertEqual(match.matchedBy, "client")
        XCTAssertEqual(match.levelId, "level-research")
        XCTAssertEqual(match.grant.levelId, "level-research")
        XCTAssertEqual(match.grant.revision, 5)
        XCTAssertEqual(match.grant.rules, [.notes])
        XCTAssertEqual(match.grant.credentials.first?.lastUsedAt, 1_800_000_000_000)
        XCTAssertEqual(match.grant.credentials.first?.clientName, "Northstar Assistant")
    }

    /// Every recommendation the gateway names decodes, and one this build
    /// does not know opens on a new level rather than failing the lookup.
    func testProposalRecommendationsDecodeAndUnknownOnesMeanANewLevel() throws {
        let cases: [(String, AccessConnectionProposal.Recommendation)] = [
            ("existing-level", .existingLevel), ("new-level", .newLevel), ("replace", .replace), ("merge", .newLevel),
        ]
        for (raw, expected) in cases {
            let json = #"{"defaultName":"Agent","defaultLevelName":"Agent","match":null,"recommended":"\#(raw)"}"#
            let proposal = try JSONDecoder().decode(AccessConnectionProposal.self, from: Data(json.utf8))
            XCTAssertEqual(proposal.recommended, expected, raw)
            XCTAssertNil(proposal.match)
        }
    }

    /// The overview lists live access levels with their rules and how many
    /// connections use them; a gateway without levels lists none. A grant
    /// and a credential from a gateway without the newer fields read as nil.
    func testOverviewDecodesLevelsAndReadsTheirAbsenceAsNone() throws {
        let json = """
        {"principals":[{"id":"principal-example","name":"Northstar desk","kind":"interactive","revokedAt":null,
        "grants":[{"id":"grant-example","name":"Northstar desk access","revision":1,"rules":[],
        "credentials":[{"id":"credential-example","label":"Northstar desk","status":"active","revokedAt":null}],
        "expiresAt":null,"revokedAt":null}]}],"sources":[],"policyFamilies":[],
        "levels":[{"id":"level-research","name":"Research assistants","revision":2,"connectionCount":0,
        "createdAt":1800000000000,"updatedAt":1800000600000,
        "rules":[{"capability":"notes","sources":{"mode":"all","sourceIds":[]}}]}]}
        """
        let overview = try JSONDecoder().decode(AccessOverview.self, from: Data(json.utf8))
        XCTAssertEqual(overview.levels, [
            AccessLevelSummary(
                id: "level-research",
                name: "Research assistants",
                revision: 2,
                rules: [.notes],
                connectionCount: 0,
                createdAt: 1_800_000_000_000,
                updatedAt: 1_800_000_600_000
            ),
        ])
        let grant = try XCTUnwrap(overview.principals.first?.grants.first)
        XCTAssertNil(grant.levelId)
        XCTAssertNil(grant.credentials.first?.lastUsedAt)
        XCTAssertNil(grant.credentials.first?.clientName)
    }

    private func encodedObject(_ selection: AccessAuthorizationSelection) throws -> [String: Any] {
        let data = try JSONEncoder().encode(selection)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    private let pendingRequestJSON = """
    {"id":"request-example","approvalId":"approval-example","status":"pending",\
    "clientId":"client-example","clientName":"Northstar Assistant","clientUri":null,\
    "redirectOrigin":"http://127.0.0.1:8765","resource":"https://gateway.example/mcp",\
    "scope":"omnesis:access","expiresAt":1800000000000,"requiresAnswer":false}
    """
}
