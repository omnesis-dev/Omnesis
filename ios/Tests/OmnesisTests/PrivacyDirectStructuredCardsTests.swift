// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

/// Steward-tool and fallback arms of the Direct static card mapping:
/// loops, structured results, errors, unknown tools, and missing payloads.
final class PrivacyDirectStructuredCardsTests: XCTestCase {
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

    // MARK: - Loops and steward tools

    func testLoopsSearchedRendersLoopRows() {
        let content = directCardContent(
            tool: "search_loops",
            record: record(
                tool: "search_loops",
                args: .object(["query": .string("deposit")]),
                result: .object([
                    "kind": .string("loops.searched"),
                    "query": .string("deposit"),
                    "loops": .array([
                        .object([
                            "loopId": .string("loop_1"),
                            "title": .string("Pay the deposit"),
                            "state": .string("open"),
                        ]),
                    ]),
                ])
            )
        )
        XCTAssertEqual(content.rows.count, 1)
        XCTAssertEqual(content.rows[0].title, "Pay the deposit")
        XCTAssertEqual(content.rows[0].subtitle, "open")
        XCTAssertEqual(content.rows[0].destination, .loop(id: "loop_1"))
        XCTAssertFalse(content.showsEmpty)
    }

    func testStructuredListLoopsRendersRows() {
        let content = directCardContent(
            tool: "list_loops",
            record: record(
                tool: "list_loops",
                args: .object([:]),
                result: .object([
                    "kind": .string("structured"),
                    "resultType": .string("loops.listed"),
                    "data": .object(["loops": .array([
                        .object([
                            "loopId": .string("loop_1"),
                            "title": .string("Pay the deposit"),
                            "state": .string("open"),
                        ]),
                    ])]),
                ])
            )
        )
        XCTAssertEqual(content.rows.count, 1)
        XCTAssertEqual(content.rows[0].destination, .loop(id: "loop_1"))
        XCTAssertFalse(content.showsEmpty)
    }

    func testStructuredOpenLoopSearchNotesRetiredCount() {
        let content = directCardContent(
            tool: "open_loop_search",
            record: record(
                tool: "open_loop_search",
                args: .object(["query": .string("deposit")]),
                result: .object([
                    "kind": .string("structured"),
                    "resultType": .string("open_loop.search_results"),
                    "data": .object([
                        "loops": .array([]),
                        "retired": .int(2),
                    ]),
                ])
            )
        )
        XCTAssertEqual(content.rows, [])
        XCTAssertEqual(content.note, "2 retired")
        XCTAssertFalse(content.showsEmpty)
    }

    func testStructuredEntityContextGroupsRows() {
        let content = directCardContent(
            tool: "entity_context",
            record: record(
                tool: "entity_context",
                args: .object([:]),
                result: .object([
                    "kind": .string("structured"),
                    "resultType": .string("entity_context.reaped"),
                    "data": .object([
                        "documents": .array([
                            .object([
                                "documentId": .string("doc_1"),
                                "title": .string("A doc"),
                                "sourceId": .string("gmail"),
                            ]),
                        ]),
                        "people": .array([
                            .object(["personId": .string("person_1"), "name": .string("Maya Reeves")]),
                        ]),
                        "loops": .array([
                            .object([
                                "loopId": .string("loop_1"),
                                "title": .string("Pay the deposit"),
                                "state": .string("open"),
                            ]),
                        ]),
                        "temporalAnnotations": .array([
                            .object(["sentence": .string("Paid on Friday")]),
                        ]),
                    ]),
                ])
            )
        )
        XCTAssertEqual(content.rows.count, 4)
        XCTAssertEqual(
            content.rows[0].destination,
            .document(id: "doc_1", sourceId: "gmail", title: "A doc")
        )
        XCTAssertEqual(
            content.rows[1].destination,
            .person(canonicalId: "person_1", name: "Maya Reeves")
        )
        XCTAssertEqual(content.rows[2].destination, .loop(id: "loop_1"))
        XCTAssertNil(content.rows[3].destination)
        XCTAssertFalse(content.showsEmpty)
    }

    func testStructuredEntityContextNamesItsEntityInTheHeader() {
        let content = directCardContent(
            tool: "entity_context",
            record: record(
                tool: "entity_context",
                args: .object(["kind": .string("person"), "id": .string("person_1")]),
                result: .object([
                    "kind": .string("structured"),
                    "resultType": .string("entity_context.reaped"),
                    "data": .object(["people": .array([])]),
                ])
            )
        )
        XCTAssertEqual(content.label, "Entity context")
        XCTAssertEqual(content.arg, "person person_1")
    }

