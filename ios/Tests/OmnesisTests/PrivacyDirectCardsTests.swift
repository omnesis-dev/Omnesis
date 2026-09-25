// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

/// The Direct static card mapping: every audited tool renders the same rows
/// the portal's `StaticToolCard` shows, unknown tools and result kinds keep a
/// generic header instead of dropping the row, and matched-but-empty results
/// read "No result".
final class PrivacyDirectCardsTests: XCTestCase {
    private func record(tool: String, args: JSONValue, result: JSONValue?) -> JSONValue {
        var fields: [String: JSONValue] = [
            "tool": .string(tool),
            "args": args,
            "outcome": .string("ok"),
        ]
        if let result { fields["result"] = result }
        return .object(fields)
    }

    private func docRef(id: String, sourceId: String = "gmail", title: String) -> JSONValue {
        .object([
            "documentId": .string(id),
            "sourceType": .string("email"),
            "sourceId": .string(sourceId),
            "title": .string(title),
        ])
    }

    // MARK: - Batch tools

    func testSearchBatchProjectsOneSectionPerChild() throws {
        let content = directCardContent(
            tool: "search_many",
            record: record(
                tool: "search_many",
                args: .object(["queries": .array([
                    .object(["query": .string("first")]),
                    .object(["query": .string("second")]),
                ])]),
                result: .object([
                    "kind": .string("search.batch"),
                    "items": .array([
                        .object([
                            "kind": .string("search.results"),
                            "query": .string("first"),
                            "results": .array([self.docRef(id: "doc_1", title: "First hit")]),
                        ]),
                        .object([
                            "kind": .string("error"),
                            "code": .string("search_failed"),
                            "message": .string("Search failed."),
                        ]),
                    ]),
                ])
            )
        )
        XCTAssertEqual(content.label, "Search")
        let sections = try XCTUnwrap(content.sections)
        XCTAssertEqual(sections.count, 2)
        XCTAssertEqual(sections[0].heading, "first")
        XCTAssertEqual(sections[0].rows.count, 1)
        XCTAssertEqual(sections[0].rows[0].title, "First hit")
        XCTAssertEqual(
            sections[0].rows[0].destination,
            .document(id: "doc_1", sourceId: "gmail", title: "First hit")
        )
        XCTAssertFalse(sections[0].showsEmpty)
        XCTAssertEqual(sections[1].heading, "second")
        XCTAssertEqual(sections[1].error, DirectCardError(code: "search_failed", message: "Search failed."))
        XCTAssertFalse(sections[1].showsEmpty)
    }

    func testSearchBatchChildWithoutHitsReadsNoResult() {
        let content = directCardContent(
            tool: "search_many",
            record: record(
                tool: "search_many",
                args: .object(["queries": .array([.object(["query": .string("nothing")])])]),
                result: .object([
                    "kind": .string("search.batch"),
                    "items": .array([
                        .object([
                            "kind": .string("search.results"),
                            "query": .string("nothing"),
                            "results": .array([]),
                        ]),
                    ]),
                ])
            )
        )
        XCTAssertEqual(content.sections?.count, 1)
        XCTAssertEqual(content.sections?.first?.rows, [])
        XCTAssertEqual(content.sections?.first?.showsEmpty, true)
    }

    func testFetchBatchRendersDocumentRows() throws {
        let content = directCardContent(
            tool: "fetch_many",
            record: record(
                tool: "fetch_many",
                args: .object(["documents": .array([.object(["documentId": .string("doc_1")])])]),
                result: .object([
                    "kind": .string("document.batch"),
                    "items": .array([
                        .object([
                            "kind": .string("document"),
                            "ref": self.docRef(id: "doc_1", title: "Opened doc"),
                        ]),
                    ]),
                ])
            )
        )
        let sections = try XCTUnwrap(content.sections)
        XCTAssertEqual(sections.count, 1)
        XCTAssertEqual(sections[0].rows.count, 1)
        XCTAssertEqual(sections[0].rows[0].title, "Opened doc")
        XCTAssertEqual(
            sections[0].rows[0].destination,
            .document(id: "doc_1", sourceId: "gmail", title: "Opened doc")
        )
    }

