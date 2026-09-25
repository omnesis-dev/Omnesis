// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

/// Cross-surface tool-result contract — iOS half (epic #804, criterion C19).
///
/// Loads the SAME canonical, invented fixture the TS round-trip test and the
/// Android decode test load (`Fixtures/tool-result-contract.json`, a
/// byte-identical mirror of `packages/agent/src/__fixtures__/`), and asserts the
/// iOS `AgentToolResult` decoder reads every field this surface models off each
/// payload. The recurring "green-but-broken" bug this guards against is a field
/// the server projects that a client silently drops — the TS half proves the
/// server emits it; this half proves iOS doesn't drop the ones it renders.
///
/// iOS deliberately does NOT model a few wire fields (a DocRef's `refCount` /
/// `breadcrumb`, a record citation's `primaryKeyColumns` / `snapshot`); the
/// contract for those is forward-compatibility — the decoder must not choke on
/// them — which a successful decode of the full payload already proves.
@available(iOS 17.0, *)
final class ToolResultContractDecodeTests: XCTestCase {
    private struct Fixture: Decodable {
        struct Case: Decodable {
            let kind: String
            let wire: AgentToolResult
        }

        let cases: [Case]
    }

    private func loadFixture() throws -> Fixture {
        // Resolve the fixture relative to THIS test source file so it works from
        // any working directory (the macOS scratch checkout's ios/ tree).
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .appendingPathComponent("Fixtures/tool-result-contract.json")
        let data = try Data(contentsOf: url)
        return try JSONDecoder().decode(Fixture.self, from: data)
    }

    private func wire(_ kind: String, in fixture: Fixture) throws -> AgentToolResult {
        guard let c = fixture.cases.first(where: { $0.kind == kind }) else {
            throw XCTSkip("fixture has no case for kind '\(kind)'")
        }
        return c.wire
    }

    func test_fixture_decodes_every_case_without_falling_to_unknown() throws {
        let fixture = try loadFixture()
        XCTAssertGreaterThanOrEqual(fixture.cases.count, 7)
        for c in fixture.cases {
            if case .unknown = c.wire {
                XCTFail("case '\(c.kind)' decoded to .unknown — a modelled kind was dropped")
            }
        }
    }

    func test_search_results_fields_decode() throws {
        let fixture = try loadFixture()
        guard case .searchResults(let query, let durationMs, let candidates, let results) =
            try wire("search.results", in: fixture)
        else { return XCTFail("not search.results") }
        XCTAssertEqual(query, "quarterly budget review")
        XCTAssertEqual(durationMs, 18.5, accuracy: 0.001)
        XCTAssertEqual(candidates, 42)
        XCTAssertEqual(results.count, 2)
        let top = results[0]
        XCTAssertEqual(top.documentId, "doc-budget-001")
        XCTAssertEqual(top.sourceType, "demo-mail")
        XCTAssertEqual(top.title, "Q4 budget review agenda")
        XCTAssertEqual(top.mimeType, "text/plain")
        XCTAssertEqual(top.people, ["Maya Reeves", "Jamie Lopez"])
        XCTAssertEqual(top.unitName, "emails")
        XCTAssertEqual(top.appUrl, "demomail://message/doc-budget-001")
        // ts is epoch-ms on the wire, decoded as a Double.
        XCTAssertEqual(top.ts ?? 0, 1_717_200_000_000, accuracy: 1)
    }

    func test_document_fields_decode() throws {
        let fixture = try loadFixture()
        guard case .document(let ref, let content, let neighbors) =
            try wire("document", in: fixture)
        else { return XCTFail("not document") }
        XCTAssertEqual(ref.documentId, "doc-budget-001")
        XCTAssertEqual(content, "Hi Jamie, here is the agenda for the quarterly budget review.")
        XCTAssertEqual(neighbors.count, 1)
        XCTAssertEqual(neighbors[0].documentId, "doc-budget-002")
        XCTAssertEqual(neighbors[0].mimeType, "application/vnd.ms-excel")
    }

    func test_person_results_fields_decode() throws {
        let fixture = try loadFixture()
        guard case .personResults(let query, let durationMs, let results) =
            try wire("person.results", in: fixture)
        else { return XCTFail("not person.results") }
        XCTAssertEqual(query, "maya")
        XCTAssertEqual(durationMs, 4.25, accuracy: 0.001)
        XCTAssertEqual(results.count, 1)
        let p = results[0]
        XCTAssertEqual(p.canonicalId, "person-maya-reeves")
        XCTAssertEqual(p.displayName, "Maya Reeves")
        XCTAssertEqual(p.aliases.count, 3)
        XCTAssertEqual(p.emailCount, 31)
        XCTAssertEqual(p.interactionScore ?? 0, 0.84, accuracy: 0.001)
    }