    func testStructuredEntityContextShowsSeedIconAndTitle() {
        let data = JSONValue.object([
            "seed": .object([
                "kind": .string("document"),
                "id": .string("doc_1"),
                "label": .string("First doc"),
            ]),
            "documents": .array([
                .object(["documentId": .string("doc_1"), "sourceId": .string("gmail"), "title": .string("First doc")]),
            ]),
            "people": .array([]),
        ])
        let display = directEntitySeedDisplay(
            args: .object(["kind": .string("document"), "id": .string("doc_1")]),
            data: data
        )
        XCTAssertEqual(display, DirectSeedDisplay(icon: .document(sourceId: "gmail"), text: "First doc"))
        let content = directCardContent(
            tool: "entity_context",
            record: record(
                tool: "entity_context",
                args: .object(["kind": .string("document"), "id": .string("doc_1")]),
                result: .object([
                    "kind": .string("structured"),
                    "resultType": .string("entity_context.reaped"),
                    "data": data,
                ])
            )
        )
        XCTAssertEqual(content.arg, "First doc")
        XCTAssertEqual(content.argIcon, .document(sourceId: "gmail"))
    }

    func testStructuredEntityContextWithoutSeedFallsBackToKindAndId() {
        let display = directEntitySeedDisplay(
            args: .object(["kind": .string("loop"), "id": .string("loop_9")]),
            data: .object(["loops": .array([])])
        )
        XCTAssertEqual(display, DirectSeedDisplay(icon: nil, text: "loop loop_9"))
    }

    func testStructuredEntityContextPersonSeedUsesPersonIcon() {
        let display = directEntitySeedDisplay(
            args: .object(["kind": .string("person"), "id": .string("person_1")]),
            data: .object([
                "seed": .object([
                    "kind": .string("person"),
                    "id": .string("person_1"),
                    "label": .string("Maya Reeves"),
                ]),
            ])
        )
        XCTAssertEqual(display, DirectSeedDisplay(icon: .person, text: "Maya Reeves"))
    }

    func testStructuredTemporalResultsRenderLabels() {
        let content = directCardContent(
            tool: "temporal_query",
            record: record(
                tool: "temporal_query",
                args: .object(["from": .string("2026-08-01"), "to": .string("2026-09-01")]),
                result: .object([
                    "kind": .string("structured"),
                    "resultType": .string("temporal.results"),
                    "data": .object(["items": .array([
                        .object(["label": .string("A moment")]),
                    ])]),
                ])
            )
        )
        XCTAssertEqual(content.arg, "2026-08-01 … 2026-09-01")
        XCTAssertEqual(content.rows.map(\.title), ["A moment"])
        XCTAssertFalse(content.showsEmpty)
    }

    // MARK: - Errors, unknown, missing

    func testErrorResultUsesErrorCardOnAnyTool() {
        let content = directCardContent(
            tool: "run_sql",
            record: record(
                tool: "run_sql",
                args: .object(["sql": .string("SELECT 1")]),
                result: .object([
                    "kind": .string("error"),
                    "code": .string("sql_failed"),
                    "message": .string("Binder Error."),
                ])
            )
        )
        XCTAssertEqual(content.error, DirectCardError(code: "sql_failed", message: "Binder Error."))
        XCTAssertFalse(content.showsEmpty)
    }

    func testUnknownToolKeepsAGenericHeader() {
        let content = directCardContent(
            tool: "future_tool",
            record: record(
                tool: "future_tool",
                args: .object([:]),
                result: .object(["kind": .string("future.kind")])
            )
        )
        XCTAssertEqual(content.label, "future_tool")
        XCTAssertEqual(content.rows, [])
        XCTAssertNil(content.error)
        XCTAssertFalse(content.showsEmpty)
    }

    func testMismatchedResultKindLeavesHeaderAlone() {
        let content = directCardContent(
            tool: "search_many",
            record: record(
                tool: "search_many",
                args: .object(["queries": .array([])]),
                result: .object([
                    "kind": .string("sql.rows"),
                    "sql": .string("SELECT 1"),
                    "columns": .array([]),
                    "rows": .array([]),
                    "rowCount": .int(0),
                ])
            )
        )
        XCTAssertNil(content.sections)
        XCTAssertEqual(content.rows, [])
        XCTAssertFalse(content.showsEmpty)
    }

    func testMissingResultDecodesAsMissing() {
        XCTAssertEqual(directDecodeResult(nil), .missing)
        XCTAssertEqual(
            directDecodeResult(.object(["tool": .string("fetch_many")])),
            .missing
        )
    }

    func testUndecodableResultKeepsAGenericHeader() {
        // A search.batch whose child breaks the typed contract: strict inner
        // decoding fails, so the card falls back instead of dropping the row.
        let content = directCardContent(
            tool: "search_many",
            record: record(
                tool: "search_many",
                args: .object(["queries": .array([])]),
                result: .object([
                    "kind": .string("search.batch"),
                    "items": .array([.object(["kind": .string("search.results")])]),
                ])
            )
        )
        XCTAssertNil(content.sections)
        XCTAssertFalse(content.showsEmpty)
    }
}