    // MARK: - URL lookup

    func testUrlLookupLinksHttpArgAndRendersRef() {
        let content = directCardContent(
            tool: "lookup_document_by_url",
            record: record(
                tool: "lookup_document_by_url",
                args: .object(["url": .string("https://example.com/plan")]),
                result: .object([
                    "kind": .string("document.byUrl"),
                    "url": .string("https://example.com/plan"),
                    "ref": self.docRef(id: "doc_1", title: "Plan"),
                ])
            )
        )
        XCTAssertEqual(content.label, "Look up URL")
        XCTAssertEqual(content.arg, "https://example.com/plan")
        XCTAssertEqual(content.argLink, .external(url: "https://example.com/plan"))
        XCTAssertEqual(content.rows.count, 1)
        XCTAssertFalse(content.showsEmpty)
    }

    func testUrlLookupWithoutMatchReadsNoResult() {
        let content = directCardContent(
            tool: "lookup_document_by_url",
            record: record(
                tool: "lookup_document_by_url",
                args: .object(["url": .string("https://example.com/missing")]),
                result: .object([
                    "kind": .string("document.byUrl"),
                    "url": .string("https://example.com/missing"),
                ])
            )
        )
        XCTAssertEqual(content.rows, [])
        XCTAssertTrue(content.showsEmpty)
    }

    func testNonHttpUrlStaysPlainText() {
        XCTAssertNil(directExternalDestination("ftp://example.com/plan"))
        XCTAssertNil(directExternalDestination("not a url"))
        XCTAssertNil(directExternalDestination(""))
        XCTAssertEqual(
            directExternalDestination("  https://example.com/plan  "),
            .external(url: "https://example.com/plan")
        )
    }

    // MARK: - People, trail, SQL

    func testPeopleResultsRenderLinkedRows() {
        let content = directCardContent(
            tool: "lookup_people",
            record: record(
                tool: "lookup_people",
                args: .object(["name": .string("Maya")]),
                result: .object([
                    "kind": .string("person.results"),
                    "query": .string("Maya"),
                    "results": .array([
                        .object([
                            "canonicalId": .string("person_1"),
                            "displayName": .string("Maya Reeves"),
                            "aliases": .array([.string("maya.reeves@example.com")]),
                        ]),
                    ]),
                ])
            )
        )
        XCTAssertEqual(content.label, "Look up people")
        XCTAssertEqual(content.arg, "Maya")
        XCTAssertEqual(content.rows.count, 1)
        XCTAssertEqual(content.rows[0].title, "Maya Reeves")
        XCTAssertEqual(
            content.rows[0].destination,
            .person(canonicalId: "person_1", name: "Maya Reeves")
        )
        XCTAssertFalse(content.showsEmpty)
    }

    func testPeopleResultsWithoutMatchesReadsNoResult() {
        let content = directCardContent(
            tool: "lookup_people",
            record: record(
                tool: "lookup_people",
                args: .object(["name": .string("Nobody")]),
                result: .object([
                    "kind": .string("person.results"),
                    "query": .string("Nobody"),
                    "results": .array([]),
                ])
            )
        )
        XCTAssertTrue(content.showsEmpty)
    }

    func testSqlRendersRowblock() throws {
        let content = directCardContent(
            tool: "run_sql",
            record: record(
                tool: "run_sql",
                args: .object(["sql": .string("SELECT  a\n  FROM t")]),
                result: .object([
                    "kind": .string("sql.rows"),
                    "sql": .string("SELECT a FROM t"),
                    "columns": .array([.string("a"), .string("b")]),
                    "rows": .array([
                        .array([.int(1), .string("x"), .bool(true)]),
                        .array([.int(2)]),
                    ]),
                    "rowCount": .int(12),
                ])
            )
        )
        XCTAssertEqual(content.label, "Run SQL")
        XCTAssertEqual(content.arg, "SELECT a FROM t")
        let block = try XCTUnwrap(content.sql)
        XCTAssertEqual(block.columns, ["a", "b"])
        XCTAssertEqual(block.rows, [["1", "x"], ["2", "null"]])
        XCTAssertEqual(block.totalRows, 12)
        XCTAssertFalse(content.showsEmpty)
    }