    func test_annotate_recorded_fields_decode() throws {
        let fixture = try loadFixture()
        guard case .annotateRecorded(let documentId, let ref, let quote, let note, let quoteAuthor, let quoteIsSelf) =
            try wire("annotate.recorded", in: fixture)
        else { return XCTFail("not annotate.recorded") }
        XCTAssertEqual(documentId, "doc-budget-001")
        XCTAssertEqual(ref.documentId, "doc-budget-001")
        XCTAssertEqual(quote, "We agreed to revisit the travel line item.")
        XCTAssertEqual(note, "Key decision on the travel budget.")
        XCTAssertEqual(quoteAuthor, "You")
        XCTAssertTrue(quoteIsSelf, "self-authored quote orientation must decode")
    }

    func test_cite_record_recorded_fields_decode() throws {
        let fixture = try loadFixture()
        guard case .citeRecordRecorded(let record) =
            try wire("cite_record.recorded", in: fixture)
        else { return XCTFail("not cite_record.recorded") }
        // cite_record decodes straight into the shared AgentTrailRecord render
        // payload; primaryKeyColumns / snapshot are intentionally not modelled
        // (a successful decode proves iOS tolerates the extra keys).
        XCTAssertEqual(record.recordKey, "row:demo_transactions:txn-7781")
        XCTAssertEqual(record.table, "demo_transactions")
        XCTAssertEqual(record.tableDisplayName, "Demo Transactions")
        XCTAssertEqual(record.title, "Stellar Sound — 42.00")
        XCTAssertEqual(record.semanticTime, "2026-05-23T10:00:00.000Z")
        XCTAssertEqual(record.sourceId, "demo-bank:checking")
        XCTAssertEqual(record.sourceType, "demo-bank")
        XCTAssertEqual(record.boundDocumentId, "doc-receipt-7781")
        // Mixed-type key field values coerce to display strings; explicit null → nil.
        XCTAssertEqual(record.keyFields.count, 4)
        XCTAssertEqual(record.keyFields[0].value, "Stellar Sound")
        XCTAssertEqual(record.keyFields[2].value, "true")
        XCTAssertNil(record.keyFields[3].value)
    }

    func test_event_trail_built_deduped_doc_plus_record_decodes() throws {
        let fixture = try loadFixture()
        guard case .eventTrailBuilt(let seeds, let events, let truncated, _) =
            try wire("event_trail.built", in: fixture)
        else { return XCTFail("not event_trail.built") }
        XCTAssertEqual(seeds, ["doc-receipt-7781"])
        XCTAssertFalse(truncated)
        XCTAssertEqual(events.count, 1)
        let ev = events[0]
        XCTAssertEqual(ev.doc?.documentId, "doc-receipt-7781")
        // Deduped doc+record event: both present, the doc wins the entity id.
        XCTAssertEqual(ev.record?.recordKey, "row:demo_transactions:txn-7781")
        XCTAssertEqual(ev.entityId, "doc-receipt-7781")
        XCTAssertEqual(ev.people.count, 1)
        XCTAssertEqual(ev.people[0].name, "Maya Reeves")
        XCTAssertEqual(ev.related.count, 1)
        XCTAssertEqual(ev.related[0].linkType, "near-duplicate")
        XCTAssertEqual(ev.related[0].direction, "peer")
    }

    func test_sql_rows_fields_decode() throws {
        let fixture = try loadFixture()
        guard case .sqlRows(let sql, let columns, let rows, let rowCount, let truncated, let durationMs, let sources, let subjects) =
            try wire("sql.rows", in: fixture)
        else { return XCTFail("not sql.rows") }
        XCTAssertTrue(sql.contains("demo_transactions"))
        XCTAssertEqual(columns, ["id", "merchant", "amount"])
        XCTAssertEqual(rows.count, 2)
        XCTAssertEqual(rowCount, 2)
        XCTAssertFalse(truncated)
        XCTAssertEqual(durationMs, 2.75, accuracy: 0.001)
        XCTAssertEqual(sources.count, 1)
        XCTAssertEqual(sources[0].sourceId, "demo-bank:checking")
        XCTAssertEqual(sources[0].displayName, "Demo Bank")
        XCTAssertEqual(subjects, ["Demo Transactions"])
        // rowIdentities is not modelled by iOS (forward-compat) — a clean decode
        // of the full payload, with rows intact, is the contract here.
    }
}
