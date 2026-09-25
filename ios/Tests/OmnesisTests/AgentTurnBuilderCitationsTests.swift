// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

/// Covers `AgentTurnBuilder.citations(from:)` and
/// `AgentTurnBuilder.trailAnnotations(from:)` — the two static helpers
/// that reconstruct the Citations rollup and the unified-Timeline
/// `byDoc` bucket from a persisted transcript on conversation resume.
///
/// Mirrors the portal-side coverage in
/// `packages/gateway/portal/js/views/agent-reducer.test.ts` so the two
/// platforms paint the same citations/annotations on the same history.
@available(iOS 17.0, *)
final class AgentTurnBuilderCitationsTests: XCTestCase {
    private func docRef(_ id: String, sourceId: String = "gmail:me") -> AgentDocRef {
        AgentDocRef(documentId: id, sourceType: "gmail", sourceId: sourceId)
    }

    // MARK: - citations(from:)

    /// An `annotate` tool_use followed by its `annotate.recorded`
    /// tool_result appends one entry under the doc's citation card.
    func testCitationsAggregatesAnnotateHappyPath() {
        let ref = docRef("d-1")
        let messages: [ChatMessage] = [
            .user(parts: [.text("anything?")]),
            .assistant(parts: [
                .toolUse(
                    toolCallId: "tc-1",
                    tool: "annotate",
                    args: JSONAny(value: ["documentId": "d-1", "quote": "shipped"] as [String: Any])
                ),
            ]),
            .user(parts: [
                .toolResult(
                    toolCallId: "tc-1",
                    result: .annotateRecorded(
                        documentId: "d-1",
                        ref: ref,
                        quote: "shipped",
                        note: nil,
                        quoteAuthor: nil,
                        quoteIsSelf: false
                    )
                ),
            ]),
            .assistant(parts: [.text("yes.")]),
        ]

        let cits = AgentTurnBuilder.citations(from: messages)

        XCTAssertEqual(cits.count, 1)
        XCTAssertEqual(cits[0].documentId, "d-1")
        XCTAssertEqual(cits[0].entries.count, 1)
        XCTAssertEqual(cits[0].entries[0].quote, "shipped")
        XCTAssertNil(cits[0].docNote)
    }

    /// Search-result and fetched-document tool_results must NOT
    /// populate the citations panel — only explicit `annotate.recorded`
    /// does. Mirrors agent-reducer.test.ts "does NOT include search
    /// hits or fetched docs".
    func testCitationsIgnoresSearchAndFetchResults() {
        let messages: [ChatMessage] = [
            .user(parts: [
                .toolResult(
                    toolCallId: "a",
                    result: .searchResults(
                        query: "x",
                        durationMs: 0,
                        candidates: nil,
                        results: [docRef("d-1")]
                    )
                ),
                .toolResult(
                    toolCallId: "b",
                    result: .document(ref: docRef("d-2"), content: nil, neighbors: [])
                ),
            ]),
        ]

        XCTAssertTrue(AgentTurnBuilder.citations(from: messages).isEmpty)
    }

    /// A quote annotate appends to `entries`; a note-only annotate sets
    /// the card's `docNote`. The two land on the same card.
    func testCitationsRoutesNoteOnlyToDocNoteAndQuoteToEntries() {
        let ref = docRef("d-1")
        let messages: [ChatMessage] = [
            .user(parts: [.text("anything?")]),
            .assistant(parts: [
                .toolUse(
                    toolCallId: "tc-q",
                    tool: "annotate",
                    args: JSONAny(value: ["documentId": "d-1", "quote": "shipped"] as [String: Any])
                ),
                .toolUse(
                    toolCallId: "tc-n",
                    tool: "annotate",
                    args: JSONAny(value: ["documentId": "d-1", "note": "canonical"] as [String: Any])
                ),
            ]),
            .user(parts: [
                .toolResult(
                    toolCallId: "tc-q",
                    result: .annotateRecorded(
                        documentId: "d-1",
                        ref: ref,
                        quote: "shipped",
                        note: nil,
                        quoteAuthor: nil,
                        quoteIsSelf: false
                    )
                ),
                .toolResult(
                    toolCallId: "tc-n",
                    result: .annotateRecorded(
                        documentId: "d-1",
                        ref: ref,
                        quote: nil,
                        note: "the canonical record",
                        quoteAuthor: nil,
                        quoteIsSelf: false
                    )
                ),
            ]),
        ]

        let cits = AgentTurnBuilder.citations(from: messages)
        XCTAssertEqual(cits.count, 1)
        XCTAssertEqual(cits[0].docNote, "the canonical record")
        XCTAssertEqual(cits[0].entries.count, 1)
        XCTAssertEqual(cits[0].entries[0].quote, "shipped")
    }