    func testSqlWithoutRowsReadsNoResult() {
        let content = directCardContent(
            tool: "run_sql",
            record: record(
                tool: "run_sql",
                args: .object(["sql": .string("SELECT a FROM t")]),
                result: .object([
                    "kind": .string("sql.rows"),
                    "sql": .string("SELECT a FROM t"),
                    "columns": .array([.string("a")]),
                    "rows": .array([]),
                    "rowCount": .int(0),
                ])
            )
        )
        XCTAssertTrue(content.showsEmpty)
    }

    // MARK: - Singular Answer verbs (stored agent transcripts)

    func testSingularSearchRendersRowsFromQueryArgs() {
        let content = directCardContent(
            tool: "search_documents",
            record: record(
                tool: "search_documents",
                args: .object(["query": .string("marathon")]),
                result: .object([
                    "kind": .string("search.results"),
                    "query": .string("marathon"),
                    "results": .array([self.docRef(id: "doc_1", title: "First hit")]),
                ])
            )
        )
        XCTAssertEqual(content.label, "Search")
        XCTAssertEqual(content.arg, "marathon")
        XCTAssertEqual(content.rows.count, 1)
        XCTAssertEqual(content.rows[0].title, "First hit")
        XCTAssertEqual(
            content.rows[0].destination,
            .document(id: "doc_1", sourceId: "gmail", title: "First hit")
        )
        XCTAssertFalse(content.showsEmpty)
    }

    func testSingularSearchWithoutHitsReadsNoResult() {
        let content = directCardContent(
            tool: "search_documents",
            record: record(
                tool: "search_documents",
                args: .object(["query": .string("nothing")]),
                result: .object([
                    "kind": .string("search.results"),
                    "query": .string("nothing"),
                    "results": .array([]),
                ])
            )
        )
        XCTAssertTrue(content.showsEmpty)
    }

    func testSingularSearchErrorUsesErrorCard() {
        let content = directCardContent(
            tool: "search_documents",
            record: record(
                tool: "search_documents",
                args: .object(["query": .string("marathon")]),
                result: .object([
                    "kind": .string("error"),
                    "code": .string("search_failed"),
                    "message": .string("Search failed."),
                ])
            )
        )
        XCTAssertEqual(content.label, "Search")
        XCTAssertEqual(content.error, DirectCardError(code: "search_failed", message: "Search failed."))
        XCTAssertFalse(content.showsEmpty)
    }

    func testSingularFetchRendersTheOpenedDocument() {
        let content = directCardContent(
            tool: "fetch_document",
            record: record(
                tool: "fetch_document",
                args: .object(["documentId": .string("doc_1")]),
                result: .object([
                    "kind": .string("document"),
                    "ref": self.docRef(id: "doc_1", title: "Opened doc"),
                ])
            )
        )
        XCTAssertEqual(content.label, "Open document")
        XCTAssertEqual(content.rows.count, 1)
        XCTAssertEqual(content.rows[0].title, "Opened doc")
        XCTAssertEqual(
            content.rows[0].destination,
            .document(id: "doc_1", sourceId: "gmail", title: "Opened doc")
        )
        XCTAssertFalse(content.showsEmpty)
    }

