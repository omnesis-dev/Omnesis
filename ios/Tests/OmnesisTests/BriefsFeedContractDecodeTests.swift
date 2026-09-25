// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

/// Cross-surface briefs-feed DTO contract — the iOS half.
///
/// Loads the SAME canonical, invented fixture the gateway-side contract
/// test pins (`Fixtures/briefs-feed-contract.json`, a byte-identical
/// mirror of `packages/gateway/src/brain/__fixtures__/` — the TS half
/// asserts the REAL `GET /briefs/feed` route emits exactly this payload
/// and that the mirror never drifts). This half feeds those bytes
/// through the real `BriefsClient.feed()` decode path and asserts every
/// field the iOS surface models survives — so a wire field the gateway
/// emits but the Swift `Decodable` silently drops reddens here, without
/// needing a simulator or a spawned gateway on the macOS lane.
final class BriefsFeedContractDecodeTests: XCTestCase {
    private final class FixtureSession: URLSessionLike, @unchecked Sendable {
        let payload: Data
        var lastRequest: URLRequest?

        init(payload: Data) {
            self.payload = payload
        }

        func data(for request: URLRequest) async throws -> (Data, URLResponse) {
            lastRequest = request
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 200,
                httpVersion: "HTTP/1.1",
                headerFields: ["Content-Type": "application/json"]
            )!
            return (payload, response)
        }
    }

    private func loadFixture() throws -> Data {
        // Resolve the fixture relative to THIS test source file so it works
        // from any working directory (the macOS scratch checkout's ios/ tree).
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .appendingPathComponent("Fixtures/briefs-feed-contract.json")
        return try Data(contentsOf: url)
    }

    private func decodeFeed() async throws -> [BriefRecord] {
        let session = try FixtureSession(payload: loadFixture())
        let client = BriefsClient(
            baseURL: URL(string: "https://gateway.example:7600")!,
            token: "omn_contract",
            session: session
        )
        return try await client.feed().briefs
    }

    func test_fixture_decodes_through_the_real_client_path() async throws {
        let briefs = try await decodeFeed()
        XCTAssertEqual(briefs.count, 2, "both fixture briefs decode — none dropped")
    }

    func test_loop_brief_decodes_every_populated_field() async throws {
        let briefs = try await decodeFeed()
        let loop = try XCTUnwrap(briefs.first { $0.id == "brf_contract_loop" })
        XCTAssertEqual(loop.kind, .loop)
        XCTAssertEqual(loop.state, .unread)
        XCTAssertEqual(loop.title, "Send back the signed studio agreement")
        XCTAssertEqual(loop.description, "Studio Northstar asked for the signed copy last week.")
        XCTAssertEqual(
            loop.body,
            "The agreement arrived by email. Maya Reeves offered to co-sign; " +
                "nothing has been sent back yet."
        )
        XCTAssertEqual(loop.confidence, 0.9, accuracy: 0.0001)
        XCTAssertEqual(loop.urgency, 0.6, accuracy: 0.0001)
        // Gateway timestamps are `toISOString()` — the parse accessors
        // must read them back to the exact instants the TS half seeded.
        XCTAssertEqual(
            try XCTUnwrap(loop.createdAtDate).timeIntervalSince1970, 1.0, accuracy: 0.001
        )
        XCTAssertEqual(
            try XCTUnwrap(loop.eventAtDate).timeIntervalSince1970,
            4_102_444_800.0, // 2100-01-01T00:00:00Z
            accuracy: 0.001
        )
        XCTAssertEqual(loop.relevantUntil, "2100-01-02T00:00:00.000Z")

        XCTAssertEqual(loop.citations.count, 1)
        let citation = try XCTUnwrap(loop.citations.first)
        XCTAssertEqual(citation.docId, "doc_contract_email")
        XCTAssertEqual(citation.title, "Studio agreement — signature needed")
        XCTAssertEqual(citation.providerId, "demo-mail")
        XCTAssertEqual(citation.sourceId, "demo-mail:inbox")
    }

    func test_info_brief_decodes_null_fields_and_read_state() async throws {
        let briefs = try await decodeFeed()
        let info = try XCTUnwrap(briefs.first { $0.id == "brf_contract_info" })
        XCTAssertEqual(info.kind, .info)
        XCTAssertEqual(info.state, .read)
        XCTAssertEqual(info.title, "Design review moved to Thursday")
        XCTAssertEqual(info.description, "The calendar invite was updated overnight.")
        XCTAssertNil(info.body, "explicit null decodes to nil, not empty string")
        XCTAssertNil(info.eventAt)
        XCTAssertNil(info.eventAtDate)
        XCTAssertNil(info.relevantUntil)
        XCTAssertTrue(info.citations.isEmpty)
    }

    func test_feed_order_matches_the_fixture_ranking() async throws {
        // The fixture is stored ranked (the TS half deep-equals the live
        // route's output, order included): unread before read.
        let briefs = try await decodeFeed()
        XCTAssertEqual(briefs.map(\.id), ["brf_contract_loop", "brf_contract_info"])
        // The talk-back pointer rides the feed DTO; null until a thread opens.
        XCTAssertNil(briefs[0].threadConversationId)
    }
}
