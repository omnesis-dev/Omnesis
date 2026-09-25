// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

/// Covers `AgentTimelineBuilder.buildUnifiedTimeline(byDoc:records:)` —
/// the algorithm that turns the agent's explicit citations into one
/// chronological Timeline list. It is fed ONLY by `annotate` (the `byDoc`
/// bucket) and `cite_record` (the `records` bucket); a `trace_connections`
/// graph walk's raw output never reaches it. The Citations drawer's
/// Timeline tab projects this output verbatim.
///
/// Mirrors the portal-side coverage of `buildUnifiedTimeline` in
/// `packages/gateway/portal/js/views/agent-reducer.test.ts` so the two
/// platforms agree on the synthesis / dedup / sort rules.
@available(iOS 17.0, *)
final class AgentTimelineBuilderTests: XCTestCase {
    func testSameResourceUsesRepresentationVocabulary() {
        XCTAssertEqual(
            AgentTrailLinkFormat.phrase(linkType: "same-resource", direction: "out"),
            "another representation of"
        )
        XCTAssertTrue(AgentTrailLinkFormat.isDuplicateLike("same-resource"))
    }

    private func ms(_ iso: String) -> Double {
        ISO8601DateFormatter().date(from: iso).map { $0.timeIntervalSince1970 * 1000 } ?? 0
    }

    private func docRef(
        _ documentId: String,
        sourceType: String = "gmail",
        sourceId: String = "gmail:self",
        documentType: String? = "email",
        title: String? = nil,
        ts: Double? = nil,
        mimeType: String? = nil
    )
        -> AgentDocRef {
        AgentDocRef(
            documentId: documentId,
            sourceType: sourceType,
            sourceId: sourceId,
            documentType: documentType,
            title: title ?? documentId,
            ts: ts,
            mimeType: mimeType
        )
    }

    /// A byDoc slot as `annotate.recorded` would build it: a captured `ref`
    /// plus one quote. `ref: nil` models the (rare) case where no ref was
    /// captured.
    private func annotated(
        _ documentId: String,
        ts: Double? = nil,
        sourceType: String = "gmail",
        sourceId: String = "gmail:self",
        documentType: String? = "email",
        title: String? = nil,
        mimeType: String? = nil,
        withRef: Bool = true
    )
        -> AgentDocAnnotations {
        AgentDocAnnotations(
            ref: withRef ? docRef(
                documentId,
                sourceType: sourceType,
                sourceId: sourceId,
                documentType: documentType,
                title: title,
                ts: ts,
                mimeType: mimeType
            ) : nil,
            quotes: [AgentQuoteEntry(quote: "grounds a claim", note: nil, quoteAuthor: nil)]
        )
    }