    func testSingularFetchErrorUsesErrorCard() {
        let content = directCardContent(
            tool: "fetch_document",
            record: record(
                tool: "fetch_document",
                args: .object(["documentId": .string("doc_1")]),
                result: .object([
                    "kind": .string("error"),
                    "code": .string("fetch_failed"),
                    "message": .string("Fetch failed."),
                ])
            )
        )
        XCTAssertEqual(content.error, DirectCardError(code: "fetch_failed", message: "Fetch failed."))
        XCTAssertFalse(content.showsEmpty)
    }
}

/// Batch transcript records become independent, ordered cards for each child.
final class PrivacyDirectCardSplitTests: XCTestCase {
    private func record(tool: String, args: JSONValue, result: JSONValue?) -> JSONValue {
        var fields: [String: JSONValue] = [
            "tool": .string(tool),
            "args": args,
            "outcome": .string("ok"),
        ]
        if let result { fields["result"] = result }
        return .object(fields)
    }

    private func docRef(id: String, sourceId: String = "gmail", title: String) -> JSONValue {
        .object([
            "documentId": .string(id),
            "sourceType": .string("email"),
            "sourceId": .string(sourceId),
            "title": .string(title),
        ])
    }

    private func searchBatchRecord() -> JSONValue {
        record(
            tool: "search_many",
            args: .object(["queries": .array([
                .object(["query": .string("first")]),
                .object(["query": .string("second")]),
            ])]),
            result: .object([
                "kind": .string("search.batch"),
                "items": .array([
                    .object([
                        "kind": .string("search.results"),
                        "query": .string("first"),
                        "results": .array([self.docRef(id: "doc_1", title: "First hit")]),
                    ]),
                    .object([
                        "kind": .string("error"),
                        "code": .string("search_failed"),
                        "message": .string("Search failed."),
                    ]),
                ]),
            ])
        )
    }

    func testSearchBatchSplitsIntoOneSearchCardPerChild() {
        let cards = directTranscriptCards(tool: "search_many", record: searchBatchRecord())
        XCTAssertEqual(cards.count, 2)
        XCTAssertEqual(cards[0].tool, "search_documents")
        XCTAssertEqual(cards[0].content.label, "Search")
        XCTAssertEqual(cards[0].content.arg, "first")
        XCTAssertEqual(cards[0].content.rows.map(\.title), ["First hit"])
        XCTAssertEqual(cards[1].tool, "search_documents")
        XCTAssertEqual(cards[1].content.arg, "second")
        XCTAssertEqual(
            cards[1].content.error,
            DirectCardError(code: "search_failed", message: "Search failed.")
        )
    }

    func testFetchBatchSplitsIntoOneOpenDocumentCardPerChild() {
        let cards = directTranscriptCards(
            tool: "fetch_many",
            record: record(
                tool: "fetch_many",
                args: .object(["documents": .array([
                    .object(["documentId": .string("doc_1")]),
                    .object(["documentId": .string("doc_2")]),
                ])]),
                result: .object([
                    "kind": .string("document.batch"),
                    "items": .array([
                        .object([
                            "kind": .string("document"),
                            "ref": self.docRef(id: "doc_1", title: "First doc"),
                        ]),
                        .object([
                            "kind": .string("document"),
                            "ref": self.docRef(id: "doc_2", title: ""),
                        ]),
                    ]),
                ])
            )
        )
        XCTAssertEqual(cards.count, 2)
        XCTAssertEqual(cards.map(\.tool), ["fetch_document", "fetch_document"])
        XCTAssertEqual(cards.map(\.content.label), ["Open document", "Open document"])
        XCTAssertEqual(cards[0].content.rows.map(\.title), ["First doc"])
        // An untitled document falls back to its requested id, as before.
        XCTAssertEqual(cards[1].content.rows.map(\.title), ["doc_2"])
    }

    func testUndecodableBatchKeepsItsSingleHeaderCard() {
        let cards = directTranscriptCards(
            tool: "fetch_many",
            record: record(tool: "fetch_many", args: .object([:]), result: nil)
        )
        XCTAssertEqual(cards.count, 1)
        XCTAssertEqual(cards[0].tool, "fetch_many")
    }

