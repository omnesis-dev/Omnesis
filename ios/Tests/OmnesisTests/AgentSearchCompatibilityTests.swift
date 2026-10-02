// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

@available(iOS 17.0, *)
final class AgentSearchCompatibilityTests: XCTestCase {
    private func decodeResult(_ json: String) throws -> AgentToolResult {
        try JSONDecoder().decode(AgentToolResult.self, from: Data(json.utf8))
    }

    func test_search_provenance_is_additive_for_existing_decoder() throws {
        let legacy = #"""
        {"documentId":"agreement-1","sourceType":"files","sourceId":"files:example",
        "title":"Equipment agreement","snippet":"Equipment terms","url":"https://example.com/agreement"}
        """#
        let extra = #"""
        ,"provenance":{"summary":"The same text appears elsewhere.",
        "copies":[{"documentId":"agreement-1","sourceId":"files:example"},
        {"documentId":"agreement-2","sourceId":"files:example"}],
        "paths":[{"documentIds":["agreement-1","message-1"],"edges":["inbound:url"],"relations":["is linked from"]}],
        "truncated":false,"stopReasons":[],
        "modelContext":{"facts":["D1 is linked from D2."],"documents":[
        {"ref":"D1","documentId":"agreement-1","sourceId":"files:example"},
        {"ref":"D2","documentId":"message-1","sourceId":"messages:example"}],"limits":[]}}
        """#
        let enriched = String(legacy.dropLast()) + extra + "}"
        func search(_ reference: String) -> String {
            """
            {"kind":"search.results","query":"equipment","durationMs":2,"candidates":3,"results":[\(reference)]}
            """
        }
        let original = try decodeResult(search(legacy))
        guard case .searchResults(let query, _, let candidates, let rows) = original else {
            return XCTFail("Expected search results")
        }
        XCTAssertEqual(query, "equipment")
        XCTAssertEqual(candidates, 3)
        XCTAssertEqual(rows.first?.documentId, "agreement-1")
        XCTAssertEqual(rows.first?.snippet, "Equipment terms")
        XCTAssertEqual(rows.first?.url, "https://example.com/agreement")
        let enrichedResult = try decodeResult(search(enriched))
        XCTAssertEqual(
            enrichedResult,
            original,
            "An older client keeps the representative row and ignores additive graph fields"
        )
        let batchJSON = """
        {"kind":"search.batch","items":[\(search(legacy)),\(search(enriched)),
        {"kind":"error","code":"batch_child_failed","message":"Unavailable"}]}
        """
        let batch = try decodeResult(batchJSON)
        guard case .searchBatch(let items) = batch else { return XCTFail("Expected search batch") }
        XCTAssertEqual(items.count, 3)
        XCTAssertEqual(items[0], original)
        XCTAssertEqual(items[1], original)
        guard case .error(let code, _) = items[2] else { return XCTFail("Expected preserved error slot") }
        XCTAssertEqual(code, "batch_child_failed")
    }

    func test_ordinary_search_keeps_distinct_matching_text_rows() throws {
        let raw = #"""
        {"results":[
          {"documentId":"agreement-1","sourceId":"files:example","documentType":"file","title":"Equipment agreement",
          "sourceCreatedAt":"2025-02-01T00:00:00Z","chunkText":"Equipment terms","score":0.9},
          {"documentId":"agreement-2","sourceId":"files:example","documentType":"file","title":"Equipment agreement copy",
          "sourceCreatedAt":"2025-02-01T00:00:00Z","chunkText":"Equipment terms","score":0.8}
        ],"query":{"original":"equipment","effectiveText":"equipment"}}
        """#
        let response = try JSONDecoder().decode(SearchResponse.self, from: Data(raw.utf8))
        XCTAssertEqual(response.results.map(\.documentId), ["agreement-1", "agreement-2"])
        XCTAssertEqual(response.results.map(\.score), [0.9, 0.8])
        XCTAssertEqual(response.results.map(\.chunkText), ["Equipment terms", "Equipment terms"])
        XCTAssertEqual(response.query?.original, "equipment")
    }
}
