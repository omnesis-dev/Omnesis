// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

/// Exercises the research working-set surface state (#748) in
/// `AgentCoordinator` — the iOS twin of the portal reducer's docs-accumulator
/// + `researchPanels` / `isResearchWorkspaceActive` selectors. Drives events
/// through `applyEventForTesting`, bypassing the live SSE stream, so the
/// per-researcher document accumulation, dedup, gating, collapse, and graceful
/// degrade can be observed in isolation. Mirrors the portal contract.
@available(iOS 17.0, *)
@MainActor
final class AgentCoordinatorResearchWorkspaceTests: XCTestCase {
    private func makeCoordinator() -> AgentCoordinator {
        let coord = AgentCoordinator()
        coord.installPreviewState(
            sessionId: "sess-1", model: "m", backend: "b", title: "t",
            turns: [], citations: [], conversations: []
        )
        return coord
    }

    private func ref(_ id: String, _ sourceId: String, title: String? = nil) -> AgentDocRef {
        AgentDocRef(
            documentId: id,
            sourceType: sourceId.components(separatedBy: ":").first ?? sourceId,
            sourceId: sourceId,
            title: title
        )
    }

    /// Open the parent turn and spawn `subagentId`.
    private func spawn(_ coord: AgentCoordinator, _ subagentId: String, specialist: String, task: String) async {
        if !coord.turns.contains(where: { if case .assistant = $0 { return true }
            return false
        }) {
            await coord.applyEventForTesting(.messageStart(sessionId: "sess-1", messageId: "msg-1"))
        }
        await coord.applyEventForTesting(.subagentSpawned(
            sessionId: "sess-1", subagentId: subagentId, specialist: specialist,
            task: task, parentToolCallId: "tu_\(subagentId)"
        ))
    }

    /// Feed a child tool result into `subagentId`'s nested stream.
    private func childResult(_ coord: AgentCoordinator, _ subagentId: String, toolCallId: String, _ result: AgentToolResult) async {
        await coord.applyEventForTesting(.subagentEvent(
            sessionId: "sess-1", subagentId: subagentId, specialist: "x",
            event: .messageStart(sessionId: subagentId, messageId: "\(subagentId).m")
        ))
        await coord.applyEventForTesting(.subagentEvent(
            sessionId: "sess-1", subagentId: subagentId, specialist: "x",
            event: .toolStart(
                sessionId: subagentId,
                messageId: "\(subagentId).m",
                toolCallId: toolCallId,
                tool: "search_documents",
                args: JSONAny(value: NSNull()),
                argsSummary: "q"
            )
        ))
        await coord.applyEventForTesting(.subagentEvent(
            sessionId: "sess-1", subagentId: subagentId, specialist: "x",
            event: .toolResult(
                sessionId: subagentId,
                messageId: "\(subagentId).m",
                toolCallId: toolCallId,
                result: result,
                durationMs: 3
            )
        ))
    }

    // MARK: - docsFromChildToolResult (pure)

    func testDocsExtractedFromSearchDocumentAndTrail() {
        let search: AgentToolResult = .searchResults(
            query: "q", durationMs: 1, candidates: 2,
            results: [ref("d1", "gmail:me"), ref("d2", "google-drive:me")]
        )
        XCTAssertEqual(AgentCoordinator.docsFromChildToolResult(search).map(\.documentId), ["d1", "d2"])

        let doc: AgentToolResult = .document(ref: ref("d3", "apple-notes:local"), content: nil, neighbors: [])
        XCTAssertEqual(AgentCoordinator.docsFromChildToolResult(doc).map(\.documentId), ["d3"])

        // Source identity rides the ref, not branched on a name.
        XCTAssertEqual(AgentCoordinator.docsFromChildToolResult(search).first?.sourceId, "gmail:me")
    }

    func testDocsEmptyForNonDocumentResults() {
        let sql: AgentToolResult = .sqlRows(
            sql: "SELECT 1",
            columns: [],
            rows: [],
            rowCount: 0,
            truncated: false,
            durationMs: 1,
            sources: [],
            subjects: []
        )
        XCTAssertTrue(AgentCoordinator.docsFromChildToolResult(sql).isEmpty)
        XCTAssertTrue(AgentCoordinator.docsFromChildToolResult(.planUpdated(items: [])).isEmpty)
        XCTAssertTrue(AgentCoordinator.docsFromChildToolResult(.error(code: "x", message: "y")).isEmpty)
    }

    // MARK: - Live accumulation + dedup, per-researcher (no cross-leak)

    func testEachResearcherAccumulatesItsOwnDocsNoCrossLeak() async {
        let coord = makeCoordinator()
        await spawn(coord, "sess-1.sub.a", specialist: "history-sweep", task: "A")
        await spawn(coord, "sess-1.sub.b", specialist: "source-digest", task: "B")
        await childResult(
            coord,
            "sess-1.sub.a",
            toolCallId: "ca",
            .searchResults(
                query: "q",
                durationMs: 1,
                candidates: 2,
                results: [ref("d1", "gmail:me"), ref("d2", "google-drive:me")]
            )
        )
        await childResult(
            coord,
            "sess-1.sub.b",
            toolCallId: "cb",
            .document(ref: ref("d3", "apple-notes:local"), content: nil, neighbors: [])
        )

        let panels = coord.researchPanels
        XCTAssertEqual(panels.count, 2)
        XCTAssertEqual(panels[0].docs.map(\.documentId), ["d1", "d2"])
        XCTAssertEqual(panels[1].docs.map(\.documentId), ["d3"], "researcher B's docs don't leak A's")
    }