    /// Two successive note-only annotates on the same doc: the LAST
    /// one wins for `docNote` (no entries appended either way).
    func testCitationsLastNoteOnlyWinsForDocNote() {
        let ref = docRef("d-1")
        let messages: [ChatMessage] = [
            .assistant(parts: [
                .toolUse(toolCallId: "n1", tool: "annotate", args: JSONAny(value: [:] as [String: Any])),
                .toolUse(toolCallId: "n2", tool: "annotate", args: JSONAny(value: [:] as [String: Any])),
            ]),
            .user(parts: [
                .toolResult(toolCallId: "n1", result: .annotateRecorded(
                    documentId: "d-1", ref: ref, quote: nil, note: "first", quoteAuthor: nil, quoteIsSelf: false
                )),
                .toolResult(toolCallId: "n2", result: .annotateRecorded(
                    documentId: "d-1", ref: ref, quote: nil, note: "second", quoteAuthor: nil, quoteIsSelf: false
                )),
            ]),
        ]

        let cits = AgentTurnBuilder.citations(from: messages)
        XCTAssertEqual(cits.count, 1)
        XCTAssertEqual(cits[0].docNote, "second")
        XCTAssertTrue(cits[0].entries.isEmpty)
    }

    // MARK: - trailAnnotations(from:)

    /// The first `annotate.recorded` for a documentId captures its
    /// `ref` into `byDoc[docId]` — the unified-Timeline synthesiser
    /// reads it to fabricate the document's row. Subsequent annotates
    /// on the same docId must not overwrite the captured ref.
    func testTrailAnnotationsCapturesRefOnFirstAnnotate() {
        let firstRef = AgentDocRef(
            documentId: "d-1",
            sourceType: "gmail",
            sourceId: "gmail:me",
            title: "Original"
        )
        let secondRef = AgentDocRef(
            documentId: "d-1",
            sourceType: "gmail",
            sourceId: "gmail:me",
            title: "Different"
        )
        let messages: [ChatMessage] = [
            .user(parts: [
                .toolResult(toolCallId: "tc-1", result: .annotateRecorded(
                    documentId: "d-1", ref: firstRef, quote: "first", note: nil, quoteAuthor: nil, quoteIsSelf: false
                )),
                .toolResult(toolCallId: "tc-2", result: .annotateRecorded(
                    documentId: "d-1", ref: secondRef, quote: "second", note: nil, quoteAuthor: nil, quoteIsSelf: false
                )),
            ]),
        ]

        let ann = AgentTurnBuilder.trailAnnotations(from: messages)
        XCTAssertEqual(
            ann.byDoc["d-1"]?.ref?.title,
            "Original",
            "first ref must win — later annotates do not overwrite"
        )
        XCTAssertEqual(ann.byDoc["d-1"]?.quotes.count, 2)
    }

    /// `quoteAuthor` rides through to the `AgentQuoteEntry` so the
    /// Timeline view can colour-code chat-bubble quotes by author.
    func testTrailAnnotationsCapturesQuoteAuthorInQuotes() {
        let ref = docRef("d-1")
        let messages: [ChatMessage] = [
            .user(parts: [
                .toolResult(toolCallId: "tc-1", result: .annotateRecorded(
                    documentId: "d-1",
                    ref: ref,
                    quote: "the relevant bit",
                    note: nil,
                    quoteAuthor: "Maya",
                    quoteIsSelf: false
                )),
            ]),
        ]

        let ann = AgentTurnBuilder.trailAnnotations(from: messages)
        XCTAssertEqual(ann.byDoc["d-1"]?.quotes.count, 1)
        XCTAssertEqual(ann.byDoc["d-1"]?.quotes[0].quote, "the relevant bit")
        XCTAssertEqual(ann.byDoc["d-1"]?.quotes[0].quoteAuthor, "Maya")
    }

    /// `quoteIsSelf` rides through to the `AgentQuoteEntry` so the
    /// Timeline view can render self-authored quotes as sent bubbles.
    func testTrailAnnotationsCapturesQuoteIsSelfInQuotes() {
        let ref = docRef("d-1")
        let messages: [ChatMessage] = [
            .user(parts: [
                .toolResult(toolCallId: "tc-1", result: .annotateRecorded(
                    documentId: "d-1",
                    ref: ref,
                    quote: "my own words",
                    note: nil,
                    quoteAuthor: "You",
                    quoteIsSelf: true
                )),
                .toolResult(toolCallId: "tc-2", result: .annotateRecorded(
                    documentId: "d-1",
                    ref: ref,
                    quote: "their words",
                    note: nil,
                    quoteAuthor: "Maya",
                    quoteIsSelf: false
                )),
            ]),
        ]

        let ann = AgentTurnBuilder.trailAnnotations(from: messages)
        XCTAssertEqual(ann.byDoc["d-1"]?.quotes.count, 2)
        XCTAssertEqual(ann.byDoc["d-1"]?.quotes[0].quoteIsSelf, true)
        XCTAssertEqual(ann.byDoc["d-1"]?.quotes[1].quoteIsSelf, false)
    }