    private func citedRecord(
        recordKey: String,
        semanticTime: String,
        title: String = "Morning run",
        boundDocumentId: String? = nil
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
            boundDocumentId: boundDocumentId
        )
    }

    // MARK: - Annotated documents

    func testReturnsEmptyListGivenNoAnnotationsAndNoRecords() {
        XCTAssertTrue(AgentTimelineBuilder.buildUnifiedTimeline(byDoc: [:]).isEmpty)
        XCTAssertTrue(AgentTimelineBuilder.buildUnifiedTimeline(byDoc: [:], records: []).isEmpty)
    }

    func testSynthesisesRowForAnnotatedDocument() {
        let byDoc: [String: AgentDocAnnotations] = [
            "d-orphan": annotated(
                "d-orphan",
                ts: 1_725_000_000_000,
                sourceType: "whatsapp-messages",
                sourceId: "whatsapp-messages:self",
                documentType: "conversation",
                title: "Lone WhatsApp thread"
            ),
        ]
        let merged = AgentTimelineBuilder.buildUnifiedTimeline(byDoc: byDoc)
        XCTAssertEqual(merged.count, 1)
        XCTAssertEqual(merged[0].eventId, "synth:doc:d-orphan")
        XCTAssertEqual(merged[0].kind, "document")
        XCTAssertEqual(merged[0].doc?.documentId, "d-orphan")
        XCTAssertEqual(merged[0].doc?.sourceId, "whatsapp-messages:self")
        XCTAssertEqual(merged[0].doc?.title, "Lone WhatsApp thread")
        XCTAssertNotNil(merged[0].at)
        XCTAssertTrue(merged[0].at?.starts(with: "20") ?? false)
        XCTAssertTrue(merged[0].attachments.isEmpty)
        XCTAssertTrue(merged[0].people.isEmpty)
        XCTAssertTrue(merged[0].related.isEmpty)
    }

    func testSynthesisedRowCarriesMimeTypeFromRefForFileTypeIcon() {
        let byDoc: [String: AgentDocAnnotations] = [
            "d-pdf": annotated(
                "d-pdf",
                ts: 1_725_000_000_000,
                sourceType: "gdrive",
                sourceId: "gdrive:self",
                documentType: "file",
                title: "Q4 Budget Review.pdf",
                mimeType: "application/pdf"
            ),
        ]
        let merged = AgentTimelineBuilder.buildUnifiedTimeline(byDoc: byDoc)
        XCTAssertEqual(merged.count, 1)
        XCTAssertEqual(merged[0].doc?.mimeType, "application/pdf")
    }

    func testOrdersAnnotatedDocumentsChronologicallyByRefTimestamp() {
        let byDoc: [String: AgentDocAnnotations] = [
            "d-b": annotated("d-b", ts: ms("2025-09-04T10:00:00Z")),
            "d-a": annotated("d-a", ts: ms("2025-09-01T09:00:00Z")),
            "d-c": annotated("d-c", ts: ms("2025-09-08T18:00:00Z")),
        ]
        let merged = AgentTimelineBuilder.buildUnifiedTimeline(byDoc: byDoc)
        XCTAssertEqual(merged.map { $0.doc?.documentId }, ["d-a", "d-b", "d-c"])
    }

    func testPlacesUndatedAnnotatedDocsAfterDatedOnesDeterministically() {
        let byDoc: [String: AgentDocAnnotations] = [
            "d-dated": annotated("d-dated", ts: ms("2025-09-01T00:00:00Z")),
            "d-undated-2": annotated("d-undated-2", ts: nil),
            "d-undated-1": annotated("d-undated-1", ts: nil),
        ]
        let merged = AgentTimelineBuilder.buildUnifiedTimeline(byDoc: byDoc)
        XCTAssertEqual(
            merged.map { $0.doc?.documentId },
            ["d-dated", "d-undated-1", "d-undated-2"]
        )
    }

    func testCannotSynthesiseRowWithoutARefSilentSkip() {
        let byDoc: [String: AgentDocAnnotations] = [
            "d-no-ref": annotated("d-no-ref", withRef: false),
        ]
        XCTAssertTrue(AgentTimelineBuilder.buildUnifiedTimeline(byDoc: byDoc).isEmpty)
    }

    // MARK: - Directly-cited records (cite_record, #757)

    func testKeepsCitedRecordAsRecordOnlyRow() {
        let merged = AgentTimelineBuilder.buildUnifiedTimeline(
            byDoc: [:],
            records: [citedRecord(recordKey: "row:fitness.workouts:42", semanticTime: "2025-09-04T07:30:00Z")]
        )
        XCTAssertEqual(merged.count, 1)
        XCTAssertNil(merged[0].doc)
        XCTAssertEqual(merged[0].kind, "record")
        XCTAssertEqual(merged[0].eventId, "cite:row:fitness.workouts:42")
        XCTAssertEqual(merged[0].record?.recordKey, "row:fitness.workouts:42")
    }

    func testInterleavesAnnotatedDocsWithCitedRecordsBySemanticTime() {
        let byDoc: [String: AgentDocAnnotations] = [
            "d-late": annotated("d-late", ts: ms("2025-09-08T18:00:00Z")),
            "d-early": annotated("d-early", ts: ms("2025-09-01T09:00:00Z")),
        ]
        let records = [citedRecord(recordKey: "row:fitness.workouts:1", semanticTime: "2025-09-02T07:00:00Z")]
        let merged = AgentTimelineBuilder.buildUnifiedTimeline(byDoc: byDoc, records: records)
        XCTAssertEqual(
            merged.map { $0.doc?.documentId ?? $0.record?.recordKey },
            ["d-early", "row:fitness.workouts:1", "d-late"]
        )
    }

    func testDedupsCitedRecordByRecordKeyFirstWins() {
        let merged = AgentTimelineBuilder.buildUnifiedTimeline(
            byDoc: [:],
            records: [
                citedRecord(recordKey: "row:k:1", semanticTime: "2025-09-02T07:00:00Z", title: "first"),
                citedRecord(recordKey: "row:k:1", semanticTime: "2025-09-02T07:00:00Z", title: "dup"),
            ]
        )
        XCTAssertEqual(merged.count, 1)
        XCTAssertEqual(merged[0].record?.title, "first")
    }
}