    func testDocsDedupedByDocumentId() async {
        let coord = makeCoordinator()
        await spawn(coord, "sess-1.sub.a", specialist: "history-sweep", task: "A")
        await childResult(
            coord,
            "sess-1.sub.a",
            toolCallId: "c1",
            .searchResults(
                query: "q",
                durationMs: 1,
                candidates: 1,
                results: [ref("dup", "gmail:me"), ref("d2", "gmail:me")]
            )
        )
        await childResult(
            coord,
            "sess-1.sub.a",
            toolCallId: "c2",
            .document(ref: ref("dup", "gmail:me"), content: nil, neighbors: [])
        )
        XCTAssertEqual(
            coord.researchPanels.first?.docs.map(\.documentId),
            ["dup", "d2"],
            "the second occurrence of `dup` is deduped"
        )
    }

    /// A tool result with no matching transcript part (out-of-order delivery)
    /// still feeds the working set — the docs accrue independent of the part.
    func testDocsAccrueEvenWithoutMatchingTranscriptPart() async {
        let coord = makeCoordinator()
        await spawn(coord, "sess-1.sub.a", specialist: "history-sweep", task: "A")
        // A bare result event — no message.start / tool.start preceding it.
        await coord.applyEventForTesting(.subagentEvent(
            sessionId: "sess-1", subagentId: "sess-1.sub.a", specialist: "x",
            event: .toolResult(
                sessionId: "sess-1.sub.a",
                messageId: "m",
                toolCallId: "orphan",
                result: .document(ref: ref("dX", "gmail:me"), content: nil, neighbors: []),
                durationMs: 1
            )
        ))
        XCTAssertEqual(coord.researchPanels.first?.docs.map(\.documentId), ["dX"])
    }

    // MARK: - Gating + collapse

    func testWorkspaceActiveOnlyWithDeepResearchAndAResearcher() async {
        let coord = makeCoordinator()
        // No researcher yet, marker off.
        XCTAssertFalse(coord.isResearchWorkspaceActive)
        coord.setDeepResearchForTesting(true)
        // Marker on but still no panels.
        XCTAssertFalse(coord.isResearchWorkspaceActive)
        await spawn(coord, "sess-1.sub.a", specialist: "history-sweep", task: "A")
        XCTAssertTrue(coord.isResearchWorkspaceActive, "live run + ≥1 researcher")
    }

    func testSpawnedCardActivatesSurfaceEvenWithoutDeepResearchMarker() async {
        // A sub-agent spawn IS the research signal — a replay demo cassette (or
        // an agent that fans out mid-turn) activates the working-set without the
        // slash pill. Still collapses on message.end (see the collapse test).
        let coord = makeCoordinator()
        await spawn(coord, "sess-1.sub.a", specialist: "history-sweep", task: "A")
        XCTAssertFalse(coord.researchPanels.isEmpty)
        XCTAssertTrue(coord.isResearchWorkspaceActive, "a spawn surfaces the workspace")
    }

    func testGenericWorkerStaysInOrdinaryTranscript() async {
        let coord = makeCoordinator()
        await spawn(coord, "sess-1.sub.generic", specialist: "generic", task: "Compare periods")

        XCTAssertFalse(coord.researchPanels.isEmpty, "the ordinary progress card is retained")
        XCTAssertFalse(coord.isResearchWorkspaceActive, "generic fan-out is not Deep Research")
    }

    func testMessageEndCollapsesSurfaceButKeepsCards() async {
        let coord = makeCoordinator()
        coord.setDeepResearchForTesting(true)
        await spawn(coord, "sess-1.sub.a", specialist: "history-sweep", task: "A")
        XCTAssertTrue(coord.isResearchWorkspaceActive)
        await coord.applyEventForTesting(.messageEnd(sessionId: "sess-1", messageId: "msg-1", stopReason: "end_turn"))
        XCTAssertFalse(coord.isResearchWorkspaceActive, "run ended → surface collapses")
        XCTAssertFalse(coord.researchPanels.isEmpty, "the finished cards still live on the transcript")
    }

    func testErrorCollapsesSurface() async {
        let coord = makeCoordinator()
        coord.setDeepResearchForTesting(true)
        await spawn(coord, "sess-1.sub.a", specialist: "history-sweep", task: "A")
        await coord.applyEventForTesting(.error(sessionId: "sess-1", messageId: "msg-1", code: "x", message: "boom", provider: nil))
        XCTAssertFalse(coord.isResearchWorkspaceActive)
    }

    // MARK: - Panel projection fidelity

    func testPanelsProjectCounters() async {
        let coord = makeCoordinator()
        await spawn(coord, "sess-1.sub.a", specialist: "history-sweep", task: "Find docs")
        await childResult(
            coord,
            "sess-1.sub.a",
            toolCallId: "c1",
            .searchResults(
                query: "q",
                durationMs: 1,
                candidates: 1,
                results: [ref("d1", "gmail:me", title: "Hit")]
            )
        )
        await coord.applyEventForTesting(.subagentResult(
            sessionId: "sess-1", subagentId: "sess-1.sub.a", specialist: "history-sweep",
            status: "complete", summary: "done", citations: [],
            usage: AgentUsage(inputTokens: 100, outputTokens: 50), treeUsage: nil
        ))
        let p = coord.researchPanels.first
        XCTAssertEqual(p?.specialist, "history-sweep")
        XCTAssertEqual(p?.task, "Find docs")
        XCTAssertEqual(p?.docs.first?.title, "Hit")
        XCTAssertEqual(p?.stepCount, 1)
        XCTAssertEqual(p?.tokens, 150)
        XCTAssertEqual(p?.status, "complete")
        XCTAssertEqual(p?.summary, "done")
    }
}