    /// The citations rollup also threads `quoteIsSelf` onto each entry
    /// (the Citations drawer reads it alongside the Timeline tab).
    func testCitationsCaptureQuoteIsSelf() {
        let ref = docRef("d-1")
        let messages: [ChatMessage] = [
            .assistant(parts: [
                .toolUse(
                    toolCallId: "tc-1",
                    tool: "annotate",
                    args: JSONAny(value: ["documentId": "d-1", "quote": "mine"] as [String: Any])
                ),
            ]),
            .user(parts: [
                .toolResult(toolCallId: "tc-1", result: .annotateRecorded(
                    documentId: "d-1",
                    ref: ref,
                    quote: "mine",
                    note: nil,
                    quoteAuthor: "You",
                    quoteIsSelf: true
                )),
            ]),
        ]

        let cits = AgentTurnBuilder.citations(from: messages)
        XCTAssertEqual(cits.count, 1)
        XCTAssertEqual(cits[0].entries.count, 1)
        XCTAssertEqual(cits[0].entries[0].quoteIsSelf, true)
    }

    /// A note-only annotate sets the slot's `note` (no quotes appended).
    func testTrailAnnotationsNoteOnlySetsSlotNote() {
        let ref = docRef("d-1")
        let messages: [ChatMessage] = [
            .user(parts: [
                .toolResult(toolCallId: "tc-1", result: .annotateRecorded(
                    documentId: "d-1", ref: ref, quote: nil, note: "matters", quoteAuthor: nil, quoteIsSelf: false
                )),
            ]),
        ]

        let ann = AgentTurnBuilder.trailAnnotations(from: messages)
        XCTAssertEqual(ann.byDoc["d-1"]?.note, "matters")
        XCTAssertTrue(ann.byDoc["d-1"]?.quotes.isEmpty ?? false)
    }

    // MARK: - recordCitations(from:) (#757)

    private func citedRecord(
        recordKey: String,
        title: String = "Morning run",
        semanticTime: String = "2026-04-20T07:12:00Z"
    )
        -> AgentTrailRecord {
        AgentTrailRecord(
            recordKey: recordKey,
            table: "demo_fitness.workouts",
            tableDisplayName: "Workouts",
            title: title,
            keyFields: [AgentTrailRecordKeyField(label: "Distance", value: "5.2 km")],
            semanticTime: semanticTime,
            sourceId: "demo-fitness:athlete",
            sourceType: "demo-fitness",
            boundDocumentId: nil
        )
    }

    /// A `cite_record.recorded` tool_result in history rebuilds into the
    /// directly-cited record bucket on resume, so a reloaded
    /// conversation shows the record in the Timeline.
    func testRecordCitationsRebuildsFromHistory() {
        let messages: [ChatMessage] = [
            .user(parts: [.text("how far did I run?")]),
            .assistant(parts: [
                .toolUse(
                    toolCallId: "tc-1",
                    tool: "cite_record",
                    args: JSONAny(value: [:] as [String: Any])
                ),
            ]),
            .user(parts: [
                .toolResult(
                    toolCallId: "tc-1",
                    result: .citeRecordRecorded(record: citedRecord(recordKey: "demo_fitness.workouts/abc"))
                ),
            ]),
            .assistant(parts: [.text("5.2 km.")]),
        ]

        let records = AgentTurnBuilder.recordCitations(from: messages)
        XCTAssertEqual(records.count, 1)
        XCTAssertEqual(records[0].recordKey, "demo_fitness.workouts/abc")
        XCTAssertEqual(records[0].title, "Morning run")
    }

    /// A re-cite of the same row (same `recordKey`) dedups to one entry,
    /// last write wins, preserving the original arrival position.
    func testRecordCitationsDedupsByRecordKeyLastWins() {
        let messages: [ChatMessage] = [
            .user(parts: [
                .toolResult(toolCallId: "a", result: .citeRecordRecorded(
                    record: citedRecord(recordKey: "k1", title: "stale")
                )),
                .toolResult(toolCallId: "b", result: .citeRecordRecorded(
                    record: citedRecord(recordKey: "k2", title: "other")
                )),
                .toolResult(toolCallId: "c", result: .citeRecordRecorded(
                    record: citedRecord(recordKey: "k1", title: "fresh")
                )),
            ]),
        ]

        let records = AgentTurnBuilder.recordCitations(from: messages)
        XCTAssertEqual(records.map(\.recordKey), ["k1", "k2"])
        XCTAssertEqual(records[0].title, "fresh")
    }

    /// Annotate results (document citations) must NOT populate the
    /// record-citation bucket — only `cite_record.recorded` does.
    func testRecordCitationsIgnoresAnnotateResults() {
        let messages: [ChatMessage] = [
            .user(parts: [
                .toolResult(toolCallId: "a", result: .annotateRecorded(
                    documentId: "d-1", ref: docRef("d-1"),
                    quote: "shipped", note: nil, quoteAuthor: nil, quoteIsSelf: false
                )),
            ]),
        ]
        XCTAssertTrue(AgentTurnBuilder.recordCitations(from: messages).isEmpty)
    }
}