    func testSingularToolYieldsItsOwnCard() {
        let rec = record(tool: "run_sql", args: .object(["sql": .string("select 1")]), result: nil)
        let cards = directTranscriptCards(tool: "run_sql", record: rec)
        XCTAssertEqual(cards.count, 1)
        XCTAssertEqual(cards[0].tool, "run_sql")
        XCTAssertEqual(cards[0].content, directCardContent(tool: "run_sql", record: rec))
    }
}

/// Trail cards flatten linked documents and resolve their seed header.
final class PrivacyDirectTrailCardsTests: XCTestCase {
    private func record(tool: String, args: JSONValue, result: JSONValue?) -> JSONValue {
        var fields: [String: JSONValue] = [
            "tool": .string(tool),
            "args": args,
            "outcome": .string("ok"),
        ]
        if let result { fields["result"] = result }
        return .object(fields)
    }

    private func trailDoc(id: String) -> JSONValue {
        .object([
            "documentId": .string(id),
            "title": .string("Title \(id)"),
            "sourceId": .string("gmail"),
        ])
    }

    func testTrailFlattensAndDeduplicatesDocs() {
        let content = directCardContent(
            tool: "trace_connections",
            record: record(
                tool: "trace_connections",
                args: .object([:]),
                result: .object([
                    "kind": .string("event_trail.built"),
                    "seeds": .array([.string("doc_1")]),
                    "events": .array([
                        .object([
                            "eventId": .string("ev_1"),
                            "kind": .string("document"),
                            "doc": trailDoc(id: "doc_1"),
                            "attachments": .array([
                                .object([
                                    "eventId": .string("ev_1a"),
                                    "kind": .string("document"),
                                    "doc": trailDoc(id: "doc_2"),
                                    "attachments": .array([]),
                                    "people": .array([]),
                                    "related": .array([]),
                                ]),
                            ]),
                            "people": .array([]),
                            "related": .array([]),
                        ]),
                        .object([
                            "eventId": .string("ev_2"),
                            "kind": .string("document"),
                            "doc": trailDoc(id: "doc_1"),
                            "attachments": .array([]),
                            "people": .array([]),
                            "related": .array([]),
                        ]),
                    ]),
                ])
            )
        )
        XCTAssertEqual(content.label, "Trace connections")
        XCTAssertEqual(content.rows.map(\.title), ["Title doc_1", "Title doc_2"])
        XCTAssertFalse(content.showsEmpty)
        XCTAssertEqual(content.arg, "Title doc_1")
        XCTAssertEqual(content.argIcon, .document(sourceId: "gmail"))
    }

    func testTrailSeedsDisplayResolvesTitlesAndKeepsUnknownIds() {
        let decoded = directDecodeResult(
            record(
                tool: "trace_connections",
                args: .object(["seedIds": .array([.string("doc_1"), .string("doc_9")])]),
                result: .object([
                    "kind": .string("event_trail.built"),
                    "seeds": .array([.string("doc_1"), .string("doc_9")]),
                    "events": .array([
                        .object([
                            "eventId": .string("ev_1"),
                            "kind": .string("document"),
                            "doc": trailDoc(id: "doc_1"),
                            "attachments": .array([]),
                            "people": .array([]),
                            "related": .array([]),
                        ]),
                    ]),
                ])
            )
        )
        let display = directTrailSeedsDisplay(
            args: .object(["seedIds": .array([.string("doc_1"), .string("doc_9")])]),
            decoded: decoded
        )
        XCTAssertEqual(
            display,
            DirectSeedDisplay(icon: .document(sourceId: "gmail"), text: "Title doc_1, doc_9")
        )
    }

    func testTrailSeedsDisplayWithoutSeedsIsEmpty() {
        let display = directTrailSeedsDisplay(args: .object([:]), decoded: .missing)
        XCTAssertEqual(display, DirectSeedDisplay(icon: nil, text: ""))
    }
}