/// The behavioural regression net: driving the real `AgentCoordinator`
/// reducer, a `trace_connections` (`event_trail.built`) tool result must
/// contribute NO documents to the side-panel Timeline — only `annotate`
/// does. The iOS analog of the portal reducer test of the same name.
@available(iOS 17.0, *)
@MainActor
final class AgentTimelineCoordinatorTests: XCTestCase {
    private func makeCoordinator() -> AgentCoordinator {
        let coord = AgentCoordinator()
        coord.installPreviewState(
            sessionId: "sess-1",
            model: "m",
            backend: "b",
            title: "test",
            turns: [],
            citations: [],
            conversations: []
        )
        return coord
    }

    private func walkedEvent(_ documentId: String) -> AgentTrailEvent {
        AgentTrailEvent(
            eventId: "evt-\(documentId)",
            at: "2025-09-01T00:00:00Z",
            kind: "document",
            doc: AgentTrailEventDoc(
                documentId: documentId,
                title: "walked",
                sourceId: "gmail:self",
                sourceUrl: nil,
                appUrl: nil,
                documentType: "email",
                mimeType: nil
            ),
            attachments: [],
            people: [],
            related: []
        )
    }

    func testTraceConnectionsResultContributesNothingToTimeline() async {
        let coord = makeCoordinator()
        await coord.applyEventForTesting(.messageStart(sessionId: "sess-1", messageId: "msg-1"))

        // Annotate one doc → it becomes the sole Timeline row.
        await coord.applyEventForTesting(.toolInputStart(
            sessionId: "sess-1", messageId: "msg-1", toolCallId: "tc-ann", tool: "annotate"
        ))
        await coord.applyEventForTesting(.toolStart(
            sessionId: "sess-1", messageId: "msg-1", toolCallId: "tc-ann", tool: "annotate",
            args: JSONAny(value: ["documentId": "d-1", "note": "matters"] as [String: Any]),
            argsSummary: nil
        ))
        await coord.applyEventForTesting(.toolResult(
            sessionId: "sess-1", messageId: "msg-1", toolCallId: "tc-ann",
            result: .annotateRecorded(
                documentId: "d-1",
                ref: AgentDocRef(
                    documentId: "d-1",
                    sourceType: "gmail",
                    sourceId: "gmail:self",
                    ts: 1_725_300_000_000
                ),
                quote: nil,
                note: "matters",
                quoteAuthor: nil,
                quoteIsSelf: false
            ),
            durationMs: 1
        ))

        // A trace_connections walk surfaces another doc (d-x) — it must NOT
        // reach the Timeline.
        await coord.applyEventForTesting(.toolInputStart(
            sessionId: "sess-1", messageId: "msg-1", toolCallId: "tc-trail", tool: "trace_connections"
        ))
        await coord.applyEventForTesting(.toolStart(
            sessionId: "sess-1", messageId: "msg-1", toolCallId: "tc-trail", tool: "trace_connections",
            args: JSONAny(value: ["seedIds": ["d-1"]] as [String: Any]),
            argsSummary: nil
        ))
        await coord.applyEventForTesting(.toolResult(
            sessionId: "sess-1", messageId: "msg-1", toolCallId: "tc-trail",
            result: .eventTrailBuilt(
                seeds: ["d-1"],
                events: [walkedEvent("d-x")],
                truncated: false,
                stats: nil
            ),
            durationMs: 1
        ))

        let timeline = AgentTimelineBuilder.buildUnifiedTimeline(
            byDoc: coord.trailAnnotations.byDoc,
            records: coord.recordCitations
        )
        // Only the annotated doc — the walked doc (d-x) is absent.
        XCTAssertEqual(
            timeline.compactMap { $0.doc?.documentId ?? $0.record?.recordKey },
            ["d-1"]
        )
        // The graph walk's output never landed in the annotation bucket.
        XCTAssertEqual(Set(coord.trailAnnotations.byDoc.keys), ["d-1"])
        XCTAssertTrue(coord.recordCitations.isEmpty)
    }
}
